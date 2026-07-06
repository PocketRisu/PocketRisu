'use strict';

/**
 * Backend fetch relay ("fetch jobs").
 *
 * When `useBackendChatJobs` is enabled, the client routes its non-streaming
 * proxied requests (HypaMemory embeddings, memory summarization, translation,
 * and other globalFetch calls) here instead of the pass-through `/proxy2`
 * proxy. The server performs the outbound request and buffers the complete
 * response until the client picks it up, so a webview suspension (screen off,
 * app backgrounded) mid-request no longer kills the outbound call — on resume
 * the client re-polls with the same jobId and receives the stored result.
 *
 * Jobs are idempotent on the client-generated jobId: re-sending `start` after
 * a dropped connection attaches to the existing job instead of firing the
 * upstream request a second time.
 */

const { logger } = require('./logs.cjs');

const JOB_TIMEOUT_MS_DEFAULT = 10 * 60 * 1000;   // 10 minutes, like chat jobs
const JOB_TIMEOUT_MS_MAX = 30 * 60 * 1000;
const JOB_TTL_MS = 60 * 60 * 1000;               // keep results across long screen-off gaps
const GC_INTERVAL_MS = 60 * 1000;
const WAIT_MS_MAX = 30 * 1000;                   // long-poll cap
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_JOBS = 500;

// Response headers that are meaningless (or wrong) after the body has been
// buffered and re-encoded — same set the /proxy2 pass-through strips.
const STRIPPED_RESPONSE_HEADERS = new Set([
    'content-security-policy',
    'content-security-policy-report-only',
    'clear-site-data',
    'cache-control',
    'content-encoding',
    'content-length',
]);

const jobs = new Map();

function now() { return Date.now(); }

function isValidJobId(jobId) {
    return typeof jobId === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(jobId);
}

function snapshotFetchJob(job) {
    return {
        jobId: job.id,
        status: job.status,
        error: job.error,
        response: job.status === 'done' ? job.response : null,
    };
}

// Move a running job to a terminal state and wake all long-poll waiters.
// No-ops if the job already settled (e.g. timeout raced with completion).
function settle(job, status, extra = {}) {
    if (job.status !== 'running') return;
    job.status = status;
    job.updatedAt = now();
    Object.assign(job, extra);
    if (job.timeoutTimer) {
        clearTimeout(job.timeoutTimer);
        job.timeoutTimer = null;
    }
    const waiters = job.waiters;
    job.waiters = new Set();
    for (const resolve of waiters) {
        try { resolve(); } catch { /* ignore */ }
    }
}

function disposeFetchJob(job) {
    if (job.timeoutTimer) clearTimeout(job.timeoutTimer);
    jobs.delete(job.id);
}

async function executeFetchJob(job) {
    const { url, method, headers, body } = job.request;
    const response = await fetch(url, {
        method,
        headers,
        body: (method === 'GET' || method === 'HEAD') ? undefined : body,
        signal: job.abortController.signal,
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_RESPONSE_BYTES) {
        throw new Error(`Relay response too large (${buffer.byteLength} bytes)`);
    }
    const responseHeaders = {};
    for (const [key, value] of response.headers) {
        if (STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
        responseHeaders[key] = value;
    }
    // Upstream error statuses are still a completed relay — the client decides
    // ok-ness from `response.status`, mirroring the /proxy2 behavior.
    job.response = {
        status: response.status,
        headers: responseHeaders,
        bodyB64: buffer.toString('base64'),
    };
}

/**
 * Starts a relay job, or returns the existing one for the same jobId.
 * Returns a snapshot; throws on invalid input or when the store is full.
 */
function startFetchJob(request) {
    const jobId = request?.jobId;
    if (!isValidJobId(jobId)) {
        throw new Error('Invalid jobId');
    }
    const existing = jobs.get(jobId);
    if (existing) {
        existing.updatedAt = now();
        return snapshotFetchJob(existing);
    }
    if (typeof request.url !== 'string' || !request.url) {
        throw new Error('Invalid url');
    }
    gcFetchJobs();
    if (jobs.size >= MAX_JOBS) {
        throw new Error('Too many relay jobs');
    }

    const requestedTimeout = Number(request.timeoutMs);
    const timeoutMs = Math.min(
        (Number.isFinite(requestedTimeout) && requestedTimeout > 0) ? Math.max(requestedTimeout, 1000) : JOB_TIMEOUT_MS_DEFAULT,
        JOB_TIMEOUT_MS_MAX
    );

    const job = {
        id: jobId,
        createdAt: now(),
        updatedAt: now(),
        status: 'running',
        error: null,
        response: null,
        request: {
            url: request.url,
            method: request.method === 'GET' ? 'GET' : 'POST',
            headers: (request.headers && typeof request.headers === 'object') ? request.headers : {},
            body: typeof request.body === 'string' ? request.body : undefined,
        },
        abortController: new AbortController(),
        timeoutTimer: null,
        waiters: new Set(),
    };
    job.timeoutTimer = setTimeout(() => {
        settle(job, 'error', { error: `Relay request timed out after ${timeoutMs}ms` });
        try { job.abortController.abort(); } catch { /* ignore */ }
    }, timeoutMs);
    jobs.set(jobId, job);

    executeFetchJob(job)
        .then(() => settle(job, 'done'))
        .catch((err) => {
            const message = err?.message || `${err}`;
            if (job.status === 'running') {
                logger.error(`[FetchJob] ${job.request.method} ${job.request.url}`, err);
            }
            settle(job, 'error', { error: message });
        });

    return snapshotFetchJob(job);
}

/**
 * Returns a job snapshot, long-polling up to waitMs while it is running.
 * Returns null when the job does not exist.
 */
async function waitFetchJob(jobId, waitMs) {
    const job = jobs.get(jobId);
    if (!job) return null;
    if (job.status === 'running') {
        const wait = Math.min(Math.max(Number(waitMs) || 0, 0), WAIT_MS_MAX);
        if (wait > 0) {
            await new Promise((resolve) => {
                const waiter = () => { clearTimeout(timer); resolve(); };
                const timer = setTimeout(() => {
                    job.waiters.delete(waiter);
                    resolve();
                }, wait);
                job.waiters.add(waiter);
            });
        }
    }
    const current = jobs.get(jobId);
    if (!current) return null;
    // Active polling keeps the job alive; TTL only reaps abandoned jobs.
    current.updatedAt = now();
    return snapshotFetchJob(current);
}

/** Deletes a finished job after the client consumed the result. */
function ackFetchJob(jobId) {
    const job = jobs.get(jobId);
    if (!job) return false;
    if (job.status === 'running') return false;
    disposeFetchJob(job);
    return true;
}

/** Aborts a job (user cancelled the generation) and drops it. */
function cancelFetchJob(jobId) {
    const job = jobs.get(jobId);
    if (!job) return false;
    settle(job, 'cancelled', { error: 'Cancelled by client' });
    try { job.abortController.abort(); } catch { /* ignore */ }
    disposeFetchJob(job);
    return true;
}

function gcFetchJobs() {
    const cutoff = now() - JOB_TTL_MS;
    for (const job of [...jobs.values()]) {
        if (job.updatedAt >= cutoff) continue;
        if (job.status === 'running') {
            settle(job, 'error', { error: 'Relay job expired' });
            try { job.abortController.abort(); } catch { /* ignore */ }
        }
        disposeFetchJob(job);
    }
}

const gcTimer = setInterval(gcFetchJobs, GC_INTERVAL_MS);
if (typeof gcTimer.unref === 'function') gcTimer.unref();

module.exports = {
    startFetchJob,
    waitFetchJob,
    ackFetchJob,
    cancelFetchJob,
    gcFetchJobs,
};

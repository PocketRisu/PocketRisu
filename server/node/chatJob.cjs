'use strict';

/**
 * Backend chat job system (MVP).
 *
 * Runs AI provider requests on the server so that generation continues even when
 * the client disconnects (screen off, browser background, network drop). Results
 * are stored in the same SQLite DB the client syncs from, so reopening the app
 * loads the completed message.
 *
 * Scope: OpenAI-compatible chat completions (streaming and non-streaming).
 */

const nodeCrypto = require('crypto');
const { logger } = require('./logs.cjs');
const { kvGet, kvSet, kvDel, kvList } = require('./db.cjs');
const { runMultiagentPipeline } = require('./multiagent.cjs');
const { runHypaMemoryPipeline, spliceMemoryText } = require('./hypaMemoryCore.cjs');

// ─── Configuration ──────────────────────────────────────────────────────────
const JOB_TIMEOUT_MS = 10 * 60 * 1000;          // 10 minutes
const JOB_GC_INTERVAL_MS = 60 * 1000;           // 1 minute
const PARTIAL_FLUSH_INTERVAL_MS = 2000;         // 2 seconds
const RESULT_TTL_MS = 24 * 60 * 60 * 1000;      // 24 hours
const MAX_PENDING_EVENTS = 512;

// ─── In-memory job store ────────────────────────────────────────────────────
const jobs = new Map();

// ─── Types ──────────────────────────────────────────────────────────────────
// job.status: 'pending' | 'running' | 'done' | 'error' | 'cancelled'

function now() { return Date.now(); }

function createJob(record) {
    const job = {
        id: nodeCrypto.randomUUID(),
        createdAt: now(),
        updatedAt: now(),
        status: 'pending',
        error: null,
        text: '',
        finishReason: null,
        usage: null,
        abortController: new AbortController(),
        timeoutTimer: null,
        flushTimer: null,
        pendingEvents: [],
        pendingBytes: 0,
        subscribers: new Set(),
        resultPersisted: false,
        ...record,
    };
    jobs.set(job.id, job);
    return job;
}

function snapshotJob(job) {
    return {
        jobId: job.id,
        status: job.status,
        text: job.text,
        error: job.error,
        finishReason: job.finishReason,
        usage: job.usage,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        target: job.target,
        // Updated HypaV3 memory data produced by the server-side memory
        // pipeline; the client persists it into the chat on pickup/recovery.
        updatedMemory: job.updatedMemory ?? null,
    };
}

function pushEvent(job, event) {
    job.updatedAt = now();
    const text = JSON.stringify(event);
    job.pendingEvents.push(text);
    job.pendingBytes += Buffer.byteLength(text);
    while (
        job.pendingEvents.length > MAX_PENDING_EVENTS ||
        job.pendingBytes > 2 * 1024 * 1024
    ) {
        const removed = job.pendingEvents.shift();
        if (!removed) break;
        job.pendingBytes -= Buffer.byteLength(removed);
    }
    for (const subscriber of job.subscribers) {
        try { subscriber(text); } catch { /* ignore */ }
    }
}

function setJobStatus(job, status, extra = {}) {
    job.status = status;
    job.updatedAt = now();
    Object.assign(job, extra);
    pushEvent(job, { type: 'status', status, ...extra });
}

function resultKey(job) {
    const t = job.target;
    if (!t) return null;
    return `chat_job_result/${t.chaId}/${t.chatId}/${t.messageIndex}`;
}

function persistResult(job) {
    const key = resultKey(job);
    if (!key) return;
    try {
        kvSet(key, Buffer.from(JSON.stringify(snapshotJob(job))));
        job.resultPersisted = true;
    } catch (err) {
        logger.error('[ChatJob] Failed to persist result:', err);
    }
}

function persistPartial(job) {
    const key = resultKey(job);
    if (!key) return;
    try {
        kvSet(key, Buffer.from(JSON.stringify(snapshotJob(job))));
    } catch (err) {
        logger.error('[ChatJob] Failed to persist partial:', err);
    }
}

function cleanupJob(job) {
    if (job.timeoutTimer) clearTimeout(job.timeoutTimer);
    if (job.flushTimer) clearInterval(job.flushTimer);
    try { job.abortController.abort(); } catch { /* ignore */ }
    job.subscribers.clear();
    jobs.delete(job.id);
}

function subscribeToJob(jobId, callback) {
    const job = jobs.get(jobId);
    if (!job) return null;
    job.subscribers.add(callback);

    // A reconnect only needs the current snapshot. Replaying every buffered
    // cumulative chunk makes the browser repeatedly repaint the whole answer.
    try {
        callback(JSON.stringify({
            type: 'chunk',
            text: job.text,
            finishReason: job.finishReason,
        }));
        callback(JSON.stringify({
            type: 'status',
            status: job.status,
            error: job.error,
            finishReason: job.finishReason,
        }));
    } catch { /* ignore */ }

    job.pendingEvents = [];
    job.pendingBytes = 0;
    return () => {
        const current = jobs.get(jobId);
        if (current) current.subscribers.delete(callback);
    };
}

// ─── OpenAI-compatible SSE parser ───────────────────────────────────────────
function appendOpenAIChunk(text, chunk) {
    // chunk is one or more SSE data lines
    let lines = chunk.split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') return text;
        try {
            const json = JSON.parse(data);
            const delta = json.choices?.[0]?.delta;
            if (delta) {
                if (delta.content) text += delta.content;
                if (delta.reasoning_content) text += `<Thoughts>\n${delta.reasoning_content}\n</Thoughts>\n`;
            }
        } catch {
            // ignore malformed JSON
        }
    }
    return text;
}

function finishReasonFromChunk(chunk) {
    let lines = chunk.split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') return 'stop';
        try {
            const json = JSON.parse(data);
            const reason = json.choices?.[0]?.finish_reason;
            if (reason) return reason;
        } catch { /* ignore */ }
    }
    return null;
}

// ─── Provider execution ─────────────────────────────────────────────────────
async function executeProvider(job) {
    const { url, headers, body } = job.descriptor;
    const isStream = body.stream === true;

    const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: job.abortController.signal,
    });

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
    }

    if (isStream) {
        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('text/event-stream')) {
            const text = await response.text().catch(() => '');
            throw new Error(`Expected SSE, got ${contentType}: ${text.slice(0, 500)}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
            while (job.status === 'running') {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value, { stream: true });
                buffer += chunk;

                // SSE events are separated by blank lines. Process complete ones.
                let splitIdx;
                while ((splitIdx = buffer.indexOf('\n\n')) !== -1) {
                    const event = buffer.slice(0, splitIdx);
                    buffer = buffer.slice(splitIdx + 2);

                    const oldText = job.text;
                    job.text = appendOpenAIChunk(job.text, event);
                    const reason = finishReasonFromChunk(event);
                    if (reason) job.finishReason = reason;
                    if (job.text !== oldText || reason) {
                        pushEvent(job, { type: 'chunk', text: job.text, finishReason: job.finishReason });
                    }
                }
            }
        } finally {
            try { reader.releaseLock(); } catch { /* ignore */ }
        }
    } else {
        const json = await response.json();
        const choice = json.choices?.[0];
        const msg = choice?.message;
        let text = msg?.content ?? choice?.text ?? '';
        const reasoning = msg?.reasoning_content ?? json.choices?.[0]?.reasoning_content;
        if (reasoning) text = `<Thoughts>\n${reasoning}\n</Thoughts>\n${text}`;
        job.text = text;
        job.finishReason = choice?.finish_reason ?? 'stop';
        job.usage = json.usage ?? null;
        pushEvent(job, { type: 'chunk', text: job.text, finishReason: job.finishReason });
    }
}

// ─── Job runner ─────────────────────────────────────────────────────────────
async function runJob(job) {
    setJobStatus(job, 'running');
    // Make the job discoverable immediately after a refresh instead of waiting
    // for the first periodic partial flush.
    persistPartial(job);

    job.timeoutTimer = setTimeout(() => {
        setJobStatus(job, 'error', { error: 'Job timed out' });
        try { job.abortController.abort(); } catch { /* ignore */ }
    }, JOB_TIMEOUT_MS);

    job.flushTimer = setInterval(() => {
        if (job.status === 'running') {
            persistPartial(job);
        }
    }, PARTIAL_FLUSH_INTERVAL_MS);

    try {
        // Server-side HypaV3 memory pipeline: summarization + embedding +
        // memory-prompt assembly run here, before the main generation, so the
        // whole turn is server-owned the moment the job starts. Memory failure
        // fails the job — generating without memory would silently lose
        // context, matching the client-side pipeline which aborts on error.
        const mem = job.descriptor.memory;
        if (mem) {
            logger.info(`[ChatJob] Running memory pipeline for job ${job.id}: ${Array.isArray(mem.summarizationTasks) ? mem.summarizationTasks.length : 0} summarization task(s)`);
            pushEvent(job, { type: 'phase', phase: 'memory' });
            const onMemoryProgress = (ev) => {
                try { pushEvent(job, { type: 'memory-progress', ...ev }); } catch { /* ignore */ }
            };
            const memoryResult = await runHypaMemoryPipeline(mem, {
                signal: job.abortController.signal,
                onProgress: onMemoryProgress,
            });
            spliceMemoryText(job.descriptor.body, mem.placeholder, memoryResult.memoryText);
            job.updatedMemory = memoryResult.updatedMemory;
            // Live clients persist the updated memory immediately; suspended
            // ones get it from the snapshot on reconnect/recovery.
            pushEvent(job, { type: 'memory-data', data: memoryResult.updatedMemory });
            logger.info(`[ChatJob] Memory pipeline finished for job ${job.id}`);
        }

        const ma = job.descriptor.multiagent;
        const msgs = job.descriptor.body?.messages;
        const hasApiKey = Boolean(ma?.apiKey);
        const enabledAgents = ma?.agents
            ? Object.entries(ma.agents).filter(([, v]) => v?.enabled !== false).map(([k]) => k)
            : [];
        logger.info(`[ChatJob] Job ${job.id} multiagent check: descriptor.multiagent=${Boolean(ma)} hasApiKey=${hasApiKey} provider=${ma?.provider || 'n/a'} model=${ma?.model || 'n/a'} enabledAgents=[${enabledAgents.join(',')}] messagesArray=${Array.isArray(msgs)} messageCount=${Array.isArray(msgs) ? msgs.length : 'n/a'}`);
        if (ma && Array.isArray(msgs)) {
            const strictMode = Boolean(ma.strictMode);
            logger.info(`[ChatJob] Running multiagent pipeline (strictMode=${strictMode}) for job ${job.id}`);
            // Phase hint for the client request-status indicator: the MultiAgent
            // pipeline runs server-side before main generation, so the browser
            // sees no chunks during it. This lets the toast show "MultiAgent".
            pushEvent(job, { type: 'phase', phase: 'multiagent' });
            // Forward per-agent progress to the client status indicator.
            const onAgentProgress = (ev) => {
                try { pushEvent(job, { type: 'agent', ...ev }); } catch { /* ignore */ }
            };
            try {
                job.descriptor.body.messages = await runMultiagentPipeline(ma, msgs, onAgentProgress);
                logger.info(`[ChatJob] Multiagent pipeline finished for job ${job.id}`);
            } catch (maErr) {
                logger.error('[ChatJob] Multiagent pipeline error:', maErr);
                if (strictMode) throw maErr;
            }
        } else if (ma) {
            logger.warn(`[ChatJob] Multiagent config present but body.messages is not an array — skipping pipeline for job ${job.id}`);
        }
        // Phase hint: main prompt generation is starting.
        pushEvent(job, { type: 'phase', phase: 'main' });
        await executeProvider(job);
        if (job.status === 'cancelled') {
            persistResult(job);
        } else {
            setJobStatus(job, 'done', { finishReason: job.finishReason || 'stop' });
            persistResult(job);
        }
    } catch (error) {
        if (job.status === 'cancelled' || job.abortController.signal.aborted) {
            setJobStatus(job, 'cancelled');
            persistResult(job);
        } else {
            const message = error?.message || `${error}`;
            setJobStatus(job, 'error', { error: message });
            persistResult(job);
        }
    } finally {
        if (job.timeoutTimer) clearTimeout(job.timeoutTimer);
        if (job.flushTimer) clearInterval(job.flushTimer);
    }
}

// ─── Public API ─────────────────────────────────────────────────────────────
function startChatJob(descriptor, target) {
    if (!descriptor || !descriptor.url || !descriptor.body) {
        throw new Error('Invalid chat job descriptor');
    }
    const job = createJob({ descriptor, target });
    // Run detached; errors are captured on the job object.
    runJob(job).catch((err) => {
        logger.error('[ChatJob] Unhandled runJob error:', err);
        try { setJobStatus(job, 'error', { error: `${err}` }); } catch { /* ignore */ }
    });
    return job.id;
}

function getChatJob(jobId) {
    const job = jobs.get(jobId);
    if (!job) return null;
    return {
        id: job.id,
        status: job.status,
        text: job.text,
        error: job.error,
        finishReason: job.finishReason,
        usage: job.usage,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        target: job.target,
        updatedMemory: job.updatedMemory ?? null,
    };
}

function consumeChatJobEvents(jobId) {
    const job = jobs.get(jobId);
    if (!job) return null;
    const events = job.pendingEvents;
    job.pendingEvents = [];
    job.pendingBytes = 0;
    return events;
}

function cancelChatJob(jobId) {
    const job = jobs.get(jobId);
    if (!job) return false;
    setJobStatus(job, 'cancelled');
    try { job.abortController.abort(); } catch { /* ignore */ }
    persistResult(job);
    return true;
}

function getPersistedResult(target) {
    const key = `chat_job_result/${target.chaId}/${target.chatId}/${target.messageIndex}`;
    const raw = kvGet(key);
    if (!raw) return null;
    try {
        return JSON.parse(raw.toString('utf-8'));
    } catch {
        return null;
    }
}

function listPersistedResults(chaId, chatId) {
    const prefix = `chat_job_result/${chaId}/${chatId}/`;
    const byMessageIndex = new Map();

    for (const key of kvList(prefix)) {
        const raw = kvGet(key);
        if (!raw) continue;
        try {
            const parsed = JSON.parse(raw.toString('utf-8'));
            if (parsed && parsed.status) {
                byMessageIndex.set(parsed.target?.messageIndex, parsed);
            }
        } catch { /* ignore */ }
    }

    // Include the live in-memory record so a refreshed client can reconnect even
    // before the periodic SQLite partial flush runs.
    for (const job of jobs.values()) {
        const target = job.target;
        if (target?.chaId !== chaId || target?.chatId !== chatId) continue;
        byMessageIndex.set(target.messageIndex, snapshotJob(job));
    }

    return [...byMessageIndex.values()]
        .sort((a, b) => (a.target?.messageIndex ?? 0) - (b.target?.messageIndex ?? 0));
}

function acknowledgeResult(target) {
    const key = `chat_job_result/${target.chaId}/${target.chatId}/${target.messageIndex}`;
    kvDel(key);
}

// ─── GC: clean up old completed jobs and stale persisted results ─────────────
function runGc() {
    const cutoff = now() - RESULT_TTL_MS;
    for (const [id, job] of jobs) {
        if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
            if (job.updatedAt < cutoff) {
                cleanupJob(job);
            }
        }
    }
}

setInterval(runGc, JOB_GC_INTERVAL_MS);

module.exports = {
    startChatJob,
    getChatJob,
    consumeChatJobEvents,
    subscribeToJob,
    cancelChatJob,
    getPersistedResult,
    listPersistedResults,
    acknowledgeResult,
};

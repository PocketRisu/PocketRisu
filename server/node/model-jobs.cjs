'use strict';

// Model jobs: durable server-side relay for model-preset LLM requests.
// The server is a RECORDER — it makes the upstream HTTP request, streams the
// response bytes to the client unchanged, and appends the same bytes to an
// append-only on-disk journal. It never parses SSE/JSON response content;
// interpretation always happens in the client's existing parsers. A client
// that disconnects mid-generation can later replay the journal from byte 0
// (+ live tail while the job is still running) to recover the response.
// See .agent/notes/model-preset-server-side-requests.md (v2 design).

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const https = require('https');
const nodeCrypto = require('crypto');
const { setTimeout: sleep } = require('timers/promises');
const { once } = require('events');
const { normalizeForwardHeaders } = require('./utils.cjs');

const MODEL_JOB_DEFAULT_TIMEOUT_MS = 600000;
const MODEL_JOB_MAX_TIMEOUT_MS = 3600000;
// Fallback wake-up for tail readers; normally the per-job notify list wakes
// them immediately after each journal write, so this only guards edge races.
const MODEL_JOB_TAIL_FALLBACK_MS = 1000;
const MODEL_JOB_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const MODEL_JOB_MAX_RETAINED_TERMINAL = 50;
const MODEL_JOB_MAX_RETAINED_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const TERMINAL_STATUSES = ['done', 'failed', 'aborted'];

function normalizeTimeoutMs(timeoutMs) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return MODEL_JOB_DEFAULT_TIMEOUT_MS;
    }
    return Math.min(MODEL_JOB_MAX_TIMEOUT_MS, Math.max(1, Math.floor(timeoutMs)));
}

// Shared strip-list from utils.cjs normalizeForwardHeaders (risu-auth and
// hop-by-hop headers), plus two model-job extras: keys are lowercased BEFORE
// stripping (so e.g. `Risu-Auth` cannot slip past the lowercase strip-set),
// and `accept-encoding: identity` is forced so upstream sends plain bytes —
// the journal must be replayable without a decompression step, and the
// recorder never transforms what it records.
function normalizeUpstreamHeaders(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        input = {};
    }
    const lowered = {};
    for (const [key, value] of Object.entries(input)) {
        if (typeof key !== 'string') continue;
        if (typeof value === 'string') {
            lowered[key.toLowerCase()] = value;
        }
    }
    const normalized = normalizeForwardHeaders(lowered);
    normalized['accept-encoding'] = 'identity';
    return normalized;
}

// Native http/https request with abort support — mirrors the approach of
// requestLocalTargetStream in server.cjs (native client so the body arrives
// as raw bytes, no implicit decompression like Node's fetch).
function requestUpstreamStream(targetUrl, arg) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(targetUrl);
        const client = parsedUrl.protocol === 'https:' ? https : http;
        const headers = { ...arg.headers };
        if (!headers['host']) {
            headers['host'] = parsedUrl.host;
        }
        if (arg.bodyBuffer) {
            headers['content-length'] = String(arg.bodyBuffer.length);
        }

        let settled = false;
        let upstreamRes = null;
        const finishReject = (error) => {
            if (settled) return;
            settled = true;
            reject(error);
        };

        const req = client.request(parsedUrl, {
            method: arg.method,
            headers
        }, (res) => {
            if (settled) {
                res.destroy();
                return;
            }
            settled = true;
            upstreamRes = res;
            resolve({
                status: res.statusCode || 502,
                headers: res.headers,
                body: res
            });
        });

        req.on('error', (error) => {
            finishReject(error);
        });

        req.setTimeout(arg.timeoutMs, () => {
            req.destroy(new Error(`Upstream request timed out after ${arg.timeoutMs}ms`));
        });

        if (arg.signal) {
            // Stays registered for the whole request lifetime (not removed at
            // header time) so an abort also tears down a mid-stream body. The
            // signal's own lifetime is the job's, so no listener leak.
            const onAbort = () => {
                const abortError = new Error('Model job aborted');
                abortError.name = 'AbortError';
                if (upstreamRes) upstreamRes.destroy(abortError);
                req.destroy(abortError);
            };
            if (arg.signal.aborted) {
                onAbort();
                return;
            }
            arg.signal.addEventListener('abort', onAbort, { once: true });
        }

        if (arg.bodyBuffer) {
            req.write(arg.bodyBuffer);
        }
        req.end();
    });
}

// Factory bound to a save directory. server.cjs wires the real save/ path;
// tests wire a temp dir. Metadata lives in its own SQLite file
// (save/model-jobs.db) rather than logs.db — the logs module opens its DB at
// module load against process.cwd(), and job metadata has a different
// lifecycle (rotation by job, not by row count), so a dedicated file keeps
// the two domains independent and testable.
function createModelJobs(opts = {}) {
    const saveDir = opts.saveDir || path.join(process.cwd(), 'save');
    const journalDir = path.join(saveDir, 'model-jobs');
    fs.mkdirSync(journalDir, { recursive: true });

    const db = new Database(path.join(saveDir, 'model-jobs.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');

    // SECURITY: no target URL, no request headers, no request body in this
    // schema — auth material lives only in memory for the lifetime of the
    // upstream request. Only non-sensitive job metadata is persisted.
    //
    // `kind`: 'main' = a chat generation. Its journal decodes to a chat message,
    // so it participates in boot recovery and the per-chat single-job guard.
    // 'aux' = a pipeline side request (translate / memory summarization / …)
    // riding the job transport ONLY for its reconnectable stream: relay-only,
    // excluded from recovery lists (its journal is NOT a chat message) and from
    // the per-chat guard (aux runs sequentially within a send anyway).
    db.exec(`
        CREATE TABLE IF NOT EXISTS model_jobs (
            id TEXT PRIMARY KEY,
            chat_id TEXT NOT NULL,
            generation_id TEXT,
            adapter_kind TEXT,
            model TEXT,
            model_label TEXT,
            target_origin TEXT,
            kind TEXT NOT NULL DEFAULT 'main',
            streaming INTEGER NOT NULL DEFAULT 0,
            input_tokens INTEGER,
            output_tokens INTEGER,
            max_context INTEGER,
            status TEXT NOT NULL,
            upstream_status INTEGER,
            content_type TEXT,
            error TEXT,
            created_at INTEGER NOT NULL,
            ended_at INTEGER,
            bytes INTEGER NOT NULL DEFAULT 0,
            claimed INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_model_jobs_chat ON model_jobs(chat_id, status);
    `);
    // Pre-`kind` databases (feature-branch builds only; never shipped): add the
    // column in place. Errors mean it already exists.
    try {
        db.exec(`ALTER TABLE model_jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'main'`);
    } catch { /* column already present */ }
    // Added for request-log parity on recovered jobs. `target_origin` is
    // origin+pathname ONLY — the query string is dropped because that is where
    // Gemini and query-auth profiles carry the API key, so the SECURITY rule
    // above (no credentials at rest) still holds.
    try {
        db.exec(`ALTER TABLE model_jobs ADD COLUMN model TEXT`);
    } catch { /* column already present */ }
    try {
        db.exec(`ALTER TABLE model_jobs ADD COLUMN target_origin TEXT`);
    } catch { /* column already present */ }
    try {
        db.exec(`ALTER TABLE model_jobs ADD COLUMN model_label TEXT`);
    } catch { /* column already present */ }
    try {
        db.exec(`ALTER TABLE model_jobs ADD COLUMN input_tokens INTEGER`);
    } catch { /* column already present */ }
    try {
        db.exec(`ALTER TABLE model_jobs ADD COLUMN output_tokens INTEGER`);
    } catch { /* column already present */ }
    try {
        db.exec(`ALTER TABLE model_jobs ADD COLUMN max_context INTEGER`);
    } catch { /* column already present */ }

    // Resumable sends: one tombstone per chat marking "a send was started here
    // and has not concluded". Holds NO pipeline state — the send's durable
    // ingredients live elsewhere (user message in chat data, hypa partials in
    // hypaV3Data, the main response in the job journal). A returning client
    // lists these, applies its idempotency checks, and re-runs the send when
    // the response truly never made it. See the design note §C.
    db.exec(`
        CREATE TABLE IF NOT EXISTS pending_sends (
            chat_id TEXT PRIMARY KEY,
            generation_id TEXT,
            created_at INTEGER NOT NULL
        );
    `);

    const stmtInsert = db.prepare(`
        INSERT INTO model_jobs (id, chat_id, generation_id, adapter_kind, model, model_label, target_origin, kind, streaming, input_tokens, output_tokens, max_context, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)
    `);
    const stmtGet = db.prepare(`SELECT * FROM model_jobs WHERE id = ?`);
    const stmtRunningForChat = db.prepare(`SELECT id, generation_id FROM model_jobs WHERE chat_id = ? AND status = 'running' AND kind = 'main' LIMIT 1`);
    const stmtSetUpstream = db.prepare(`UPDATE model_jobs SET upstream_status = ?, content_type = ? WHERE id = ?`);
    const stmtFinalize = db.prepare(`UPDATE model_jobs SET status = ?, error = ?, ended_at = ?, bytes = ? WHERE id = ?`);
    const stmtClaim = db.prepare(`UPDATE model_jobs SET claimed = 1 WHERE id = ?`);
    const stmtDelete = db.prepare(`DELETE FROM model_jobs WHERE id = ?`);
    // Recovery views are MAIN-only: an aux journal is not a chat message, so
    // recovering it would insert garbage into a chat (the failure mode the
    // Gemini-cache fetch split fixed — see the design note §8-2).
    const stmtListActive = db.prepare(`SELECT * FROM model_jobs WHERE status = 'running' AND kind = 'main' ORDER BY created_at DESC`);
    // Oldest first: recovery appends each job's message to the chat in the order
    // returned, so newest-first would insert a later reply above an earlier one
    // when more than one unclaimed job piled up for the same chat.
    const stmtListUnclaimed = db.prepare(`
        SELECT * FROM model_jobs WHERE status IN ('done', 'failed') AND claimed = 0 AND kind = 'main' ORDER BY created_at ASC
    `);
    const stmtMarkRunningFailed = db.prepare(`
        UPDATE model_jobs SET status = 'failed', error = ?, ended_at = ? WHERE status = 'running'
    `);
    // Rotation candidates: terminal jobs beyond the retention cap. Keep order
    // is unclaimed-MAIN-first then newest, so OFFSET skips the keepers and
    // returns the eviction set — aux jobs, claimed jobs and the oldest go
    // first. (An unclaimed aux job — client died mid-request — is worthless:
    // nothing ever recovers it, so it must not crowd out unrecovered mains.)
    const stmtTerminalOverflow = db.prepare(`
        SELECT id FROM model_jobs WHERE status IN ('done', 'failed', 'aborted')
        ORDER BY (CASE WHEN claimed = 0 AND kind = 'main' THEN 0 ELSE 1 END) ASC, ended_at DESC
        LIMIT -1 OFFSET ?
    `);
    // Age expiry only spares unclaimed MAIN rows — a response no client has
    // recovered yet (e.g. offline for a week) is kept until the overflow cap
    // evicts it. Claimed rows and aux jobs expire by age.
    const stmtTerminalExpired = db.prepare(`
        SELECT id FROM model_jobs WHERE status IN ('done', 'failed', 'aborted') AND (claimed = 1 OR kind = 'aux') AND ended_at < ?
    `);
    const stmtPendingUpsert = db.prepare(`
        INSERT INTO pending_sends (chat_id, generation_id, created_at) VALUES (?, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET generation_id = excluded.generation_id, created_at = excluded.created_at
    `);
    const stmtPendingDelete = db.prepare(`DELETE FROM pending_sends WHERE chat_id = ?`);
    const stmtPendingList = db.prepare(`SELECT * FROM pending_sends ORDER BY created_at ASC`);
    // A pending send this old is noise (the one-shot resume window has long
    // passed); swept by the same out-of-band cleanup timer as terminal jobs.
    const stmtPendingExpired = db.prepare(`DELETE FROM pending_sends WHERE created_at < ?`);
    const PENDING_SEND_MAX_AGE_MS = 48 * 60 * 60 * 1000;

    // In-memory state for running jobs: abort controller + live byte counter
    // (the DB `bytes` column is only finalized at job end) + a notify list of
    // waiting tail readers. Keyed by job id.
    const activeJobs = new Map();

    // Wake every tail reader waiting on this job (new journal bytes, or the
    // job went terminal). Same-process signaling — no polling on the hot path.
    function notifyJobWaiters(job) {
        const waiters = job.waiters;
        job.waiters = [];
        for (const wake of waiters) wake();
    }

    // Resolves when the job emits (write/terminal) or after a fallback timeout.
    // If the job is already gone (terminal), resolves immediately.
    function waitForJobEvent(jobId, timeoutMs = MODEL_JOB_TAIL_FALLBACK_MS) {
        const job = activeJobs.get(jobId);
        if (!job) return Promise.resolve();
        return new Promise((resolve) => {
            const wake = () => {
                clearTimeout(timer);
                resolve();
            };
            const timer = setTimeout(() => {
                const idx = job.waiters.indexOf(wake);
                if (idx !== -1) job.waiters.splice(idx, 1);
                resolve();
            }, timeoutMs);
            job.waiters.push(wake);
            // The job may have gone terminal between the get() above and the
            // push — its final notify would have missed us, so re-check.
            if (!activeJobs.has(jobId)) notifyJobWaiters(job);
        });
    }

    function journalPath(jobId) {
        return path.join(journalDir, `${jobId}.journal`);
    }

    function rowToJson(row, active) {
        return {
            id: row.id,
            chatId: row.chat_id,
            generationId: row.generation_id,
            adapterKind: row.adapter_kind,
            model: row.model ?? undefined,
            modelLabel: row.model_label ?? undefined,
            targetOrigin: row.target_origin ?? undefined,
            kind: row.kind,
            streaming: !!row.streaming,
            status: row.status,
            upstreamStatus: row.upstream_status,
            contentType: row.content_type,
            error: row.error ?? undefined,
            createdAt: row.created_at,
            endedAt: row.ended_at ?? undefined,
            bytes: active ? active.bytesWritten : row.bytes,
            inputTokens: row.input_tokens ?? undefined,
            outputTokens: row.output_tokens ?? undefined,
            maxContext: row.max_context ?? undefined,
            claimed: !!row.claimed
        };
    }

    function getJob(jobId) {
        const row = stmtGet.get(jobId);
        if (!row) return null;
        return rowToJson(row, activeJobs.get(jobId));
    }

    // Only the two recovery views exist — there is no list-all (no client needs
    // it, and it would enumerate every retained job).
    function listJobs(filter) {
        if (filter !== 'active' && filter !== 'unclaimed') {
            return null;
        }
        const rows = filter === 'active' ? stmtListActive.all() : stmtListUnclaimed.all();
        return rows.map((row) => rowToJson(row, activeJobs.get(row.id)));
    }

    function deleteJobFiles(jobId) {
        try { fs.unlinkSync(journalPath(jobId)); } catch { /* already gone */ }
    }

    function cleanupTerminalJobs() {
        const expired = stmtTerminalExpired.all(Date.now() - MODEL_JOB_MAX_RETAINED_AGE_MS);
        const overflow = stmtTerminalOverflow.all(MODEL_JOB_MAX_RETAINED_TERMINAL);
        const ids = new Set([...expired, ...overflow].map((r) => r.id));
        for (const id of ids) {
            stmtDelete.run(id);
            deleteJobFiles(id);
        }
        stmtPendingExpired.run(Date.now() - PENDING_SEND_MAX_AGE_MS);
    }

    // --- pending sends ------------------------------------------------------

    function registerPendingSend(arg) {
        const chatId = typeof arg?.chatId === 'string' ? arg.chatId : '';
        if (!chatId) return { error: 'chatId is required', httpStatus: 400 };
        stmtPendingUpsert.run(
            chatId,
            typeof arg.generationId === 'string' ? arg.generationId : null,
            Date.now()
        );
        return { success: true };
    }

    function clearPendingSend(chatId) {
        stmtPendingDelete.run(chatId);
        return { success: true };
    }

    // Atomic take: delete-and-report in one statement, so among concurrent
    // claimers exactly one sees claimed=true — the cross-device at-most-once
    // guarantee for resuming an interrupted send.
    function claimPendingSend(chatId) {
        const info = stmtPendingDelete.run(chatId);
        return { claimed: info.changes > 0 };
    }

    function listPendingSends() {
        return stmtPendingList.all().map((row) => ({
            chatId: row.chat_id,
            generationId: row.generation_id,
            createdAt: row.created_at,
        }));
    }

    // Server restart: upstream connections cannot be resumed, so any job that
    // was 'running' when the process died is failed on boot. (Auth headers
    // were memory-only by design, so a restart also loses them — correct.)
    function markRunningJobsFailed(reason = 'server restart') {
        stmtMarkRunningFailed.run(reason, Date.now());
    }

    // Upstream consume loop. Journal writes go through a buffered write stream
    // so upstream reads are not serialized on disk latency; `bytesWritten`
    // counts bytes handed to the stream (readers read the FILE and stop at its
    // real EOF, so the counter is display-only). Status flips to terminal only
    // AFTER end() has fully flushed and closed the file — readers that observe
    // a terminal status at EOF know the file is complete (they still do one
    // more read pass, see stream()).
    async function runJob(job, arg) {
        const ws = fs.createWriteStream(journalPath(job.id), { flags: 'a' });
        let writeError = null;
        ws.on('error', (err) => { writeError = writeError || err; });
        let error = null;
        try {
            const upstream = await requestUpstreamStream(arg.targetUrl, {
                method: arg.method,
                headers: arg.headers,
                bodyBuffer: arg.bodyBuffer,
                timeoutMs: arg.timeoutMs,
                signal: job.controller.signal
            });
            const contentType = upstream.headers['content-type'] || null;
            stmtSetUpstream.run(upstream.status, contentType, job.id);
            for await (const chunk of upstream.body) {
                if (job.controller.signal.aborted) break;
                if (!chunk || chunk.length === 0) continue;
                if (writeError) throw writeError;
                const ok = ws.write(chunk);
                job.bytesWritten += chunk.length;
                notifyJobWaiters(job);
                if (!ok) await once(ws, 'drain');
            }
            if (writeError) throw writeError;
            if (job.controller.signal.aborted) {
                const abortError = new Error('Model job aborted');
                abortError.name = 'AbortError';
                throw abortError;
            }
        } catch (err) {
            error = err;
        } finally {
            // Flush + close before flipping status terminal; resolve even if
            // the stream already errored/destroyed (end() still calls back).
            await new Promise((resolve) => ws.end(resolve));
            if (!error && writeError) error = writeError;
            const status = !error ? 'done'
                : (error.name === 'AbortError' || job.controller.signal.aborted) ? 'aborted'
                : 'failed';
            const message = status === 'failed' ? String(error?.message || error) : null;
            stmtFinalize.run(status, message, Date.now(), job.bytesWritten, job.id);
            activeJobs.delete(job.id);
            notifyJobWaiters(job);
        }
    }

    // Create a job and fire the upstream request immediately. `arg.headers`
    // (which carry the provider auth) are consumed here and never persisted.
    // Returns { jobId } or throws { httpStatus, message } style errors are
    // left to the route layer — this returns { error, status } instead.
    function createJob(arg) {
        const chatId = typeof arg.chatId === 'string' ? arg.chatId : '';
        if (!chatId) {
            return { error: 'chatId is required', httpStatus: 400 };
        }
        const targetUrl = typeof arg.targetUrl === 'string' ? arg.targetUrl.trim() : '';
        let parsedTarget;
        try {
            parsedTarget = new URL(targetUrl);
        } catch {
            return { error: 'Invalid target URL', httpStatus: 400 };
        }
        if (parsedTarget.protocol !== 'http:' && parsedTarget.protocol !== 'https:') {
            return { error: 'Invalid target URL', httpStatus: 400 };
        }
        // LLM generation requests are always POST with an optional pre-serialized
        // string body (jobFetch stringifies before sending) — reject anything else.
        const method = typeof arg.method === 'string' ? arg.method.toUpperCase() : 'POST';
        if (method !== 'POST') {
            return { error: 'Invalid method', httpStatus: 400 };
        }
        if (arg.body !== undefined && arg.body !== null && typeof arg.body !== 'string') {
            return { error: 'Body must be a string', httpStatus: 400 };
        }
        const kind = arg.kind === 'aux' ? 'aux' : 'main';
        // Per-chat single-job guard — one active generation per chat, enforced
        // server-side at creation time (design §3 "중단"). Main jobs only: aux
        // side requests share the send's chat but are not generations.
        if (kind === 'main') {
            const running = stmtRunningForChat.get(chatId);
            if (running) {
                // jobId + generationId let the client tell "my own job from a
                // retried send — reattach" apart from a real conflict.
                return { error: 'A job is already running for this chat', httpStatus: 409, jobId: running.id, generationId: running.generation_id };
            }
        }

        let bodyBuffer;
        if (typeof arg.body === 'string') {
            bodyBuffer = Buffer.from(arg.body, 'utf-8');
        }

        const jobId = nodeCrypto.randomUUID();
        const job = {
            id: jobId,
            controller: new AbortController(),
            bytesWritten: 0,
            waiters: []
        };
        stmtInsert.run(
            jobId,
            chatId,
            typeof arg.generationId === 'string' ? arg.generationId : null,
            typeof arg.adapterKind === 'string' ? arg.adapterKind : null,
            typeof arg.model === 'string' ? arg.model.slice(0, 128) : null,
            typeof arg.modelLabel === 'string' ? arg.modelLabel.slice(0, 128) : null,
            parsedTarget.origin + parsedTarget.pathname,
            kind,
            arg.streaming ? 1 : 0,
            Number.isFinite(arg.inputTokens) ? Math.max(0, Math.round(arg.inputTokens)) : null,
            Number.isFinite(arg.outputTokens) ? Math.max(0, Math.round(arg.outputTokens)) : null,
            Number.isFinite(arg.maxContext) ? Math.max(0, Math.round(arg.maxContext)) : null,
            Date.now()
        );
        activeJobs.set(jobId, job);
        // Touch the journal synchronously so a stream reader attaching right
        // after the POST returns never races the async open in runJob().
        fs.closeSync(fs.openSync(journalPath(jobId), 'w'));

        const runPromise = runJob(job, {
            targetUrl,
            method,
            headers: normalizeUpstreamHeaders(arg.headers),
            bodyBuffer,
            timeoutMs: normalizeTimeoutMs(Number(arg.timeoutMs))
        }).catch((err) => {
            // runJob finalizes its own errors; this only guards the guard.
            if (opts.logger) opts.logger.error('[model-jobs] runJob crashed', err);
        });
        return { jobId, runPromise };
    }

    function claimJob(jobId) {
        const row = stmtGet.get(jobId);
        if (!row) return { error: 'Job not found', httpStatus: 404 };
        if (row.status === 'running') return { error: 'Job is still running', httpStatus: 409 };
        stmtClaim.run(jobId);
        return { success: true };
    }

    // Abort if running (the run loop finalizes status to 'aborted'); delete
    // record + journal if already terminal.
    function deleteJob(jobId) {
        const row = stmtGet.get(jobId);
        if (!row) return { error: 'Job not found', httpStatus: 404 };
        const active = activeJobs.get(jobId);
        if (active) {
            active.controller.abort();
            return { success: true, aborted: true };
        }
        stmtDelete.run(jobId);
        deleteJobFiles(jobId);
        return { success: true, deleted: true };
    }

    // Journal replay + live tail as one plain HTTP streaming response.
    // Loop: read until EOF → if job terminal, re-stat once and drain any bytes
    // appended between the EOF read and the terminal check → end. If still
    // running, sleep and read again. Race-free because runJob() only flips the
    // status to terminal after its final write, so once we observe terminal
    // the file size is final.
    async function streamJob(jobId, res) {
        let row = stmtGet.get(jobId);
        if (!row) {
            res.status(404).send({ error: 'Job not found' });
            return;
        }
        let clientGone = false;
        res.on('close', () => { clientGone = true; });

        // Wait for the upstream response headers before sending ours, so the
        // client can mirror status/content-type — same as a fetch awaiting
        // headers. Bounded: the job goes terminal on upstream failure/timeout.
        while (!clientGone && row.status === 'running' && row.upstream_status == null && activeJobs.has(jobId)) {
            await sleep(25);
            row = stmtGet.get(jobId);
        }
        if (clientGone) return;
        res.status(200);
        res.set('content-type', row.content_type || 'application/octet-stream');
        // no-transform keeps the compression middleware (and any proxy) from
        // buffering/recoding the stream — journal bytes must pass unchanged.
        res.set('cache-control', 'no-cache, no-transform');
        res.set('x-accel-buffering', 'no');
        res.set('x-model-job-id', row.id);
        res.set('x-model-job-status', row.status);
        if (row.upstream_status != null) {
            res.set('x-model-job-upstream-status', String(row.upstream_status));
        }
        res.flushHeaders();

        const filePath = journalPath(jobId);
        let fh;
        try {
            fh = await fsp.open(filePath, 'r');
        } catch {
            // Journal may not exist yet (job failed before the upstream
            // connected, or was created microseconds ago) — treat as empty.
            res.end();
            return;
        }
        try {
            let offset = 0;
            let sawTerminal = false;
            while (!clientGone) {
                // Fresh buffer per read: res.write() retains the buffer until
                // the socket flushes it, so a shared scratch buffer would be
                // corrupted by the next read. Not reused → subarray is safe.
                const buf = Buffer.allocUnsafe(64 * 1024);
                const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
                if (bytesRead > 0) {
                    offset += bytesRead;
                    const ok = res.write(buf.subarray(0, bytesRead));
                    if (!ok && !clientGone) {
                        // 'drain' never fires if the client disconnects mid-wait
                        // — race against 'close' so the loop can exit.
                        await Promise.race([once(res, 'drain'), once(res, 'close')]);
                    }
                    continue;
                }
                if (sawTerminal) break;
                if (!activeJobs.has(jobId)) {
                    // Terminal — one more read pass catches bytes appended
                    // between our EOF read and this status check.
                    sawTerminal = true;
                    continue;
                }
                // Wait for the writer's notify (journal bytes or terminal);
                // the fallback timeout is only a safety net.
                await waitForJobEvent(jobId);
            }
        } finally {
            await fh.close();
        }
        res.end();
    }

    // Express wiring. `auth(req, res)` must behave like server.cjs
    // checkProxyAuth: send its own error response and return false on failure.
    function registerRoutes(app, { auth }) {
        app.post('/api/model-jobs', async (req, res) => {
            if (!await auth(req, res)) return;
            const result = createJob({
                targetUrl: req.body?.targetUrl,
                method: req.body?.method,
                headers: req.body?.headers,
                body: req.body?.body,
                chatId: req.body?.chatId,
                generationId: req.body?.generationId,
                adapterKind: req.body?.adapterKind,
                model: req.body?.model,
                modelLabel: req.body?.modelLabel,
                inputTokens: req.body?.inputTokens,
                outputTokens: req.body?.outputTokens,
                maxContext: req.body?.maxContext,
                kind: req.body?.kind,
                streaming: !!req.body?.streaming,
                timeoutMs: req.body?.timeoutMs
            });
            if (result.error) {
                res.status(result.httpStatus).send({ error: result.error, jobId: result.jobId, generationId: result.generationId });
                return;
            }
            res.send({ jobId: result.jobId });
        });

        app.get('/api/model-jobs', async (req, res) => {
            if (!await auth(req, res)) return;
            const filter = req.query.active ? 'active' : req.query.unclaimed ? 'unclaimed' : null;
            const jobs = listJobs(filter);
            if (!jobs) {
                res.status(400).send({ error: 'active=1 or unclaimed=1 filter is required' });
                return;
            }
            res.send({ jobs });
        });

        app.get('/api/model-jobs/:id/stream', async (req, res) => {
            if (!await auth(req, res)) return;
            await streamJob(req.params.id, res);
        });

        app.get('/api/model-jobs/:id', async (req, res) => {
            if (!await auth(req, res)) return;
            const job = getJob(req.params.id);
            if (!job) {
                res.status(404).send({ error: 'Job not found' });
                return;
            }
            res.send(job);
        });

        app.post('/api/model-jobs/:id/claim', async (req, res) => {
            if (!await auth(req, res)) return;
            const result = claimJob(req.params.id);
            if (result.error) {
                res.status(result.httpStatus).send({ error: result.error });
                return;
            }
            res.send(result);
        });

        app.delete('/api/model-jobs/:id', async (req, res) => {
            if (!await auth(req, res)) return;
            const result = deleteJob(req.params.id);
            if (result.error) {
                res.status(result.httpStatus).send({ error: result.error });
                return;
            }
            res.send(result);
        });

        app.post('/api/pending-sends', async (req, res) => {
            if (!await auth(req, res)) return;
            const result = registerPendingSend({
                chatId: req.body?.chatId,
                generationId: req.body?.generationId,
            });
            if (result.error) {
                res.status(result.httpStatus).send({ error: result.error });
                return;
            }
            res.send(result);
        });

        app.get('/api/pending-sends', async (req, res) => {
            if (!await auth(req, res)) return;
            res.send({ pendingSends: listPendingSends() });
        });

        app.delete('/api/pending-sends/:chatId', async (req, res) => {
            if (!await auth(req, res)) return;
            res.send(clearPendingSend(req.params.chatId));
        });

        app.post('/api/pending-sends/:chatId/claim', async (req, res) => {
            if (!await auth(req, res)) return;
            res.send(claimPendingSend(req.params.chatId));
        });
    }

    // Boot: fail any jobs left 'running' by a previous process.
    markRunningJobsFailed();

    // Rotation runs out-of-band (boot + a modest interval) rather than on the
    // createJob hot path — the two full-scan queries don't belong per-insert.
    cleanupTerminalJobs();
    const cleanupTimer = setInterval(cleanupTerminalJobs, MODEL_JOB_CLEANUP_INTERVAL_MS);
    cleanupTimer.unref();

    return {
        registerRoutes,
        createJob,
        getJob,
        listJobs,
        claimJob,
        deleteJob,
        streamJob,
        registerPendingSend,
        clearPendingSend,
        claimPendingSend,
        listPendingSends,
        markRunningJobsFailed,
        cleanupTerminalJobs,
        journalPath,
        close: () => {
            clearInterval(cleanupTimer);
            db.close();
        }
    };
}

module.exports = { createModelJobs, normalizeUpstreamHeaders };

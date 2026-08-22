'use strict';

// Server-side request log + token usage statistics.
//
// Two tables with deliberately different lifetimes, in a DB file of their own
// (save/request-logs.db) so neither is ever carried by the .bin export:
//
//   requests — one row per outgoing provider request, carrying the request
//     body and the assembled response. Heavy (a 70k-token prompt is ~300KB of
//     JSON), so it rotates by TOTAL BYTES, not row count.
//   usage — one ~100-byte row per request: model, tokens, duration. Never
//     rotated. A year of heavy use is a few MB, so the statistics survive long
//     after the bodies that produced them have been rotated away.
//
// Both rows are written in one transaction from a single client POST, sent
// after the request finishes (the client already assembles the streamed text
// to render it, so the "Streamed Fetch" placeholder of the old in-memory log
// is gone). A tab that dies mid-request loses its log entry — same tradeoff
// the system log makes.
//
// Factory-bound to a save directory (like model-jobs.cjs, unlike logs.cjs) so
// the rotation and truncation rules are unit-testable against a temp dir.

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const { maskSensitive } = require('./logs.cjs');

// Rotation is by total body bytes: at ~300KB per request a row-count cap
// would swing between "a handful of chats" and "hundreds of MB" depending on
// prompt size. MIN_ROWS guarantees the most recent requests survive even if
// each one alone exceeds the budget.
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MIN_ROWS = 50;
// Per-entry cap. ~2MB is well past the largest real prompt (a 200k-token
// context is ~800KB of JSON), so truncation only fires on genuinely abnormal
// payloads — inlined base64 media that escaped the client-side stripping.
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_BATCH_SIZE = 50;
const ROTATE_EVERY_N_ROWS = 20;

const CATEGORIES = ['llm', 'tts', 'image', 'translate', 'embedding', 'other'];
const ROUTES = ['direct', 'proxy', 'job'];
// Which part of the app issued the request — the request-log analog of the
// system log's `source` tag. 'main'/'translate'/'memory'/'emotion'/'sub'
// mirror RequestKind (src/ts/status/requestStatus.ts) so the same vocabulary
// the request-status toast uses shows up here.
const SOURCES = [
    'main', 'translate', 'memory', 'emotion', 'sub',
    'preview', 'test', 'tts', 'image', 'plugin', 'other',
];

// ─── Pure helpers ────────────────────────────────────────────────────────────
function truncateBody(value, maxBytes) {
    if (typeof value !== 'string') return { text: value, truncated: false };
    if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { text: value, truncated: false };
    // A prompt's head (system instructions) and tail (recent turns) are what a
    // reader actually wants; the middle is old conversation. Keep both ends.
    const half = Math.floor(maxBytes / 2);
    const buf = Buffer.from(value, 'utf8');
    const head = buf.subarray(0, half).toString('utf8');
    const tail = buf.subarray(buf.length - half).toString('utf8');
    const omitted = Math.round((buf.length - maxBytes) / 1024);
    return { text: `${head}\n\n...[${omitted} KB omitted]...\n\n${tail}`, truncated: true };
}

function truncateTail(value, maxBytes) {
    if (typeof value !== 'string') return { text: value, truncated: false };
    if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { text: value, truncated: false };
    const buf = Buffer.from(value, 'utf8').subarray(0, maxBytes);
    return { text: buf.toString('utf8') + '...[truncated]', truncated: true };
}

function toInt(value) {
    return Number.isFinite(value) ? Math.round(value) : null;
}

function toNonNegInt(value) {
    const n = toInt(value);
    return n != null && n >= 0 ? n : 0;
}

function str(value, max) {
    if (value == null) return null;
    const s = String(value);
    return max ? s.slice(0, max) : s;
}

// Local calendar day of the entry, used for the per-day usage chart. NodeOnly
// serves a single household, so the server's timezone is the user's.
function dayKey(timestamp) {
    const d = new Date(timestamp);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function normalizeEntry(entry) {
    const timestamp = typeof entry.timestamp === 'number' ? entry.timestamp : Date.now();
    const category = CATEGORIES.includes(entry.category) ? entry.category : 'other';
    const source = SOURCES.includes(entry.source) ? entry.source : 'other';
    const route = ROUTES.includes(entry.route) ? entry.route : null;

    const headers = entry.requestHeaders != null
        ? truncateTail(maskSensitive(String(entry.requestHeaders)), MAX_HEADER_BYTES)
        : { text: null, truncated: false };
    const body = entry.requestBody != null
        ? truncateBody(maskSensitive(String(entry.requestBody)), MAX_BODY_BYTES)
        : { text: null, truncated: false };
    const response = entry.responseBody != null
        ? truncateTail(maskSensitive(String(entry.responseBody)), MAX_BODY_BYTES)
        : { text: null, truncated: false };

    const sizeBytes = Buffer.byteLength(headers.text ?? '', 'utf8')
        + Buffer.byteLength(body.text ?? '', 'utf8')
        + Buffer.byteLength(response.text ?? '', 'utf8');

    return {
        timestamp,
        category,
        source,
        chatId: str(entry.chatId, 128),
        generationId: str(entry.generationId, 128),
        model: str(entry.model, 128),
        provider: str(entry.provider, 64),
        // Masked like every other free-text column: several providers put the
        // API key in the query string (Gemini `?key=`, registry profiles with
        // query auth), so an unmasked URL is a cleartext credential on disk.
        url: str(maskSensitive(entry.url ?? ''), 2048) ?? '',
        method: str(entry.method, 16),
        status: toInt(entry.status),
        success: entry.success ? 1 : 0,
        aborted: entry.aborted ? 1 : 0,
        route,
        streaming: entry.streaming ? 1 : 0,
        durationMs: toInt(entry.durationMs),
        firstTokenMs: toInt(entry.firstTokenMs),
        inputTokens: toInt(entry.inputTokens),
        outputTokens: toInt(entry.outputTokens),
        cachedTokens: toInt(entry.cachedTokens),
        reasoningTokens: toInt(entry.reasoningTokens),
        requestHeaders: headers.text,
        requestBody: body.text,
        responseBody: response.text,
        responseType: str(entry.responseType, 32),
        errorMessage: entry.errorMessage != null
            ? maskSensitive(String(entry.errorMessage)).slice(0, 2000)
            : null,
        truncated: (headers.truncated || body.truncated || response.truncated) ? 1 : 0,
        sizeBytes,
        clientId: str(entry.clientId, 64),
    };
}

function rowToEntry(r) {
    return {
        id: r.id,
        timestamp: r.timestamp,
        category: r.category,
        source: r.source,
        chatId: r.chat_id,
        generationId: r.generation_id,
        model: r.model,
        provider: r.provider,
        url: r.url,
        method: r.method,
        status: r.status,
        success: !!r.success,
        aborted: !!r.aborted,
        route: r.route,
        streaming: !!r.streaming,
        durationMs: r.duration_ms,
        firstTokenMs: r.first_token_ms,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        cachedTokens: r.cached_tokens,
        reasoningTokens: r.reasoning_tokens,
        requestHeaders: r.request_headers,
        requestBody: r.request_body,
        responseBody: r.response_body,
        responseType: r.response_type,
        errorMessage: r.error_message,
        truncated: !!r.truncated,
        sizeBytes: r.size_bytes,
        clientId: r.client_id,
    };
}

// Bodies dominate row size, so the list view asks for them to be left out and
// only an expanded row fetches the full entry.
const LIST_COLUMNS = `
    id, timestamp, category, source, chat_id, generation_id, model, provider, url, method,
    status, success, aborted, route, streaming, duration_ms, first_token_ms,
    input_tokens, output_tokens, cached_tokens, reasoning_tokens,
    response_type, error_message, truncated, size_bytes, client_id
`;

const SUMS = `
    COUNT(*) AS requests,
    SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failed,
    SUM(input_tokens) AS inputTokens,
    SUM(output_tokens) AS outputTokens,
    SUM(cached_tokens) AS cachedTokens,
    SUM(reasoning_tokens) AS reasoningTokens,
    AVG(duration_ms) AS avgDurationMs
`;

function zeroFill(row) {
    return {
        requests: row?.requests ?? 0,
        failed: row?.failed ?? 0,
        inputTokens: row?.inputTokens ?? 0,
        outputTokens: row?.outputTokens ?? 0,
        cachedTokens: row?.cachedTokens ?? 0,
        reasoningTokens: row?.reasoningTokens ?? 0,
        avgDurationMs: row?.avgDurationMs != null ? Math.round(row.avgDurationMs) : null,
    };
}

const parseCsv = (v) => typeof v === 'string' && v.length ? v.split(',').filter(Boolean) : undefined;
const parseNum = (v) => v ? Number(v) : undefined;

// ─── Factory ─────────────────────────────────────────────────────────────────
function createRequestLogs(opts = {}) {
    const saveDir = opts.saveDir || path.join(process.cwd(), 'save');
    fs.mkdirSync(saveDir, { recursive: true });

    const db = new Database(path.join(saveDir, 'request-logs.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    // A rotation DELETE can span the whole byte budget in one transaction; without
    // a limit the -wal file stays at that peak forever (same reasoning as db.cjs).
    db.pragma('journal_size_limit = 67108864');
    // Rotation and "clear all" delete a lot at once. Without incremental vacuum
    // the pages are freed inside the file but never returned to the filesystem,
    // so the DB only ever grows on disk.
    db.pragma('auto_vacuum = INCREMENTAL');

    const maxTotalBytes = opts.maxTotalBytes ?? MAX_TOTAL_BYTES;
    const minRows = opts.minRows ?? MIN_ROWS;
    const rotateEvery = opts.rotateEveryNRows ?? ROTATE_EVERY_N_ROWS;

    db.exec(`
        CREATE TABLE IF NOT EXISTS requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp INTEGER NOT NULL,
            category TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'other',
            chat_id TEXT,
            generation_id TEXT,
            model TEXT,
            provider TEXT,
            url TEXT NOT NULL,
            method TEXT,
            status INTEGER,
            success INTEGER NOT NULL,
            aborted INTEGER NOT NULL DEFAULT 0,
            route TEXT,
            streaming INTEGER NOT NULL DEFAULT 0,
            duration_ms INTEGER,
            first_token_ms INTEGER,
            input_tokens INTEGER,
            output_tokens INTEGER,
            cached_tokens INTEGER,
            reasoning_tokens INTEGER,
            request_headers TEXT,
            request_body TEXT,
            response_body TEXT,
            response_type TEXT,
            error_message TEXT,
            truncated INTEGER NOT NULL DEFAULT 0,
            size_bytes INTEGER NOT NULL DEFAULT 0,
            client_id TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON requests(timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_requests_chat ON requests(chat_id);
        CREATE INDEX IF NOT EXISTS idx_requests_category ON requests(category);

        CREATE TABLE IF NOT EXISTS usage (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp INTEGER NOT NULL,
            day TEXT NOT NULL,
            category TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'other',
            model TEXT,
            provider TEXT,
            success INTEGER NOT NULL,
            streaming INTEGER NOT NULL DEFAULT 0,
            duration_ms INTEGER,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            cached_tokens INTEGER NOT NULL DEFAULT 0,
            reasoning_tokens INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_usage_day ON usage(day);
        CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage(timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_usage_model ON usage(model);
    `);

    const stmtInsertRequest = db.prepare(`
        INSERT INTO requests (
            timestamp, category, source, chat_id, generation_id, model, provider,
            url, method, status, success, aborted, route, streaming,
            duration_ms, first_token_ms,
            input_tokens, output_tokens, cached_tokens, reasoning_tokens,
            request_headers, request_body, response_body, response_type,
            error_message, truncated, size_bytes, client_id
        ) VALUES (
            @timestamp, @category, @source, @chatId, @generationId, @model, @provider,
            @url, @method, @status, @success, @aborted, @route, @streaming,
            @durationMs, @firstTokenMs,
            @inputTokens, @outputTokens, @cachedTokens, @reasoningTokens,
            @requestHeaders, @requestBody, @responseBody, @responseType,
            @errorMessage, @truncated, @sizeBytes, @clientId
        )
    `);

    const stmtInsertUsage = db.prepare(`
        INSERT INTO usage (
            timestamp, day, category, source, model, provider, success, streaming, duration_ms,
            input_tokens, output_tokens, cached_tokens, reasoning_tokens
        ) VALUES (
            @timestamp, @day, @category, @source, @model, @provider, @success, @streaming, @durationMs,
            @inputTokens, @outputTokens, @cachedTokens, @reasoningTokens
        )
    `);

    // Keep the newest rows whose running byte total fits the budget; always
    // keep at least minRows regardless of size. The running sum is computed
    // newest-first, so the rows dropped are always the oldest.
    const stmtRotate = db.prepare(`
        DELETE FROM requests WHERE id IN (
            SELECT id FROM (
                SELECT id,
                       SUM(size_bytes) OVER (ORDER BY id DESC) AS running,
                       ROW_NUMBER() OVER (ORDER BY id DESC) AS rn
                FROM requests
            )
            WHERE running > ? AND rn > ?
        )
    `);

    const insertMany = db.transaction((rows) => {
        for (const row of rows) {
            stmtInsertRequest.run(row);
            // Statistics are token-shaped, and the usage table is never rotated.
            // Admitting TTS/image/polling traffic would permanently inflate the
            // request count with rows that have no tokens to report.
            if (row.category !== 'llm') continue;
            stmtInsertUsage.run({
                timestamp: row.timestamp,
                day: dayKey(row.timestamp),
                category: row.category,
                source: row.source,
                model: row.model,
                provider: row.provider,
                success: row.success,
                streaming: row.streaming,
                durationMs: row.durationMs,
                inputTokens: toNonNegInt(row.inputTokens),
                outputTokens: toNonNegInt(row.outputTokens),
                cachedTokens: toNonNegInt(row.cachedTokens),
                reasoningTokens: toNonNegInt(row.reasoningTokens),
            });
        }
    });

    let insertedSinceRotate = 0;

    function addRequestLogBatch(entries) {
        if (!Array.isArray(entries) || entries.length === 0) return 0;
        const capped = entries.length > MAX_BATCH_SIZE
            ? entries.slice(entries.length - MAX_BATCH_SIZE)
            : entries;
        const rows = capped
            .filter(e => e && typeof e === 'object' && typeof e.url === 'string')
            .map(normalizeEntry);
        if (rows.length === 0) return 0;
        insertMany(rows);
        insertedSinceRotate += rows.length;
        if (insertedSinceRotate >= rotateEvery) {
            rotateNow();
        }
        return rows.length;
    }

    // Reclaim pages freed by a previous rotation / clear. Incremental so a large
    // reclaim never blocks the process the way a full VACUUM would.
    function reclaimFreePages() {
        try { db.pragma('incremental_vacuum'); } catch { /* best effort */ }
    }

    function rotateNow() {
        insertedSinceRotate = 0;
        stmtRotate.run(maxTotalBytes, minRows);
        reclaimFreePages();
    }

    // ─── Query: request log ──────────────────────────────────────────────────
    function buildRequestWhere({ categories, sources, chatId, successOnly, failedOnly, since, until } = {}) {
        const conditions = [];
        const params = [];
        if (Array.isArray(categories) && categories.length) {
            conditions.push(`category IN (${categories.map(() => '?').join(',')})`);
            params.push(...categories);
        }
        if (Array.isArray(sources) && sources.length) {
            conditions.push(`source IN (${sources.map(() => '?').join(',')})`);
            params.push(...sources);
        }
        if (chatId) { conditions.push(`chat_id = ?`); params.push(String(chatId)); }
        if (successOnly) conditions.push(`success = 1`);
        if (failedOnly) conditions.push(`success = 0`);
        if (typeof since === 'number') { conditions.push(`timestamp >= ?`); params.push(since); }
        if (typeof until === 'number') { conditions.push(`timestamp <= ?`); params.push(until); }
        return { conditions, params };
    }

    function queryRequestLogs(query = {}) {
        const { beforeId, limit, withBodies } = query;
        const { conditions, params } = buildRequestWhere(query);
        // Cursor is id (not timestamp) so burst-written rows sharing a
        // timestamp paginate deterministically — same rule as the system log.
        if (typeof beforeId === 'number') { conditions.push(`id < ?`); params.push(beforeId); }
        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const lim = Math.min(Math.max(Number(limit) || 50, 1), 500);
        const columns = withBodies ? '*' : LIST_COLUMNS;
        return db.prepare(`SELECT ${columns} FROM requests ${where} ORDER BY id DESC LIMIT ?`)
            .all(...params, lim)
            .map(rowToEntry);
    }

    function countRequestLogs(query = {}) {
        const { conditions, params } = buildRequestWhere(query);
        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const row = db.prepare(`SELECT COUNT(*) as n FROM requests ${where}`).get(...params);
        return row ? row.n : 0;
    }

    function getRequestLog(id) {
        const row = db.prepare(`SELECT * FROM requests WHERE id = ?`).get(id);
        return row ? rowToEntry(row) : null;
    }

    function clearRequestLogs() {
        db.prepare(`DELETE FROM requests`).run();
        insertedSinceRotate = 0;
        // Without this the file keeps its old size and "clear all" reclaims
        // nothing the user can see in the storage gauge.
        reclaimFreePages();
    }

    // ─── Query: usage statistics ─────────────────────────────────────────────
    function buildUsageWhere({ categories, sources, models, since, until, successOnly } = {}) {
        const conditions = [];
        const params = [];
        if (Array.isArray(categories) && categories.length) {
            conditions.push(`category IN (${categories.map(() => '?').join(',')})`);
            params.push(...categories);
        }
        if (Array.isArray(sources) && sources.length) {
            conditions.push(`source IN (${sources.map(() => '?').join(',')})`);
            params.push(...sources);
        }
        if (Array.isArray(models) && models.length) {
            conditions.push(`model IN (${models.map(() => '?').join(',')})`);
            params.push(...models);
        }
        if (typeof since === 'number') { conditions.push(`timestamp >= ?`); params.push(since); }
        if (typeof until === 'number') { conditions.push(`timestamp <= ?`); params.push(until); }
        if (successOnly) conditions.push(`success = 1`);
        return { conditions, params };
    }

    function queryUsage(query = {}) {
        const { conditions, params } = buildUsageWhere(query);
        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

        const total = zeroFill(db.prepare(`SELECT ${SUMS} FROM usage ${where}`).get(...params));

        const daily = db.prepare(
            `SELECT day, ${SUMS} FROM usage ${where} GROUP BY day ORDER BY day ASC`
        ).all(...params).map(r => ({ day: r.day, ...zeroFill(r) }));

        const byModel = db.prepare(
            `SELECT model, provider, ${SUMS} FROM usage ${where}
             GROUP BY model, provider ORDER BY (SUM(input_tokens) + SUM(output_tokens)) DESC`
        ).all(...params).map(r => ({ model: r.model, provider: r.provider, ...zeroFill(r) }));

        const bySource = db.prepare(
            `SELECT source, ${SUMS} FROM usage ${where}
             GROUP BY source ORDER BY (SUM(input_tokens) + SUM(output_tokens)) DESC`
        ).all(...params).map(r => ({ source: r.source, ...zeroFill(r) }));

        return { total, daily, byModel, bySource };
    }

    // Distinct values present in the usage table — drives the filter chips
    // without the client having to page through every row first.
    function usageDimensions() {
        return {
            models: db.prepare(`SELECT DISTINCT model FROM usage WHERE model IS NOT NULL ORDER BY model`)
                .all().map(r => r.model),
            categories: db.prepare(`SELECT DISTINCT category FROM usage ORDER BY category`)
                .all().map(r => r.category),
            sources: db.prepare(`SELECT DISTINCT source FROM usage ORDER BY source`)
                .all().map(r => r.source),
        };
    }

    function clearUsage() {
        db.prepare(`DELETE FROM usage`).run();
        reclaimFreePages();
    }

    function storageStats() {
        const req = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes FROM requests`).get();
        const usg = db.prepare(`SELECT COUNT(*) AS n FROM usage`).get();
        return {
            requestCount: req.n,
            requestBytes: req.bytes,
            usageCount: usg.n,
            maxTotalBytes,
        };
    }

    // ─── Routes ──────────────────────────────────────────────────────────────
    // `auth` mirrors the /api/logs guard; `activeSession` is the extra guard
    // destructive endpoints use (a read-only session must not wipe logs).
    function registerRoutes(app, { auth, activeSession } = {}) {
        const guard = auth ?? (async () => true);
        const sessionGuard = activeSession ?? (() => true);

        app.post('/api/request-logs', async (req, res, next) => {
            if (!await guard(req, res)) return;
            try {
                const entries = Array.isArray(req.body) ? req.body : [req.body];
                res.send({ success: true, written: addRequestLogBatch(entries) });
            } catch (error) {
                next(error);
            }
        });

        app.get('/api/request-logs', async (req, res, next) => {
            if (!await guard(req, res)) return;
            try {
                const filterArgs = {
                    categories: parseCsv(req.query.categories),
                    sources: parseCsv(req.query.sources),
                    chatId: typeof req.query.chat_id === 'string' ? req.query.chat_id : undefined,
                    successOnly: req.query.success === '1',
                    failedOnly: req.query.failed === '1',
                    since: parseNum(req.query.since),
                    until: parseNum(req.query.until),
                };
                const rows = queryRequestLogs({
                    ...filterArgs,
                    beforeId: parseNum(req.query.before_id),
                    limit: parseNum(req.query.limit),
                    withBodies: req.query.bodies === '1',
                });
                res.send({ success: true, content: rows, total: countRequestLogs(filterArgs) });
            } catch (error) {
                next(error);
            }
        });

        app.get('/api/request-logs/usage', async (req, res, next) => {
            if (!await guard(req, res)) return;
            try {
                res.send({
                    success: true,
                    ...queryUsage({
                        categories: parseCsv(req.query.categories),
                        sources: parseCsv(req.query.sources),
                        models: parseCsv(req.query.models),
                        since: parseNum(req.query.since),
                        until: parseNum(req.query.until),
                        successOnly: req.query.success === '1',
                    }),
                    dimensions: usageDimensions(),
                });
            } catch (error) {
                next(error);
            }
        });

        app.get('/api/request-logs/stats', async (req, res, next) => {
            if (!await guard(req, res)) return;
            try {
                res.send({ success: true, ...storageStats() });
            } catch (error) {
                next(error);
            }
        });

        // Registered after the literal '/usage' and '/stats' paths so those are
        // never swallowed by the :id parameter.
        app.get('/api/request-logs/:id', async (req, res, next) => {
            if (!await guard(req, res)) return;
            try {
                const entry = getRequestLog(Number(req.params.id));
                if (!entry) return res.status(404).send({ error: 'not found' });
                res.send({ success: true, content: entry });
            } catch (error) {
                next(error);
            }
        });

        app.delete('/api/request-logs', async (req, res, next) => {
            if (!await guard(req, res)) return;
            if (!sessionGuard(req, res)) return;
            try {
                clearRequestLogs();
                // Statistics outlive the bodies, so wiping them is opt-in.
                if (req.query.usage === '1') clearUsage();
                res.send({ success: true });
            } catch (error) {
                next(error);
            }
        });
    }

    // Re-mask URLs written before the url column was masked: a Gemini request
    // carries its API key in the query string, so those rows hold a cleartext
    // credential. Idempotent — an already-masked row rewrites to itself, and
    // after the first boot the LIKE scan finds nothing.
    try {
        const leaky = db.prepare(
            `SELECT id, url FROM requests WHERE url LIKE '%key=%' OR url LIKE '%token=%'`
        ).all();
        if (leaky.length > 0) {
            const fix = db.prepare(`UPDATE requests SET url = ? WHERE id = ?`);
            db.transaction(() => {
                for (const row of leaky) {
                    const masked = maskSensitive(row.url);
                    if (masked !== row.url) fix.run(masked, row.id);
                }
            })();
        }
    } catch { /* table may not exist yet on a fresh install */ }

    // insertedSinceRotate is process-local, so a server that restarts before
    // reaching the threshold would never rotate — over many restarts the byte
    // budget stops being enforced entirely. One sweep at startup fixes that.
    try { rotateNow(); } catch { /* best effort */ }

    return {
        addRequestLogBatch,
        queryRequestLogs,
        countRequestLogs,
        getRequestLog,
        clearRequestLogs,
        queryUsage,
        usageDimensions,
        clearUsage,
        storageStats,
        rotateNow,
        registerRoutes,
        close: () => db.close(),
    };
}

module.exports = {
    createRequestLogs,
    // Exported for tests and for the client-side contract.
    CATEGORIES,
    SOURCES,
    ROUTES,
    MAX_BODY_BYTES,
    MAX_TOTAL_BYTES,
    MIN_ROWS,
    truncateBody,
    truncateTail,
    dayKey,
};

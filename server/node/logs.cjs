'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');

const MAX_ROWS = 5000;
const MAX_DESCRIPTION_BYTES = 10 * 1024; // 10KB per entry
const MAX_BATCH_SIZE = 1000;             // per addLogBatch / per /api/logs request
const ROTATE_EVERY_N_ROWS = 100;         // amortize DELETE cost

const saveDir = path.join(process.cwd(), 'save');
if (!fs.existsSync(saveDir)) {
    fs.mkdirSync(saveDir, { recursive: true });
}
const dbPath = path.join(saveDir, 'logs.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');

db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        level TEXT NOT NULL,
        origin TEXT NOT NULL,
        message TEXT NOT NULL,
        description TEXT,
        source TEXT,
        count INTEGER NOT NULL DEFAULT 1,
        platform TEXT,
        client_id TEXT,
        user_agent TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
`);

const stmtInsert = db.prepare(`
    INSERT INTO logs
        (timestamp, level, origin, message, description, source, count, platform, client_id, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const stmtRotate = db.prepare(`
    DELETE FROM logs
    WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT ?)
`);

const stmtClearAll = db.prepare(`DELETE FROM logs`);

// Sources captured by monkey-patched console / window handlers / Express
// middleware rather than explicit logger calls. Mirrors the client-side
// BACKGROUND_SOURCES list in LogsSettings.svelte — kept in sync manually.
const BACKGROUND_SOURCES = ['console', 'uncaught', 'promise', 'express'];

// ─── Masking ─────────────────────────────────────────────────────────────────
// Sanitize strings before persisting. Order matters: apply specific patterns first.
const MASK_PATTERNS = [
    // JWT (three base64url segments joined by dots, starts with eyJ)
    { re: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, replacement: '[REDACTED_JWT]' },
    // JSON-quoted auth headers:  "x-api-key": "secret"  /  "authorization": "Bearer …"
    { re: /"((?:x-)?api[-_]?key)"\s*:\s*"[^"]*"/gi, replacement: '"$1":"[REDACTED_API_KEY]"' },
    { re: /"authorization"\s*:\s*"[^"]*"/gi, replacement: '"authorization":"[REDACTED_TOKEN]"' },
    // Bearer tokens
    { re: /Bearer\s+[A-Za-z0-9_.\-+/=]{10,}/gi, replacement: 'Bearer [REDACTED_TOKEN]' },
    // Authorization header values (non-JSON form)
    { re: /(Authorization\s*[:=]\s*)[^\s,;)}{]+/gi, replacement: '$1[REDACTED_TOKEN]' },
    // Header-style api key fields (x-api-key, api-key, api_key, apikey) — non-JSON form
    { re: /((?:x-)?api[-_]?key\s*[:=]\s*)['"]?[^'"\s,;)}{]+/gi, replacement: '$1[REDACTED_API_KEY]' },
    // Vendor-specific and generic secret-bearing JSON fields. Value-shape
    // patterns below miss these because the values are opaque (Google ya29.*
    // OAuth tokens, AWS session tokens, plugin-supplied custom headers), so
    // match on the FIELD NAME instead.
    { re: /"(x-goog-api-key|x-goog-iam-authorization-token)"\s*:\s*"[^"]*"/gi, replacement: '"$1":"[REDACTED_API_KEY]"' },
    { re: /"(x-amz-security-token|x-amz-credential|x-amz-signature)"\s*:\s*"[^"]*"/gi, replacement: '"$1":"[REDACTED_TOKEN]"' },
    { re: /"(cookie|set-cookie)"\s*:\s*"[^"]*"/gi, replacement: '"$1":"[REDACTED_COOKIE]"' },
    { re: /"([a-z0-9_-]*(?:secret|password|passwd|private[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?key|session[-_]?key))"\s*:\s*"[^"]*"/gi, replacement: '"$1":"[REDACTED]"' },
    // Google OAuth access tokens (service-account / Vertex), which carry no
    // recognizable prefix beyond ya29.
    { re: /ya29\.[A-Za-z0-9_\-]{20,}/g, replacement: '[REDACTED_TOKEN]' },
    // PEM private keys (service-account JSON pasted into a profile).
    { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: '[REDACTED_PRIVATE_KEY]' },
    // Anthropic keys (more specific than sk-)
    { re: /sk-ant-[A-Za-z0-9_\-]{20,}/g, replacement: '[REDACTED_API_KEY]' },
    // Google API keys
    { re: /AIza[0-9A-Za-z_\-]{35}/g, replacement: '[REDACTED_API_KEY]' },
    // OpenAI-style keys (catch remaining sk- after Anthropic pattern handled)
    { re: /sk-[A-Za-z0-9_\-]{20,}/g, replacement: '[REDACTED_API_KEY]' },
];

function maskSensitive(value) {
    if (typeof value !== 'string') return value;
    let out = value;
    for (const { re, replacement } of MASK_PATTERNS) {
        out = out.replace(re, replacement);
    }
    return out;
}

function truncate(value, maxBytes) {
    if (typeof value !== 'string') return value;
    if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
    // crude truncation at byte boundary, then re-encode to avoid broken surrogate
    const buf = Buffer.from(value, 'utf8').subarray(0, maxBytes);
    return buf.toString('utf8') + '...[truncated]';
}

// ─── Insert ──────────────────────────────────────────────────────────────────
function insertEntry(entry) {
    const timestamp = typeof entry.timestamp === 'number' ? entry.timestamp : Date.now();
    const level = ['error', 'warning', 'info'].includes(entry.level) ? entry.level : 'info';
    const origin = entry.origin === 'server' ? 'server' : 'client';
    const message = maskSensitive(String(entry.message ?? '')).slice(0, 1000);
    const description = entry.description != null
        ? truncate(maskSensitive(String(entry.description)), MAX_DESCRIPTION_BYTES)
        : null;
    const source = entry.source ? String(entry.source).slice(0, 64) : null;
    const count = Number.isInteger(entry.count) && entry.count > 0 ? entry.count : 1;
    const platform = entry.platform ? String(entry.platform).slice(0, 128) : null;
    const clientId = entry.clientId ? String(entry.clientId).slice(0, 64) : null;
    const userAgent = entry.userAgent ? String(entry.userAgent).slice(0, 512) : null;

    stmtInsert.run(timestamp, level, origin, message, description, source, count, platform, clientId, userAgent);
}

const insertMany = db.transaction((entries) => {
    for (const e of entries) insertEntry(e);
});

let insertedSinceRotate = 0;

function addLog(entry) {
    insertMany([entry]);
    insertedSinceRotate += 1;
    maybeRotate();
}

function addLogBatch(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return 0;
    // Defensive cap: prefer the most recent entries when truncating.
    const capped = entries.length > MAX_BATCH_SIZE
        ? entries.slice(entries.length - MAX_BATCH_SIZE)
        : entries;
    insertMany(capped);
    insertedSinceRotate += capped.length;
    maybeRotate();
    return capped.length;
}

function maybeRotate() {
    if (insertedSinceRotate < ROTATE_EVERY_N_ROWS) return;
    insertedSinceRotate = 0;
    stmtRotate.run(MAX_ROWS);
}

// ─── Server-side logger ──────────────────────────────────────────────────────
// Use OS-level label only (no hostname). Hostname can include the user's
// real device name and is leaked when users share log captures for support.
function nodePlatformLabel() {
    switch (process.platform) {
        case 'darwin':  return 'macOS';
        case 'linux':   return 'Linux';
        case 'win32':   return 'Windows';
        case 'android': return 'Android';
        case 'freebsd': return 'FreeBSD';
        case 'openbsd': return 'OpenBSD';
        default:        return process.platform;
    }
}
const serverPlatform = `Node · ${nodePlatformLabel()}`;

// Backfill historic rows that were stored with `Node · <hostname>` (the old
// format leaked the user's machine name when sharing logs). Idempotent —
// after the first boot every matching row is normalized, subsequent boots
// scan and find no work. Cost on a 10k-row logs table is sub-ms.
try {
    db.prepare(
        `UPDATE logs SET platform = ? WHERE platform LIKE 'Node · %' AND platform != ?`
    ).run(serverPlatform, serverPlatform);
} catch { /* logs table may not exist yet on a fresh install — ignore */ }

function formatErrorWithCause(err) {
    // Walk the cause chain so we don't lose context when a caller switches
    // from logging `err.cause` to logging the outer error (needed for __logged
    // tagging to work end-to-end).
    let out = err.stack || err.message || String(err);
    let seen = new Set([err]);
    let cause = err.cause;
    while (cause && !seen.has(cause)) {
        seen.add(cause);
        out += '\nCaused by: ';
        if (cause instanceof Error) {
            out += cause.stack || cause.message || String(cause);
            cause = cause.cause;
        } else {
            out += String(cause);
            break;
        }
    }
    return out;
}

function formatArg(arg) {
    if (arg instanceof Error) return formatErrorWithCause(arg);
    if (arg === null || arg === undefined) return String(arg);
    if (typeof arg === 'string') return arg;
    try { return JSON.stringify(arg); } catch { return String(arg); }
}

function normalizeArgs(args) {
    if (args.length === 0) return { message: '', description: undefined };
    if (args.length === 1) {
        const a = args[0];
        if (a instanceof Error) return { message: a.message || String(a), description: formatErrorWithCause(a) };
        return { message: formatArg(a), description: undefined };
    }
    const [first, ...rest] = args;
    return {
        message: formatArg(first),
        description: rest.map(formatArg).join(' '),
    };
}

function makeServerLogger() {
    function log(level, args) {
        try {
            const { message, description } = normalizeArgs(args);
            addLog({
                timestamp: Date.now(),
                level,
                origin: 'server',
                message,
                description,
                source: 'server',
                platform: serverPlatform,
            });
        } catch (e) {
            // never let logging crash the caller
            console.error('[logs] failed to persist log entry:', e);
        }
    }
    // Tag Error instances so the Express error middleware (which logs every
    // error it sees) can skip anything we already recorded here. Prevents
    // double-entry when a route does `logger.error(err); next(err)`.
    function markLogged(args) {
        for (const a of args) {
            if (a && typeof a === 'object' && a instanceof Error) {
                try { Object.defineProperty(a, '__logged', { value: true, configurable: true }); } catch {}
            }
        }
    }
    // varargs-compatible — drop-in for console.error / console.warn
    return {
        error: (...args) => { log('error', args); markLogged(args); console.error(...args); },
        warning: (...args) => { log('warning', args); markLogged(args); console.warn(...args); },
        warn: (...args) => { log('warning', args); markLogged(args); console.warn(...args); },
        info: (...args) => { log('info', args); },
    };
}

const logger = makeServerLogger();

// ─── Query ───────────────────────────────────────────────────────────────────
// Shared filter builder. All dimensions except pagination (beforeId/limit) go
// here so countLogs() and queryLogs() produce consistent totals vs. results.
function buildFilterWhere({ level, origin, since, excludeLevels, excludeOrigins, excludeBackground } = {}) {
    const conditions = [];
    const params = [];
    if (level) { conditions.push(`level = ?`); params.push(level); }
    if (origin) { conditions.push(`origin = ?`); params.push(origin); }
    if (typeof since === 'number') { conditions.push(`timestamp >= ?`); params.push(since); }
    if (Array.isArray(excludeLevels) && excludeLevels.length) {
        conditions.push(`level NOT IN (${excludeLevels.map(() => '?').join(',')})`);
        params.push(...excludeLevels);
    }
    if (Array.isArray(excludeOrigins) && excludeOrigins.length) {
        conditions.push(`origin NOT IN (${excludeOrigins.map(() => '?').join(',')})`);
        params.push(...excludeOrigins);
    }
    if (excludeBackground) {
        // NULL source must survive the filter — only named background sources are excluded.
        conditions.push(`(source IS NULL OR source NOT IN (${BACKGROUND_SOURCES.map(() => '?').join(',')}))`);
        params.push(...BACKGROUND_SOURCES);
    }
    return { conditions, params };
}

function queryLogs(opts = {}) {
    const { beforeId, limit } = opts;
    const { conditions, params } = buildFilterWhere(opts);
    // Cursor is id (not timestamp): aligns with ORDER BY id DESC so burst-written rows
    // sharing a timestamp paginate deterministically instead of being skipped.
    if (typeof beforeId === 'number') { conditions.push(`id < ?`); params.push(beforeId); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const lim = Math.min(Math.max(Number(limit) || 500, 1), 5000);
    const sql = `SELECT * FROM logs ${where} ORDER BY id DESC LIMIT ?`;
    const rows = db.prepare(sql).all(...params, lim);
    return rows.map(r => ({
        id: r.id,
        timestamp: r.timestamp,
        level: r.level,
        origin: r.origin,
        message: r.message,
        description: r.description,
        source: r.source,
        count: r.count,
        platform: r.platform,
        clientId: r.client_id,
        userAgent: r.user_agent,
    }));
}

function clearLogs() {
    stmtClearAll.run();
    insertedSinceRotate = 0;
}

function countLogs(opts = {}) {
    const { conditions, params } = buildFilterWhere(opts);
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT COUNT(*) as n FROM logs ${where}`;
    const row = db.prepare(sql).get(...params);
    return row ? row.n : 0;
}

// ─── Global error handlers ──────────────────────────────────────────────────
let handlersInstalled = false;
function installProcessHandlers() {
    if (handlersInstalled) return;
    handlersInstalled = true;

    process.on('uncaughtException', (err) => {
        try {
            addLog({
                timestamp: Date.now(),
                level: 'error',
                origin: 'server',
                source: 'uncaught',
                message: err?.message || String(err),
                description: err?.stack,
                platform: serverPlatform,
            });
        } catch {}
        console.error('[uncaughtException]', err);
        // Preserve Node's default: terminate after uncaught exception.
        // better-sqlite3 writes synchronously, so the log entry above is already on disk.
        process.exit(1);
    });

    process.on('unhandledRejection', (reason) => {
        try {
            const err = reason instanceof Error ? reason : null;
            addLog({
                timestamp: Date.now(),
                level: 'error',
                origin: 'server',
                source: 'promise',
                message: err?.message || String(reason),
                description: err?.stack,
                platform: serverPlatform,
            });
        } catch {}
        console.error('[unhandledRejection]', reason);
        // Node 15+ default: treat unhandled rejection as fatal.
        process.exit(1);
    });
}

// ─── Express middleware ─────────────────────────────────────────────────────
function expressErrorMiddleware(err, req, res, next) {
    // Skip if the route already logged this error via logger.* — prevents double-entry.
    if (err && typeof err === 'object' && err.__logged) return next(err);
    try {
        addLog({
            timestamp: Date.now(),
            level: 'error',
            origin: 'server',
            source: 'express',
            message: `${req.method} ${req.path} — ${err?.message || 'error'}`,
            description: err?.stack,
            platform: serverPlatform,
        });
        if (err && typeof err === 'object') {
            try { Object.defineProperty(err, '__logged', { value: true, configurable: true }); } catch {}
        }
    } catch {}
    next(err);
}

module.exports = {
    addLog,
    addLogBatch,
    queryLogs,
    clearLogs,
    countLogs,
    logger,
    installProcessHandlers,
    expressErrorMiddleware,
    maskSensitive,
};

const express = require('express');
const app = express();
const http = require('http');
const https = require('https');
const path = require('path');
const net = require('net');
const compression = require('compression');
const htmlparser = require('node-html-parser');
const { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } = require('fs');
const fs = require('fs/promises')
const nodeCrypto = require('crypto')
const zlib = require('zlib')
const rateLimit = require('express-rate-limit')
const { WebSocketServer } = require('ws')
const Vips = require('wasm-vips')
let _vipsPromise = null
const getVips = () => {
    if (!_vipsPromise) {
        _vipsPromise = Vips().catch(err => {
            _vipsPromise = null
            throw err
        })
    }
    return _vipsPromise
}
const { kvGet, kvSet, kvDel, kvList,
        kvDelPrefix, kvListWithSizes, kvSize, kvGetUpdatedAt, kvCopyValue, clearEntities, checkpointWal,
        gcChunks, reclaimableChunkBytes, isDbBlobChunked, snapshotFootprint, db: sqliteDb } = require('./db.cjs');
const {
    addLogBatch, queryLogs, clearLogs, countLogs,
    logger, installProcessHandlers, expressErrorMiddleware,
} = require('./logs.cjs');
const { applyPatch } = require('fast-json-patch');
const { decodeRisuSave, encodeRisuSaveLegacy, calculateHash, normalizeJSON, hasRemoteBlocks } = require('./utils.cjs');
const { spawn, execSync } = require('child_process');
const os = require('os');
const { Readable, Transform } = require('stream');

// Install process-level error handlers before any other init so early crashes get logged.
installProcessHandlers();

// Node.js version check
const [nodeMajor] = process.version.slice(1).split('.').map(Number);
if (nodeMajor < 24) {
    logger.warn(`[Server] Node.js ${process.version} is below the recommended version (v24.x). Consider upgrading for best compatibility.`);
}

// Configuration flags for patch-based sync
const enablePatchSync = true;

// In-memory database cache for patch-based sync
// dbCache stores the STRIPPED (stubs-only) version matching what the client sees.
// fullChatStore keeps the actual chat data keyed by chaId→chatId.
let dbCache = {};
let saveTimers = {};
const SAVE_INTERVAL = 5000;
let fullChatStore = null; // Map<chaId, Map<chatId, chatObject>> — lazy-initialized

// ETag for database.bin
let dbEtag = null;

function computeBufferEtag(buffer) {
    return nodeCrypto.createHash('md5').update(buffer).digest('hex');
}

function computeDatabaseEtagFromObject(databaseObject) {
    return computeBufferEtag(Buffer.from(encodeRisuSaveLegacy(databaseObject)));
}

let storageOperationQueue = Promise.resolve();
function queueStorageOperation(operation) {
    const operationRun = storageOperationQueue.then(operation, operation);
    storageOperationQueue = operationRun.catch(() => {});
    return operationRun;
}

const DB_HEX_KEY = Buffer.from('database/database.bin', 'utf-8').toString('hex');

// ─── Persist failure tracking (Stage 1 visibility) ───────────────────────────
// Debounced persist runs in setTimeout, so failures cannot be returned in the
// triggering response. Record the latest failure here and surface it on the
// next /api/patch response. Cleared on next successful persist.
let lastPersistFailure = null;

function recordPersistFailure(error, source) {
    const message = String(error?.message || error || 'unknown error');
    const attemptedSize = typeof error?.attemptedSize === 'number' ? error.attemptedSize : null;
    // Preserve timestamp when the failure is identical to the last one — every
    // debounce cycle re-records the same failure, and clients dedupe by ts.
    // Without this guard a fresh ts every 5s would re-fire the toast.
    if (lastPersistFailure
        && lastPersistFailure.source === source
        && lastPersistFailure.message === message
        && lastPersistFailure.attemptedSize === attemptedSize) {
        return;
    }
    lastPersistFailure = {
        timestamp: Date.now(),
        message,
        attemptedSize,
        source,
    };
}

function clearPersistFailure() {
    lastPersistFailure = null;
}

function currentPersistWarning() {
    return lastPersistFailure;
}

// ─── Server-side database backup (DB-only snapshots) ────────────────────────
//
// Snapshots live as `database/dbbackup-{ts}.bin` keys inside the kv table.
// They're created on every successful persist (with a cooldown) and rotated
// to fit user-configured count/size limits — see SNAPSHOT_LIMIT_* below.
const SNAPSHOT_LIMIT_COUNT_KEY = 'config/snapshot-max-count';
const SNAPSHOT_LIMIT_BYTES_KEY = 'config/snapshot-max-bytes';
const SNAPSHOT_LIMIT_DEFAULT_COUNT = 20;
const SNAPSHOT_LIMIT_DEFAULT_BYTES = 500 * 1024 * 1024; // 500 MB
// Safety bounds to keep a stray PUT from making the system unusable.
const SNAPSHOT_LIMIT_MIN_COUNT = 1;
const SNAPSHOT_LIMIT_MAX_COUNT = 100;
const SNAPSHOT_LIMIT_MIN_BYTES = 10 * 1024 * 1024;        // 10 MB
const SNAPSHOT_LIMIT_MAX_BYTES = 50 * 1024 * 1024 * 1024; // 50 GB
const BACKUP_INTERVAL_MS = process.env.POCKETRISU_BACKUP_INTERVAL_MS
    ? Number(process.env.POCKETRISU_BACKUP_INTERVAL_MS)
    : 5 * 60 * 1000; // 5 minutes (override for tests to force snapshot creation)
let lastBackupTime = null;

function readSnapshotConfigInt(key, fallback, min, max) {
    try {
        const raw = kvGet(key);
        if (!raw) return fallback;
        const n = parseInt(Buffer.from(raw).toString('utf-8').trim(), 10);
        if (!Number.isFinite(n)) return fallback;
        return Math.min(max, Math.max(min, n));
    } catch { return fallback; }
}

function getSnapshotLimits() {
    return {
        maxCount: readSnapshotConfigInt(
            SNAPSHOT_LIMIT_COUNT_KEY, SNAPSHOT_LIMIT_DEFAULT_COUNT,
            SNAPSHOT_LIMIT_MIN_COUNT, SNAPSHOT_LIMIT_MAX_COUNT,
        ),
        maxBytes: readSnapshotConfigInt(
            SNAPSHOT_LIMIT_BYTES_KEY, SNAPSHOT_LIMIT_DEFAULT_BYTES,
            SNAPSHOT_LIMIT_MIN_BYTES, SNAPSHOT_LIMIT_MAX_BYTES,
        ),
    };
}

// Walk newest → oldest; keep within both limits, delete the rest. The most
// recent snapshot is always kept (even if it alone exceeds the byte limit) so
// we never end up with zero backups after a config change.
function trimSnapshotsToLimits() {
    const { maxCount, maxBytes } = getSnapshotLimits();
    // Size each snapshot by its marginal disk cost (chunks not shared with the
    // live blob), not its logical size — chunked snapshots share chunks, so a
    // logical measure would over-trim ones that cost almost nothing on disk.
    const entries = kvList(DB_BACKUP_PREFIX)
        .map((key) => {
            const tsRaw = parseInt(key.slice(DB_BACKUP_PREFIX.length, -4), 10);
            return { key, size: snapshotFootprint(key), ts: Number.isFinite(tsRaw) ? tsRaw : 0 };
        })
        .sort((a, b) => b.ts - a.ts);

    let runningBytes = 0;
    const toDelete = [];
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const isFirst = i === 0;
        const fitsByCount = i < maxCount;
        const fitsByBytes = runningBytes + e.size <= maxBytes;
        if (isFirst || (fitsByCount && fitsByBytes)) {
            runningBytes += e.size;
        } else {
            toDelete.push(e.key);
        }
    }
    for (const key of toDelete) kvDel(key);
    return { kept: entries.length - toDelete.length, removed: toDelete.length };
}

// Current snapshot count + two totals:
//   bytes        — marginal disk cost (snapshotFootprint), the SAME measure the
//                  byte limit/trim uses, so the limit gauge matches what trimming
//                  sees. kvListWithSizes would report a chunked snapshot's marker.
//   logicalBytes — sum of each snapshot's full logical size (kvSize), i.e. what
//                  the snapshots would cost WITHOUT dedup. Drives the "saved by
//                  deduplication" figure; never used for trimming.
function snapshotUsage() {
    const keys = kvList(DB_BACKUP_PREFIX);
    let bytes = 0, logicalBytes = 0;
    for (const k of keys) {
        bytes += snapshotFootprint(k);
        logicalBytes += (kvSize(k) || 0);
    }
    return { count: keys.length, bytes, logicalBytes };
}

function createBackupAndRotate() {
    const now = Date.now();
    if (lastBackupTime && now - lastBackupTime < BACKUP_INTERVAL_MS) {
        return;
    }
    lastBackupTime = now;

    const backupKey = `${DB_BACKUP_PREFIX}${(now / 100).toFixed()}.bin`;
    kvCopyValue('database/database.bin', backupKey);
    trimSnapshotsToLimits();
}

async function flushPendingDb() {
    if (saveTimers[DB_HEX_KEY]) {
        clearTimeout(saveTimers[DB_HEX_KEY]);
        delete saveTimers[DB_HEX_KEY];
        if (dbCache[DB_HEX_KEY]) {
            await persistDbCacheWithChats(DB_HEX_KEY, 'database/database.bin');
        } else if (fullChatStore && fullChatStore.size > 0) {
            // No stripped cache but chat store has data — merge and persist directly
            const raw = kvGet('database/database.bin');
            if (raw) {
                const dbObj = normalizeJSON(await decodeRisuSave(raw));
                const fullDb = reassembleFullDb(stripChatsFromDb(dbObj));
                kvSet('database/database.bin', Buffer.from(encodeRisuSaveLegacy(fullDb)));
            }
        }
        createBackupAndRotate();
    }
}

function invalidateDbCache() {
    delete dbCache[DB_HEX_KEY];
    fullChatStore = null;
    if (saveTimers[DB_HEX_KEY]) {
        clearTimeout(saveTimers[DB_HEX_KEY]);
        delete saveTimers[DB_HEX_KEY];
    }
    dbEtag = null;
}

// ─── Chat runtime lazy load helpers ─────────────────────────────────────────

function assignMissingChatIds(dbObj) {
    let changed = false;
    if (!dbObj?.characters) return changed;
    for (const char of dbObj.characters) {
        if (!char?.chats) continue;
        for (const chat of char.chats) {
            if (!chat || chat._stub || chat.id) continue;
            chat.id = nodeCrypto.randomUUID();
            changed = true;
        }
    }
    return changed;
}

// Recovers chats whose folderId points to a deleted folder. The previous merge
// layer silently kept stale folderId on disk when a user moved a chat out of a
// folder, then later deleting that folder produced orphans invisible in the
// sidebar (rendered into neither the no-folder section nor any folder section).
// Boot-time normalize so historical corruption self-heals; new corruption is
// blocked by the merge fix in mergeChatStubWithFullChat.
function normalizeOrphanFolderIds(dbObj) {
    let changed = false;
    if (!dbObj?.characters) return changed;
    for (const char of dbObj.characters) {
        if (!char?.chats) continue;
        const validIds = new Set((char.chatFolders ?? []).map(f => f?.id).filter(Boolean));
        for (const chat of char.chats) {
            if (!chat) continue;
            if (chat.folderId && !validIds.has(chat.folderId)) {
                chat.folderId = null;
                changed = true;
            }
        }
    }
    return changed;
}

async function decodeDatabaseWithPersistentChatIds(raw, options = {}) {
    const { createBackup = false, migrationResult = null } = options;
    // Convert legacy REMOTE-block layouts to inline format before decoding.
    // If migration ran it overwrote database.bin, so the caller's `raw` is
    // stale and we re-read from KV. Idempotent on the no-op path.
    const migration = await migrateRemoteBlocksIfNeeded();
    if (migration.ran) {
        const fresh = kvGet('database/database.bin');
        if (fresh) raw = fresh;
    }
    const dbObj = normalizeJSON(await decodeRisuSave(raw));
    let needsPersist = false;

    const hadMissingIds = assignMissingChatIds(dbObj);
    if (hadMissingIds) needsPersist = true;

    const hadOrphanFolderIds = normalizeOrphanFolderIds(dbObj);
    if (hadOrphanFolderIds) needsPersist = true;

    // One-time migration: restore upstream cold storage characters to full characters.
    // This runs when upstream data first enters NodeOnly (backup import or save folder copy).
    // After restore, the coldstorage field is removed and the clean DB is persisted.
    // Failed characters are promoted to safe blank characters — their KV data is preserved for manual recovery.
    const coldRestoreResult = restoreColdStorageCharactersInDb(dbObj);
    if (coldRestoreResult.restored > 0 || coldRestoreResult.failed > 0) needsPersist = true;
    if (coldRestoreResult.failed > 0) {
        logger.error(`[ColdStorage] ${coldRestoreResult.failed} character(s) could not be restored and were converted to safe blank characters. Cold storage KV data is preserved.`);
        for (const name of coldRestoreResult.failedNames) {
            logger.error(`[ColdStorage]   - "${name}"`);
        }
    }

    if (needsPersist) {
        kvSet('database/database.bin', Buffer.from(encodeRisuSaveLegacy(dbObj)));
        if (createBackup) {
            createBackupAndRotate();
        }
    }
    if (migrationResult) {
        migrationResult.coldStorageFailed = coldRestoreResult.failed;
    }
    return dbObj;
}

/**
 * Convert a full chat to a stub (metadata only).
 *
 * Hybrid corruption guard: a chat carrying `_stub: true` AND a real `message`
 * array is the v1.4.x legacy hybrid pattern. The fast-path "if _stub return"
 * would propagate the corruption (server reassemble skips merge for _stub
 * chats with no fullChat lookup match). Treat hybrids as real chats and
 * collapse them to a real stub here.
 */
function chatToStub(chat) {
    if (!chat) return chat;
    if (chat._stub && !Array.isArray(chat.message)) return chat;
    const stub = {
        id: chat.id || '',
        name: chat.name ?? '',
        _stub: true,
    };
    // Preserve key presence even when the value is null/undefined so the
    // round-trip distinguishes "user cleared" from "field absent". See
    // mergeChatStubWithFullChat — it relies on `in` semantics.
    if ('lastDate' in chat) stub.lastDate = chat.lastDate;
    if ('folderId' in chat) stub.folderId = chat.folderId;
    if ('modules' in chat) stub.modules = chat.modules;
    return stub;
}

/**
 * Initialize fullChatStore from a decoded full database object.
 * Extracts all chat payloads into the store keyed by chaId → chatId.
 *
 * Hybrid corruption recovery: a chat with both `_stub: true` and a real
 * message array is treated as a real chat (its fullChat data is intact).
 * Strip the `_stub` flag in place so subsequent reassemble passes don't
 * reproduce the hybrid on disk.
 */
function initChatStore(dbObj) {
    fullChatStore = new Map();
    if (!dbObj?.characters) return;
    for (const char of dbObj.characters) {
        if (!char?.chaId || !char.chats) continue;
        const charChats = new Map();
        for (const chat of char.chats) {
            if (!chat) continue;
            const isStub = chat._stub === true;
            const hasMessage = Array.isArray(chat.message);
            // Real stub (no payload) — fullChatStore tracks payloads only.
            if (isStub && !hasMessage) continue;
            // Hybrid: strip the corrupt _stub flag, keep the real chat.
            if (isStub && hasMessage) {
                delete chat._stub;
            }
            if (!chat.id) {
                chat.id = nodeCrypto.randomUUID();
            }
            charChats.set(chat.id, chat);
        }
        if (charChats.size > 0) {
            fullChatStore.set(char.chaId, charChats);
        }
    }
}

/**
 * Strip full chat data from a decoded database object, replacing with stubs.
 * Returns a new object — does not mutate input.
 */
function stripChatsFromDb(dbObj) {
    if (!dbObj?.characters) return dbObj;
    const stripped = { ...dbObj };
    stripped.characters = dbObj.characters.map(char => {
        if (!char?.chats) return char;
        return { ...char, chats: char.chats.map(chatToStub) };
    });
    return stripped;
}

/**
 * Reassemble a full database from a stripped DB + fullChatStore.
 * Replaces stubs with full chats from the store. Returns a new object.
 */
function mergeChatStubWithFullChat(stub, fullChat) {
    if (!fullChat) {
        return stub;
    }
    if (!stub || !stub._stub) {
        return fullChat;
    }
    const merged = {
        ...fullChat,
        id: stub.id || fullChat.id || '',
        name: stub.name,
    };
    // Defensive: never let `_stub: true` ride along on a merged chat. If
    // fullChat carries a stale flag (legacy disk corruption), the spread
    // would propagate the hybrid pattern back to disk and re-trigger the
    // chat-data loss path on next round-trip.
    if ('_stub' in merged) delete merged._stub;
    // Use key presence (`in`) so an explicit null/undefined from the client —
    // meaning "user cleared this field" — overwrites fullChat. The previous
    // `!= null` check conflated "cleared" with "absent" and silently kept
    // stale folderId / modules on disk, producing orphan-folder chats.
    if ('lastDate' in stub) merged.lastDate = stub.lastDate;
    if ('folderId' in stub) merged.folderId = stub.folderId;
    if ('modules' in stub) merged.modules = stub.modules;
    return merged;
}

function reassembleFullDb(strippedDb) {
    if (!strippedDb?.characters || !fullChatStore) return strippedDb;
    const full = { ...strippedDb };
    full.characters = strippedDb.characters.map(char => {
        if (!char?.chaId || !char.chats) return char;
        const charChats = fullChatStore.get(char.chaId);
        if (!charChats) return char;
        return {
            ...char,
            chats: char.chats.map(chat => {
                if (chat && chat._stub && chat.id) {
                    return mergeChatStubWithFullChat(chat, charChats.get(chat.id));
                }
                return chat;
            }),
        };
    });
    return full;
}

// ─── Remote-block migration ─────────────────────────────────────────────────
//
// Background: upstream RisuAI (and very early NodeOnly versions) split each
// character's data out of database.bin into a separate `remotes/<chaId>.local.bin`
// file. The main database.bin then carries a REMOTE pointer block instead of the
// character payload. The server-side RisuSaveDecoder used to skip those blocks
// outright, so any decode pass — /api/read, /api/chat-content fallback, chat
// store init — saw the character as missing and lost its chats.
//
// NodeOnly never wanted this split (`disableRemoteSaving` is hardcoded to
// true), so we one-shot convert any leftover REMOTE blocks to inline raw blocks
// the first time a server with such data boots. The reencoded database.bin is
// stored in legacy msgpack format, which has no block structure at all — so
// the REMOTE code path becomes unreachable for future decodes.
//
// Idempotent via a KV marker. The marker lives in KV (not on disk) so a backup
// import — which wipes most KV prefixes and INSERTs a new database.bin — naturally
// clears it, letting the new contents be re-evaluated.

const REMOTE_MIGRATION_MARKER_KEY = 'migration/disable-remote-saving';
const REMOTE_MIGRATION_MARKER_VALUE = Buffer.from('done', 'utf-8');

function isRemoteMigrationDone() {
    const value = kvGet(REMOTE_MIGRATION_MARKER_KEY);
    return value !== null && value.length > 0;
}

function markRemoteMigrationDone() {
    kvSet(REMOTE_MIGRATION_MARKER_KEY, REMOTE_MIGRATION_MARKER_VALUE);
}

/**
 * Convert any leftover REMOTE blocks in database.bin into inline raw blocks.
 * Safe to call repeatedly: idempotent via KV marker.
 */
async function migrateRemoteBlocksIfNeeded() {
    if (isRemoteMigrationDone()) return { ran: false, reason: 'already-done' };

    const raw = kvGet('database/database.bin');
    if (!raw) {
        markRemoteMigrationDone();
        return { ran: false, reason: 'no-database' };
    }

    if (!hasRemoteBlocks(raw)) {
        markRemoteMigrationDone();
        return { ran: false, reason: 'no-remote-blocks' };
    }

    logger.info('[Migration] REMOTE blocks detected in database.bin; converting to inline format');

    // Pre-migration backup so a botched migration can be rolled back manually.
    // Use a dedicated prefix — `database/dbbackup-` is on a 20-snapshot rotation
    // whose timestamp parser would assign this entry ts=0 (because of the
    // non-numeric suffix), making it the first to evict. The migration safety
    // net must outlive ordinary backup churn.
    const backupKey = `migration-backup/pre-remote-fix-${Date.now()}.bin`;
    kvCopyValue('database/database.bin', backupKey);

    const dbObj = await decodeRisuSave(raw, {
        resolveRemote: async (name) => {
            const value = kvGet(`remotes/${name}.local.bin`);
            return value || null;
        },
    });

    const reEncoded = encodeRisuSaveLegacy(dbObj, 'compression');

    // Single transaction so swap + marker move together.
    // remotes/ files are intentionally NOT deleted here: pre-migration
    // dbbackup-* snapshots and the migration-backup we just wrote both
    // only carry database.bin (kvCopyValue is single-key). If a user later
    // restores one of those snapshots — which holds REMOTE pointers —
    // resolveRemote needs the remotes/<id>.local.bin payloads to still
    // exist, otherwise every REMOTE-pointed character drops on the next
    // decode and the backup is effectively dead. The orphans don't grow
    // (NodeOnly's disableRemoteSaving = true on writes), so leaving them
    // costs a few MB of disk for full backup recoverability.
    sqliteDb.transaction(() => {
        kvSet('database/database.bin', Buffer.from(reEncoded));
        markRemoteMigrationDone();
    })();

    // Reset in-memory caches whose contents were derived from the pre-migration
    // bytes — next reader recomputes from the migrated database.bin.
    invalidateDbCache();
    dbEtag = null;

    const characterCount = Array.isArray(dbObj.characters) ? dbObj.characters.length : 0;
    logger.info(`[Migration] Remote-block migration complete. Inlined ${characterCount} character(s); pre-migration backup at ${backupKey}`);
    return { ran: true, characterCount, backupKey };
}

/**
 * Ensure fullChatStore is initialized. Loads from disk if needed.
 */
async function ensureChatStore() {
    if (fullChatStore) return;
    // Run remote-block migration first so the decode below sees an inline DB.
    // Idempotent — skipped on every subsequent call.
    await migrateRemoteBlocksIfNeeded();
    const raw = kvGet('database/database.bin');
    if (!raw) {
        fullChatStore = new Map();
        return;
    }
    const dbObj = await decodeDatabaseWithPersistentChatIds(raw, {
        createBackup: true,
    });
    initChatStore(dbObj);
}

// Stub metadata fields a JSON Patch may legitimately touch on a `chats[i]`
// entry. Anything else is a chat-internal field — those live in fullChatStore,
// not in dbCache, and should never appear in a /api/patch payload. Keep in
// sync with chatToStub on both server and client.
const STUB_METADATA_FIELDS = new Set(['id', 'name', '_stub', 'lastDate', 'folderId', 'modules']);

// Only add/replace/remove are produced by the legitimate patcher. move/copy
// could alias _stub or other chat-internal fields through `from`, bypassing
// the path-based field allowlist. Reject those op types outright on chat
// paths. test ops can also reveal/manipulate state; deny for symmetry.
const ALLOWED_CHAT_OP_TYPES = new Set(['add', 'replace', 'remove']);

const CHAT_FIELD_PATH_RE = /^\/characters\/\d+\/chats\/\d+\/([^/]+)/;

/**
 * Detect JSON Patch ops that mutate chat-internal fields (anything beyond
 * STUB_METADATA_FIELDS). Such ops are the loss vector: applying them to
 * dbCache leaves a metadata-only chat without `_stub`, which then bypasses
 * fullChat merge in reassembleFullDb and gets persisted as-is.
 *
 * Whole-chat ops (path = `/characters/N/chats/M` or `/characters/N/chats`)
 * are allowed — those replace/add/remove chat slots wholesale and the
 * reassemble guard takes care of validating the resulting state.
 *
 * The `_stub` field gets stricter treatment than other allowed fields: only
 * `add`/`replace` with literal value `true` is permitted. Any op that could
 * remove the flag or set it to a falsy value is itself the loss mechanism
 * (reassembleFullDb skips merge when `_stub` is falsy), so it must be
 * blocked at the patch boundary, not just at the persist boundary.
 *
 * `move`/`copy` ops are rejected wholesale on chat-internal paths because
 * the field-name allowlist on `path` alone can't catch a `from` that points
 * at `_stub` or another chat-internal field. Both `path` and `from` are
 * checked when present.
 */
function findChatInternalFieldOps(patch) {
    if (!Array.isArray(patch)) return [];
    const violations = [];
    for (const op of patch) {
        if (!op || typeof op !== 'object' || typeof op.path !== 'string') continue;

        const pathMatch = op.path.match(CHAT_FIELD_PATH_RE);
        const fromMatch = typeof op.from === 'string' ? op.from.match(CHAT_FIELD_PATH_RE) : null;
        if (!pathMatch && !fromMatch) continue;

        if (!ALLOWED_CHAT_OP_TYPES.has(op.op)) {
            violations.push({
                op: op.op,
                path: op.path,
                field: (pathMatch && pathMatch[1]) || (fromMatch && fromMatch[1]) || '',
                reason: 'disallowed op type on chat field',
            });
            continue;
        }

        if (pathMatch) {
            const field = pathMatch[1];
            if (!STUB_METADATA_FIELDS.has(field)) {
                violations.push({ op: op.op, path: op.path, field });
                continue;
            }
            if (field === '_stub') {
                if (op.op === 'remove') {
                    violations.push({ op: op.op, path: op.path, field, reason: 'remove _stub' });
                } else if ((op.op === 'add' || op.op === 'replace') && op.value !== true) {
                    violations.push({ op: op.op, path: op.path, field, reason: 'non-true _stub value' });
                }
            }
        }
    }
    return violations;
}

/**
 * Detect chats that lost their `_stub` flag without being upgraded to a real
 * Chat. reassembleFullDb skips merge when `_stub` is falsy, so persisting such
 * a chat would write metadata-only to disk and silently strip messages — the
 * exact data-loss path reported with PATCH `remove /chats/N/{message,...}` ops.
 *
 * A real Chat has `message` (Array). A real stub has `_stub === true`. Anything
 * with neither is a malformed in-between state; treat as a corruption signal.
 */
function findStubFlagLossChats(fullDb) {
    if (!fullDb?.characters) return [];
    const losses = [];
    for (let ci = 0; ci < fullDb.characters.length; ci++) {
        const char = fullDb.characters[ci];
        if (!char?.chats) continue;
        for (let chi = 0; chi < char.chats.length; chi++) {
            const chat = char.chats[chi];
            if (!chat || typeof chat !== 'object') continue;
            const isStub = chat._stub === true;
            const hasMessage = Array.isArray(chat.message);
            if (!isStub && !hasMessage) {
                losses.push({
                    chaId: char.chaId,
                    charIndex: ci,
                    chatIndex: chi,
                    chatId: chat.id || null,
                });
            }
        }
    }
    return losses;
}

/**
 * Persist dbCache to disk with full chats merged back in.
 */
async function persistDbCacheWithChats(filePath, decodedKey) {
    const strippedDb = dbCache[filePath];
    if (!strippedDb) return;
    await ensureChatStore();
    const fullDb = reassembleFullDb(strippedDb);

    // Disk protection guard: abort persist when reassemble produced metadata-only
    // chats. Writing them would lock the loss in (next /api/read returns the
    // stripped chat with no `_stub`, so hydration never re-merges fullChatStore).
    // Invalidate dbCache so the next request re-reads from disk and rebuilds a
    // consistent stub view; client receives 409 on next /api/patch via hash mismatch.
    if (decodedKey === 'database/database.bin') {
        const losses = findStubFlagLossChats(fullDb);
        if (losses.length > 0) {
            const sample = losses.slice(0, 3).map(l => `${l.chaId}/${l.chatId ?? l.chatIndex}`).join(', ');
            const err = new Error(
                `persist aborted: ${losses.length} chat(s) lost _stub flag without upgrade — `
                + `would silently strip messages on disk. sample=[${sample}]`
            );
            recordPersistFailure(err, 'persistDbCacheWithChats:stub-flag-loss');
            delete dbCache[filePath];
            throw err;
        }
    }

    const data = Buffer.from(encodeRisuSaveLegacy(fullDb));
    try {
        kvSet(decodedKey, data);
    } catch (err) {
        // Tag with BLOB size so the visibility layer can surface it to the user.
        // The dominant failure mode (better-sqlite3 INT_MAX) is size-driven.
        if (err && typeof err === 'object') {
            try { err.attemptedSize = data.length; } catch {}
        }
        throw err;
    }
    // Refresh fullChatStore from the persisted snapshot so subsequent
    // /api/chat-content GETs return the same metadata (folderId, modules)
    // that just hit disk. Without this, PATCH-only clears of stub fields
    // leave fullChatStore holding stale fullChat objects, and hydration
    // would resurrect the cleared values until the next /api/read.
    if (decodedKey === 'database/database.bin') {
        initChatStore(fullDb);
    }
}

function shouldCompress(req, res) {
    // Proxy/hub-proxy: pass through external responses without compression.
    // Original upstream server has no compression middleware at all,
    // so proxy responses were never compressed in the first place.
    const url = req.originalUrl || req.url;
    if (url.startsWith('/proxy') || url.startsWith('/hub-proxy') || url.startsWith('/api/backup/export') || url.startsWith('/api/backup/server/download/')) {
        return false;
    }

    const contentType = String(res.getHeader('Content-Type') || '').toLowerCase();
    if (contentType.includes('text/event-stream')) {
        return false;
    }
    // NDJSON endpoints (backup import/restore, inlay bulk compression) emit
    // small per-line events and rely on real-time flushes — keepalive
    // heartbeats in particular must reach reverse proxies before their
    // response timeout fires. gzip would buffer those lines until enough
    // bytes accumulated for an efficient compression block, defeating the
    // 502-avoidance the streaming endpoints were built for. compressible's
    // mime-db happens not to list application/x-ndjson today (so this is
    // a no-op in practice) but a future dep upgrade could flip it on.
    if (contentType.includes('application/x-ndjson')) {
        return false;
    }
    // Already-compressed media formats: gzip adds CPU cost with ~0% size gain
    if (contentType.startsWith('image/') || contentType.startsWith('video/') || contentType.startsWith('audio/')) {
        return false;
    }
    if (contentType.includes('application/octet-stream')) {
        return true;
    }
    return compression.filter(req, res);
}

app.use(compression({
    filter: shouldCompress,
}));
// Vite 산출물은 해시 파일명이므로 /assets는 장기 캐시 안전
app.use('/assets', express.static(path.join(process.cwd(), 'dist/assets'), {
    maxAge: '1y',
    immutable: true,
}));
app.use(express.static(path.join(process.cwd(), 'dist'), {index: false, maxAge: 0}));
app.use(express.json({ limit: '100mb' }));
app.use((req, res, next) => {
    // Skip express.raw() for backup import — it must stream, not buffer into memory
    if (req.path === '/api/backup/import') return next();
    return express.raw({ type: 'application/octet-stream', limit: '2gb' })(req, res, next);
});
app.use(express.text({ limit: '100mb' }));
const {pipeline} = require('stream/promises')
const sslPath = path.join(process.cwd(), 'server/node/ssl/certificate');
const hubURL = 'https://sv.risuai.xyz';

let password = ''

// Ensure /save/ exists for password file and migration source
const savePath = path.join(process.cwd(), "save")
if(!existsSync(savePath)){
    mkdirSync(savePath)
}

// Server-side backup directory (outside save/ to avoid bloating updater copies).
// Configurable at runtime via the kv key `config/server-backup-path`. When the
// user changes the path the old directory is left in place (existing backups
// stay where they were); only future backups land at the new path.
const DEFAULT_BACKUPS_DIR = path.join(process.cwd(), "backups");
const BACKUP_PATH_CONFIG_KEY = 'config/server-backup-path';
const MANAGED_BACKUP_PATH_ROOTS = new Set(['server', 'dist', 'scripts', 'bin', 'node_modules', '.update-tmp']);
// Plaintext marker the updater reads to preserve a custom in-tree backup dir
// during in-place updates. KV lives inside the SQLite DB so the updater (which
// runs without npm deps) can't read it; this marker bridges that gap.
const BACKUP_PATH_MARKER = path.join(savePath, '__backup_path');

function readBackupsDirConfig() {
    try {
        const raw = kvGet(BACKUP_PATH_CONFIG_KEY);
        if (!raw) return DEFAULT_BACKUPS_DIR;
        const text = Buffer.from(raw).toString('utf-8').trim();
        return text || DEFAULT_BACKUPS_DIR;
    } catch { return DEFAULT_BACKUPS_DIR; }
}

function writeBackupPathMarker(absPath) {
    try {
        require('fs').writeFileSync(BACKUP_PATH_MARKER, absPath, 'utf-8');
    } catch {
        // Best-effort; marker absence only means the updater falls back to the
        // hard-coded `backups` keep — same as before this feature existed.
    }
}

function isManagedBackupPath(absPath) {
    const rel = path.relative(process.cwd(), absPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
    if (!rel) return true;
    return MANAGED_BACKUP_PATH_ROOTS.has(rel.split(path.sep)[0]);
}

let backupsDir = readBackupsDirConfig();
if(!existsSync(backupsDir)){
    try { mkdirSync(backupsDir, { recursive: true }); }
    catch { backupsDir = DEFAULT_BACKUPS_DIR; mkdirSync(backupsDir, { recursive: true }); }
}
writeBackupPathMarker(backupsDir);
const BACKUP_FILENAME_REGEX = /^risu-backup-\d+\.bin$/;

const passwordPath = path.join(process.cwd(), 'save', '__password')
if(existsSync(passwordPath)){
    password = readFileSync(passwordPath, 'utf-8')
}

// ── NodeOnly: server-side JWT (HMAC-SHA256) ─────────────────────────────────
// Upstream uses client-side ECDSA JWT via crypto.subtle, which requires
// Secure Context (HTTPS or localhost). NodeOnly needs HTTP remote access,
// so we moved JWT signing/verification to the server using HMAC-SHA256.
// If upstream changes its auth flow, this section needs manual sync.
// Related: createServerJwt(), checkAuth(), /api/login, /api/token/refresh
const jwtSecretPath = path.join(savePath, '__jwt_secret')
let jwtSecret
if (existsSync(jwtSecretPath)) {
    jwtSecret = readFileSync(jwtSecretPath, 'utf-8').trim()
} else {
    jwtSecret = nodeCrypto.randomBytes(64).toString('hex')
    writeFileSync(jwtSecretPath, jwtSecret, 'utf-8')
}

// ── Instance ID for anonymous usage analytics ────────────────────────────────
const instanceIdPath = path.join(savePath, '__instance_id')
let instanceId
if (existsSync(instanceIdPath)) {
    instanceId = readFileSync(instanceIdPath, 'utf-8').trim()
} else {
    instanceId = nodeCrypto.randomUUID()
    writeFileSync(instanceIdPath, instanceId, 'utf-8')
}

const authCodePath = path.join(process.cwd(), 'save', '__authcode')
const inlayDir = path.join(savePath, 'inlays')
const inlayMigrationMarker = path.join(inlayDir, '.migrated_to_fs')
const hexRegex = /^[0-9a-fA-F]+$/;
const BACKUP_IMPORT_MAX_BYTES = Number(process.env.RISU_BACKUP_IMPORT_MAX_BYTES ?? '0');
const BACKUP_ENTRY_NAME_MAX_BYTES = 1024;
// Minimum free disk space headroom multiplier: require 2× the backup size to be free
const BACKUP_DISK_HEADROOM = 2;
// Heartbeat interval for NDJSON import progress stream. 5 s by default —
// shorter than every common reverse-proxy response timeout (nginx 60 s, Cloudflare
// 100 s). Operators behind more aggressive proxies can tighten this. Clamped to
// 100 ms so a misconfiguration can't spam the socket.
const BACKUP_NDJSON_HEARTBEAT_MS = Math.max(
    100,
    Number(process.env.BACKUP_NDJSON_HEARTBEAT_MS ?? '5000') || 5000,
);

let importInProgress = false;

// ── Cloudflare Quick Tunnel ─────────────────────────────────────────────────
const TUNNEL_DISABLED = process.env.RISU_TUNNEL_DISABLED === 'true';
let tunnelProcess = null;
let tunnelUrl = null;
let tunnelStatus = 'off';   // 'off' | 'downloading' | 'starting' | 'running' | 'error'
let tunnelError = null;
let tunnelStartTimeout = null;

const CLOUDFLARED_ASSETS = {
    'darwin-arm64':  { url: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz', type: 'tgz' },
    'darwin-x64':    { url: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz', type: 'tgz' },
    'linux-x64':     { url: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64', type: 'bin' },
    'linux-arm64':   { url: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64', type: 'bin' },
    // Termux reports process.platform === 'android' but the linux-arm64
    // cloudflared binary (statically linked Go) runs cleanly on Bionic.
    'android-arm64': { url: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64', type: 'bin' },
    'win32-x64':     { url: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe', type: 'bin' },
};

function findCloudflaredBinary() {
    const ext = process.platform === 'win32' ? '.exe' : '';
    const bundled = path.join(process.cwd(), 'bin', 'cloudflared' + ext);
    if (existsSync(bundled)) return bundled;
    try {
        execSync(process.platform === 'win32' ? 'where cloudflared' : 'which cloudflared', { stdio: 'pipe' });
        return 'cloudflared';
    } catch {
        return null;
    }
}

function followRedirects(url) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? require('https') : require('http');
        mod.get(url, { headers: { 'User-Agent': 'pocketrisu' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                followRedirects(res.headers.location).then(resolve, reject);
            } else if (res.statusCode === 200) {
                resolve(res);
            } else {
                reject(new Error(`HTTP ${res.statusCode}`));
            }
        }).on('error', reject);
    });
}

async function downloadCloudflared() {
    const key = `${process.platform}-${process.arch}`;
    const asset = CLOUDFLARED_ASSETS[key];
    if (!asset) throw new Error(`Unsupported platform: ${key}`);

    const ext = process.platform === 'win32' ? '.exe' : '';
    const binDir = path.join(process.cwd(), 'bin');
    const dest = path.join(binDir, 'cloudflared' + ext);

    if (!existsSync(binDir)) require('fs').mkdirSync(binDir, { recursive: true });

    console.log(`[Tunnel] Downloading cloudflared for ${key}...`);
    const res = await followRedirects(asset.url);

    if (asset.type === 'tgz') {
        const tmpPath = path.join(binDir, '_cloudflared.tgz');
        await new Promise((resolve, reject) => {
            const ws = require('fs').createWriteStream(tmpPath);
            res.pipe(ws);
            ws.on('finish', () => { ws.close(); resolve(); });
            ws.on('error', reject);
        });
        execSync(`tar -xzf "${tmpPath}" -C "${binDir}"`, { stdio: 'pipe' });
        require('fs').unlinkSync(tmpPath);
    } else {
        await new Promise((resolve, reject) => {
            const ws = require('fs').createWriteStream(dest);
            res.pipe(ws);
            ws.on('finish', () => { ws.close(); resolve(); });
            ws.on('error', reject);
        });
    }

    if (process.platform !== 'win32') require('fs').chmodSync(dest, 0o755);
    console.log('[Tunnel] cloudflared downloaded successfully.');
    return dest;
}

function stopTunnel() {
    if (tunnelStartTimeout) { clearTimeout(tunnelStartTimeout); tunnelStartTimeout = null; }
    if (tunnelProcess) {
        try { tunnelProcess.kill('SIGTERM'); } catch {}
        tunnelProcess = null;
    }
    tunnelUrl = null;
    tunnelStatus = 'off';
    tunnelError = null;
}

// ── Update check ─────────────────────────────────────────────────────────────
const UPDATE_CHECK_DISABLED = process.env.RISU_UPDATE_CHECK === 'false';
const UPDATE_CHECK_URL = process.env.RISU_UPDATE_URL || 'https://risu-update-worker.nodridan.workers.dev/check';
const PUBLIC_STATS_URL = (process.env.RISU_UPDATE_URL || 'https://risu-update-worker.nodridan.workers.dev/check').replace(/\/check$/, '/api/public-stats');

// Re-read on each call so non-portable updates (docker/git pull) without a
// process restart don't keep reporting the old version to the update worker.
function getCurrentVersion() {
    try {
        const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));
        return pkg.version || '0.0.0';
    } catch { return '0.0.0'; }
}

// ── Deployment type & self-update helpers ─────────────────────────────────────
const GITHUB_REPO = 'PocketRisu/PocketRisu';

const deploymentType = (() => {
    // Only portable builds have the .portable marker (created by CI release workflow).
    // Self-update is gated on this — all other types are inferred for analytics only.
    // Wrapped in try/catch so unexpected filesystem errors can't crash server boot.
    try {
        if (existsSync(path.join(process.cwd(), '.portable'))) return 'portable';
        if (existsSync(path.join(process.cwd(), '.git'))) return 'git';
        if (existsSync('/.dockerenv')) return 'docker';
        try {
            const cgroup = readFileSync('/proc/1/cgroup', 'utf-8');
            if (cgroup.includes('docker') || cgroup.includes('containerd')) return 'docker';
        } catch {}
        if (process.platform === 'android') return 'termux';
    } catch {}
    return 'unknown';
})();

function getSelfUpdateAssetInfo(version) {
    const platformMap = { win32: 'win', linux: 'linux', darwin: 'macos' };
    const platformName = platformMap[process.platform];
    if (!platformName) return null;
    const arch = process.arch; // x64, arm64
    const ext = process.platform === 'win32' ? 'zip' : 'tar.gz';
    const filename = `PocketRisu-v${version}-${platformName}-${arch}.${ext}`;
    const url = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/${filename}`;
    return { platformName, arch, ext, filename, url };
}

function isSafeInlayId(id) {
    return typeof id === 'string' &&
        id.length > 0 &&
        !id.includes('\0') &&
        !id.includes('/') &&
        !id.includes('\\') &&
        id !== '.' &&
        id !== '..';
}

function normalizeInlayExt(ext) {
    if (typeof ext !== 'string') return 'bin';
    const normalized = ext.trim().toLowerCase().replace(/^\.+/, '').replace(/[\/\\\0]/g, '');
    return normalized || 'bin';
}

const resolvedInlayDir = path.resolve(inlayDir) + path.sep;

function assertInsideInlayDir(filePath) {
    if (!path.resolve(filePath).startsWith(resolvedInlayDir)) {
        throw new Error(`Path escapes inlay directory: ${filePath}`);
    }
}

function getInlayFilePath(id, ext) {
    if (!isSafeInlayId(id)) throw new Error(`Invalid inlay id: ${id}`);
    const p = path.join(inlayDir, `${id}.${normalizeInlayExt(ext)}`);
    assertInsideInlayDir(p);
    return p;
}

function getInlaySidecarPath(id) {
    if (!isSafeInlayId(id)) throw new Error(`Invalid inlay id: ${id}`);
    const p = path.join(inlayDir, `${id}.meta.json`);
    assertInsideInlayDir(p);
    return p;
}

async function ensureInlayDir() {
    await fs.mkdir(inlayDir, { recursive: true });
}

function ensureInlayDirSync() {
    if (!existsSync(inlayDir)) {
        mkdirSync(inlayDir, { recursive: true });
    }
}

function getMimeFromExt(ext, buffer) {
    return ASSET_EXT_MIME[normalizeInlayExt(ext)] || detectMime(buffer);
}

function decodeDataUri(dataUri) {
    if (typeof dataUri !== 'string' || !dataUri.startsWith('data:')) {
        throw new Error('Invalid data URI');
    }
    const commaIdx = dataUri.indexOf(',');
    if (commaIdx === -1) {
        throw new Error('Malformed data URI');
    }
    const meta = dataUri.substring(5, commaIdx);
    return {
        buffer: Buffer.from(dataUri.substring(commaIdx + 1), 'base64'),
        mime: meta.split(';')[0] || 'application/octet-stream',
    };
}

function encodeDataUri(buffer, mime) {
    return `data:${mime || 'application/octet-stream'};base64,${Buffer.from(buffer).toString('base64')}`;
}

async function readInlaySidecar(id) {
    try {
        const raw = await fs.readFile(getInlaySidecarPath(id), 'utf-8');
        const parsed = JSON.parse(raw);
        return {
            ext: normalizeInlayExt(parsed?.ext),
            name: typeof parsed?.name === 'string' ? parsed.name : id,
            type: typeof parsed?.type === 'string' ? parsed.type : 'image',
            height: typeof parsed?.height === 'number' ? parsed.height : undefined,
            width: typeof parsed?.width === 'number' ? parsed.width : undefined,
        };
    } catch {
        return null;
    }
}

async function resolveInlayFilePath(id) {
    if (!isSafeInlayId(id)) return null;
    const sidecar = await readInlaySidecar(id);
    if (sidecar) {
        const candidate = getInlayFilePath(id, sidecar.ext);
        try { await fs.access(candidate); return candidate; } catch {}
    }
    // Fallback: scan directory (covers pre-sidecar files or mismatched ext)
    try {
        const entries = await fs.readdir(inlayDir, { withFileTypes: true });
        const match = entries.find((entry) => (
            entry.isFile() &&
            entry.name.startsWith(`${id}.`) &&
            entry.name !== `${id}.meta.json`
        ));
        return match ? path.join(inlayDir, match.name) : null;
    } catch {
        return null;
    }
}

function resolveInlayFilePathSync(id) {
    if (!isSafeInlayId(id)) return null;
    try {
        const raw = readFileSync(getInlaySidecarPath(id), 'utf-8');
        const parsed = JSON.parse(raw);
        const ext = normalizeInlayExt(parsed?.ext);
        const candidate = getInlayFilePath(id, ext);
        if (existsSync(candidate)) return candidate;
    } catch {}
    // Fallback: scan directory
    try {
        const entries = readdirSync(inlayDir, { withFileTypes: true });
        const match = entries.find((entry) => (
            entry.isFile() &&
            entry.name.startsWith(`${id}.`) &&
            entry.name !== `${id}.meta.json`
        ));
        return match ? path.join(inlayDir, match.name) : null;
    } catch {
        return null;
    }
}

async function readInlayFile(id) {
    const filePath = await resolveInlayFilePath(id);
    if (!filePath) return null;
    const ext = normalizeInlayExt(path.extname(filePath).slice(1));
    const buffer = await fs.readFile(filePath);
    const stat = await fs.stat(filePath);
    return {
        buffer,
        ext,
        filePath,
        mtimeMs: stat.mtimeMs,
        mime: getMimeFromExt(ext, buffer),
    };
}

async function writeInlaySidecar(id, info) {
    await ensureInlayDir();
    const sidecar = {
        ext: normalizeInlayExt(info?.ext),
        name: typeof info?.name === 'string' ? info.name : id,
        type: typeof info?.type === 'string' ? info.type : 'image',
        height: typeof info?.height === 'number' ? info.height : undefined,
        width: typeof info?.width === 'number' ? info.width : undefined,
    };
    await fs.writeFile(getInlaySidecarPath(id), JSON.stringify(sidecar));
}

function writeInlaySidecarSync(id, info) {
    ensureInlayDirSync();
    const sidecar = {
        ext: normalizeInlayExt(info?.ext),
        name: typeof info?.name === 'string' ? info.name : id,
        type: typeof info?.type === 'string' ? info.type : 'image',
        height: typeof info?.height === 'number' ? info.height : undefined,
        width: typeof info?.width === 'number' ? info.width : undefined,
    };
    writeFileSync(getInlaySidecarPath(id), JSON.stringify(sidecar));
}

async function writeInlayFile(id, ext, buffer, info = null) {
    await ensureInlayDir();
    await deleteInlayRawFile(id);
    const normalizedExt = normalizeInlayExt(ext);
    await fs.writeFile(getInlayFilePath(id, normalizedExt), Buffer.from(buffer));
    await writeInlaySidecar(id, {
        ...(info || {}),
        ext: normalizedExt,
    });
}

function writeInlayFileSync(id, ext, buffer, info = null) {
    ensureInlayDirSync();
    deleteInlayRawFileSync(id);
    const normalizedExt = normalizeInlayExt(ext);
    writeFileSync(getInlayFilePath(id, normalizedExt), Buffer.from(buffer));
    writeInlaySidecarSync(id, {
        ...(info || {}),
        ext: normalizedExt,
    });
}

async function deleteInlayRawFile(id) {
    const filePath = await resolveInlayFilePath(id);
    if (!filePath) return;
    await fs.unlink(filePath).catch(() => {});
}

function deleteInlayRawFileSync(id) {
    const filePath = resolveInlayFilePathSync(id);
    if (!filePath) return;
    try {
        unlinkSync(filePath);
    } catch {
        // ignore
    }
}

async function deleteInlayFile(id) {
    await deleteInlayRawFile(id);
    await fs.unlink(getInlaySidecarPath(id)).catch(() => {});
}

function deleteInlayFileSync(id) {
    deleteInlayRawFileSync(id);
    try {
        unlinkSync(getInlaySidecarPath(id));
    } catch {
        // ignore
    }
}

async function listInlayFiles() {
    await ensureInlayDir();
    const entries = await fs.readdir(inlayDir, { withFileTypes: true });
    return entries
        .filter((entry) => (
            entry.isFile() &&
            entry.name !== '.migrated_to_fs' &&
            !entry.name.endsWith('.meta.json')
        ))
        .map((entry) => {
            const ext = normalizeInlayExt(path.extname(entry.name).slice(1));
            const id = entry.name.slice(0, -(ext.length + 1));
            return { id, ext, filePath: path.join(inlayDir, entry.name) };
        })
        .filter((entry) => isSafeInlayId(entry.id));
}

async function readInlayLegacyInfo(id) {
    const value = kvGet(`inlay_info/${id}`);
    if (!value) return null;
    try {
        const parsed = JSON.parse(value.toString('utf-8'));
        return {
            ext: normalizeInlayExt(parsed?.ext),
            name: typeof parsed?.name === 'string' ? parsed.name : id,
            type: typeof parsed?.type === 'string' ? parsed.type : 'image',
            height: typeof parsed?.height === 'number' ? parsed.height : undefined,
            width: typeof parsed?.width === 'number' ? parsed.width : undefined,
        };
    } catch {
        return null;
    }
}

async function readInlayInfoPayload(id) {
    const sidecar = await readInlaySidecar(id);
    if (sidecar) return Buffer.from(JSON.stringify(sidecar));
    const legacy = await readInlayLegacyInfo(id);
    if (legacy) return Buffer.from(JSON.stringify(legacy));
    return kvGet(`inlay_info/${id}`);
}

async function readInlayAssetPayload(id) {
    const file = await readInlayFile(id);
    if (!file) return null;
    const sidecar = (await readInlaySidecar(id)) || (await readInlayLegacyInfo(id));
    const info = {
        ext: sidecar?.ext || file.ext,
        name: sidecar?.name || id,
        type: sidecar?.type || 'image',
        height: sidecar?.height,
        width: sidecar?.width,
    };
    const data = info.type === 'signature'
        ? file.buffer.toString('utf-8')
        : encodeDataUri(file.buffer, file.mime);
    return Buffer.from(JSON.stringify({
        ...info,
        data,
    }));
}

async function migrateInlaysToFilesystem() {
    await ensureInlayDir();
    if (existsSync(inlayMigrationMarker)) return;

    const keys = kvList('inlay/');
    for (const key of keys) {
        const id = key.slice('inlay/'.length);
        if (!isSafeInlayId(id)) continue;
        const fileAlreadyExists = await readInlayFile(id);
        if (fileAlreadyExists) {
            kvDel(key);
            kvDel(`inlay_thumb/${id}`);
            kvDel(`inlay_info/${id}`);
            continue;
        }
        const value = kvGet(key);
        if (!value) continue;
        try {
            const parsed = JSON.parse(value.toString('utf-8'));
            const type = typeof parsed?.type === 'string' ? parsed.type : 'image';
            const ext = normalizeInlayExt(parsed?.ext);
            let buffer;
            if (type === 'signature') {
                buffer = Buffer.from(typeof parsed?.data === 'string' ? parsed.data : '', 'utf-8');
            } else {
                buffer = decodeDataUri(parsed?.data).buffer;
            }
            const info = (await readInlayLegacyInfo(id)) || {
                ext,
                name: typeof parsed?.name === 'string' ? parsed.name : id,
                type,
                height: typeof parsed?.height === 'number' ? parsed.height : undefined,
                width: typeof parsed?.width === 'number' ? parsed.width : undefined,
            };
            await writeInlayFile(id, ext, buffer, info);
            kvDel(key);
            kvDel(`inlay_thumb/${id}`);
            kvDel(`inlay_info/${id}`);
        } catch (error) {
            logger.warn(`[InlayFS] Failed to migrate ${key}:`, error?.message || error);
        }
    }

    await fs.writeFile(inlayMigrationMarker, new Date().toISOString(), 'utf-8');
}

async function fetchLatestRelease(lang) {
    if (UPDATE_CHECK_DISABLED) return null;
    try {
        const currentVersion = getCurrentVersion();
        const params = new URLSearchParams({
            v: currentVersion,
            d: deploymentType,
            os: `${process.platform}-${process.arch}`,
            id: instanceId,
        });
        if (lang) params.set('l', String(lang).slice(0, 16));
        const url = `${UPDATE_CHECK_URL}?${params}`;
        const res = await fetch(url);
        if (!res.ok) return null;
        const data = await res.json();
        if (data.hasUpdate) {
            console.log(`[Update] New version available: v${data.latestVersion} (current: v${currentVersion}, ${data.severity})`);
        }
        return data;
    } catch (e) {
        logger.error('[Update] Failed to check for updates:', e.message);
        return null;
    }
}

// ── Session store for direct asset URL auth (F-0) ──────────────────────────
// <img src="/api/asset/..."> cannot send custom headers, so we use a session
// cookie issued after initial JWT auth. Single-user environment: Map is fine.
// Sessions are persisted to disk so they survive server restarts.
const SESSION_FILE = path.join(process.cwd(), 'save', '__sessions')
const sessions = new Map() // token → expiresAt (ms)

function loadSessions() {
    try {
        const raw = readFileSync(SESSION_FILE, 'utf-8')
        const now = Date.now()
        for (const [token, exp] of JSON.parse(raw)) {
            if (exp > now) sessions.set(token, exp)
        }
    } catch { /* file missing or corrupt – start fresh */ }
}

function saveSessions() {
    try { writeFileSync(SESSION_FILE, JSON.stringify([...sessions])) }
    catch { /* non-critical */ }
}

loadSessions()

function parseSessionCookie(req) {
    const cookieHeader = req.headers.cookie || ''
    for (const part of cookieHeader.split(';')) {
        const eq = part.indexOf('=')
        if (eq === -1) continue
        if (part.slice(0, eq).trim() === 'risu-session') return part.slice(eq + 1).trim()
    }
    return null
}

function sessionAuthMiddleware(req, res, next) {
    const token = parseSessionCookie(req)
    if (token && (sessions.get(token) ?? 0) > Date.now()) return next()
    res.status(401).end()
}

// MIME detection by magic bytes (fallback when key has no extension)
function detectMime(buf) {
    if (!buf || buf.length < 12) return 'application/octet-stream'
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif'
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp'
    if (buf[0] === 0x1a && buf[1] === 0x45) return 'video/webm'
    if (buf.length >= 8 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return 'video/mp4'
    return 'application/octet-stream'
}
const ASSET_EXT_MIME = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp',
    mp4: 'video/mp4', webm: 'video/webm',
    mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav',
}

async function checkDiskSpace(requiredBytes) {
    try {
        const saveDir = path.join(process.cwd(), 'save');
        const stats = await fs.statfs(saveDir);
        const availableBytes = stats.bavail * stats.bsize;
        return { ok: availableBytes >= requiredBytes, available: availableBytes };
    } catch {
        // statfs unavailable on this platform — skip check
        return { ok: true, available: -1 };
    }
}

// ── Active writer session (single-writer lock) ────────────────────────────────
// Mirrors the BroadcastChannel-based tab lock on the server side so that the
// same protection extends across devices. The last client to call /api/session
// becomes the active writer; older sessions receive 423 on write attempts.
let activeSessionId = null // string | null

function checkActiveSession(req, res) {
    const clientSessionId = req.headers['x-session-id']
    if (!clientSessionId) return true  // client without session support
    if (!activeSessionId) return true  // no session registered yet
    if (clientSessionId === activeSessionId) return true
    res.status(423).json({ error: 'Session deactivated' })
    return false
}

// --- Proxy Stream Job constants ---
const PROXY_STREAM_DEFAULT_TIMEOUT_MS = 600000;
const PROXY_STREAM_MAX_TIMEOUT_MS = 3600000;
const PROXY_STREAM_DEFAULT_HEARTBEAT_SEC = 15;
const PROXY_STREAM_HEARTBEAT_MIN_SEC = 5;
const PROXY_STREAM_HEARTBEAT_MAX_SEC = 60;
const PROXY_STREAM_GC_INTERVAL_MS = 60000;
const PROXY_STREAM_DONE_GRACE_MS = 30000;
const PROXY_STREAM_MAX_ACTIVE_JOBS = 64;
const PROXY_STREAM_MAX_PENDING_EVENTS = 512;
const PROXY_STREAM_MAX_PENDING_BYTES = 2 * 1024 * 1024;
const PROXY_STREAM_MAX_BODY_BASE64_BYTES = 8 * 1024 * 1024;
const proxyStreamJobs = new Map();

const loginRouteLimiter = rateLimit({
    windowMs: 30 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts. Please wait and try again later.' },
    validate: { xForwardedForHeader: false }
});

function isHex(str) {
    return hexRegex.test(str.toUpperCase().trim()) || str === '__password';
}

async function hashJSON(json){
    const hash = nodeCrypto.createHash('sha256');
    hash.update(JSON.stringify(json));
    return hash.digest('hex');
}

// NodeOnly: server-issued JWT (see jwt_secret comment above)
function createServerJwt() {
    const now = Math.floor(Date.now() / 1000)
    const header = { alg: 'HS256', typ: 'JWT' }
    const payload = { iat: now, exp: now + 5 * 60 }
    const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url')
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const sig = nodeCrypto.createHmac('sha256', jwtSecret)
        .update(`${headerB64}.${payloadB64}`)
        .digest('base64url')
    return `${headerB64}.${payloadB64}.${sig}`
}

function getRequestTimeoutMs(timeoutHeader) {
    const raw = Array.isArray(timeoutHeader) ? timeoutHeader[0] : timeoutHeader;
    if (!raw) {
        return null;
    }
    const timeoutMs = Number.parseInt(raw, 10);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return null;
    }
    return timeoutMs;
}

function createTimeoutController(timeoutMs) {
    if (!timeoutMs) {
        return {
            signal: undefined,
            cleanup: () => {}
        };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    return {
        signal: controller.signal,
        cleanup: () => clearTimeout(timer)
    };
}

// --- Proxy Stream: auth helpers ---

function normalizeAuthHeader(authHeader) {
    if (Array.isArray(authHeader)) {
        return authHeader[0] || '';
    }
    return typeof authHeader === 'string' ? authHeader : '';
}

async function isAuthorizedProxyRequest(req) {
    return await checkAuth(req, null, true);
}

async function checkProxyAuth(req, res) {
    return await checkAuth(req, res);
}

// --- Proxy Stream: network helpers ---

function isPrivateIPv4Host(hostname) {
    const parts = hostname.split('.');
    if (parts.length !== 4) {
        return false;
    }
    const octets = parts.map((part) => Number.parseInt(part, 10));
    if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
        return false;
    }
    const [a, b] = octets;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    return false;
}

function isLocalNetworkHost(hostname) {
    if (typeof hostname !== 'string' || hostname.trim() === '') {
        return false;
    }
    const normalizedHost = hostname.toLowerCase().replace(/\.$/, '').split('%')[0];
    if (normalizedHost === 'localhost' || normalizedHost === '::1' || normalizedHost.endsWith('.local')) {
        return true;
    }
    // NodeOnly policy: keep server-side validation aligned with the client helper
    // for Node/self-hosted deployments where single-label LAN or Docker DNS names
    // like "litellm" / "ollama" are valid local targets. Upstream currently only
    // allows localhost/.local/IP here, but NodeOnly routes all local-network-mode
    // traffic through the Node server, so rejecting single-label hosts would make
    // the feature unusable for common self-hosted setups.
    if (/^[a-z0-9_-]+$/i.test(normalizedHost) && !normalizedHost.includes('.')) {
        return true;
    }
    if (net.isIP(normalizedHost) === 4) {
        return isPrivateIPv4Host(normalizedHost);
    }
    if (net.isIP(normalizedHost) === 6) {
        if (normalizedHost.startsWith('::ffff:')) {
            const mapped = normalizedHost.substring(7);
            return net.isIP(mapped) === 4 && isPrivateIPv4Host(mapped);
        }
        if (normalizedHost.startsWith('fc') || normalizedHost.startsWith('fd')) {
            return true;
        }
        if (/^fe[89ab]/.test(normalizedHost)) {
            return true;
        }
        return normalizedHost === '::1';
    }
    return false;
}

function sanitizeTargetUrl(raw) {
    if (typeof raw !== 'string' || raw.trim() === '') {
        return null;
    }
    try {
        const parsed = new URL(raw);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return null;
        }
        if (!isLocalNetworkHost(parsed.hostname)) {
            return null;
        }
        parsed.username = '';
        parsed.password = '';
        return parsed.toString();
    } catch {
        return null;
    }
}

// --- Proxy Stream: request/response helpers ---

function normalizeForwardHeaders(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return {};
    }
    const normalized = {};
    for (const [key, value] of Object.entries(input)) {
        if (typeof key !== 'string') continue;
        if (typeof value === 'string') {
            normalized[key] = value;
        }
    }
    delete normalized['risu-auth'];
    delete normalized['risu-timeout-ms'];
    delete normalized['host'];
    delete normalized['connection'];
    delete normalized['content-length'];
    return normalized;
}

function normalizeProxyResponseHeaders(headers) {
    const normalized = {};
    for (const [key, value] of Object.entries(headers || {})) {
        if (value === undefined) continue;
        normalized[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
    }
    return normalized;
}

function normalizeProxyStreamTimeoutMs(timeoutMs) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return PROXY_STREAM_DEFAULT_TIMEOUT_MS;
    }
    const parsed = Math.max(1, Math.floor(timeoutMs));
    return Math.min(PROXY_STREAM_MAX_TIMEOUT_MS, parsed);
}

function normalizeHeartbeatSec(heartbeatSec) {
    if (!Number.isFinite(heartbeatSec)) {
        return PROXY_STREAM_DEFAULT_HEARTBEAT_SEC;
    }
    const parsed = Math.floor(heartbeatSec);
    return Math.min(PROXY_STREAM_HEARTBEAT_MAX_SEC, Math.max(PROXY_STREAM_HEARTBEAT_MIN_SEC, parsed));
}

// --- Proxy Stream: native HTTP request to local target ---

function requestLocalTargetStream(targetUrl, arg) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(targetUrl);
        const client = parsedUrl.protocol === 'https:' ? https : http;
        const headers = normalizeForwardHeaders(arg.headers);
        if (!headers['host']) {
            headers['host'] = parsedUrl.host;
        }
        if (arg.bodyBuffer && !headers['content-length']) {
            headers['content-length'] = String(arg.bodyBuffer.length);
        }

        let settled = false;
        let cleanupAbort = () => {};
        const finishReject = (error) => {
            if (settled) return;
            settled = true;
            cleanupAbort();
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
            cleanupAbort();
            resolve({
                status: res.statusCode || 502,
                headers: normalizeProxyResponseHeaders(res.headers),
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
            const onAbort = () => {
                const abortError = new Error('Proxy stream job aborted');
                abortError.name = 'AbortError';
                req.destroy(abortError);
            };
            if (arg.signal.aborted) {
                onAbort();
                return;
            }
            arg.signal.addEventListener('abort', onAbort, { once: true });
            cleanupAbort = () => arg.signal.removeEventListener('abort', onAbort);
        }

        if (arg.bodyBuffer && arg.method !== 'GET' && arg.method !== 'HEAD') {
            req.write(arg.bodyBuffer);
        }
        req.end();
    });
}

// --- Proxy Stream: job lifecycle ---

function createProxyStreamJob(arg) {
    const jobId = nodeCrypto.randomUUID();
    const timeoutMs = normalizeProxyStreamTimeoutMs(Number(arg.timeoutMs));
    const heartbeatSec = normalizeHeartbeatSec(arg.heartbeatSec);
    const controller = new AbortController();
    const createdAt = Date.now();
    const job = {
        id: jobId,
        createdAt,
        updatedAt: createdAt,
        done: false,
        cleanupAt: 0,
        clients: new Set(),
        pendingEvents: [],
        pendingBytes: 0,
        abortController: controller,
        deadlineAt: createdAt + timeoutMs,
        heartbeatSec,
        timeoutMs
    };
    proxyStreamJobs.set(jobId, job);
    return job;
}

function pushJobEvent(job, event) {
    job.updatedAt = Date.now();
    const text = JSON.stringify(event);
    if (job.clients.size === 0) {
        job.pendingEvents.push(text);
        job.pendingBytes += Buffer.byteLength(text);
        while (
            job.pendingEvents.length > PROXY_STREAM_MAX_PENDING_EVENTS
            || job.pendingBytes > PROXY_STREAM_MAX_PENDING_BYTES
        ) {
            const removed = job.pendingEvents.shift();
            if (!removed) break;
            job.pendingBytes -= Buffer.byteLength(removed);
        }
        return;
    }
    for (const client of job.clients) {
        if (client.readyState === client.OPEN) {
            client.send(text);
        }
    }
}

function markJobDone(job) {
    if (job.done) return;
    job.done = true;
    job.cleanupAt = Date.now() + PROXY_STREAM_DONE_GRACE_MS;
}

function cleanupJob(jobId) {
    const job = proxyStreamJobs.get(jobId);
    if (!job) return;
    for (const client of job.clients) {
        try { client.close(); } catch { /* ignore */ }
    }
    proxyStreamJobs.delete(jobId);
}

async function runProxyStreamJob(job, arg) {
    const targetUrl = sanitizeTargetUrl(arg.targetUrl);
    if (!targetUrl) {
        pushJobEvent(job, { type: 'error', status: 400, message: 'Blocked non-local target URL' });
        markJobDone(job);
        return;
    }

    const headers = normalizeForwardHeaders(arg.headers);
    if (!headers['x-forwarded-for']) {
        headers['x-forwarded-for'] = arg.clientIp;
    }
    const bodyBuffer = arg.bodyBase64 ? Buffer.from(arg.bodyBase64, 'base64') : undefined;

    try {
        const upstreamResponse = await requestLocalTargetStream(targetUrl, {
            method: arg.method,
            headers,
            bodyBuffer,
            timeoutMs: job.timeoutMs,
            signal: job.abortController.signal
        });

        const filteredHeaders = {};
        for (const [key, value] of Object.entries(upstreamResponse.headers)) {
            if (key === 'content-security-policy' || key === 'content-security-policy-report-only' || key === 'clear-site-data') {
                continue;
            }
            filteredHeaders[key] = value;
        }

        pushJobEvent(job, { type: 'upstream_headers', status: upstreamResponse.status, headers: filteredHeaders });

        if (upstreamResponse.body) {
            for await (const value of upstreamResponse.body) {
                if (job.abortController.signal.aborted) break;
                if (value && value.length > 0) {
                    pushJobEvent(job, { type: 'chunk', dataBase64: Buffer.from(value).toString('base64') });
                }
            }
        }
        pushJobEvent(job, { type: 'done' });
        markJobDone(job);
    } catch (error) {
        const message = error?.name === 'AbortError' ? 'Proxy stream job aborted' : `${error}`;
        pushJobEvent(job, { type: 'error', status: 504, message });
        markJobDone(job);
    }
}

// --- Proxy Stream: WebSocket setup ---

function setupProxyStreamWebSocket(server) {
    const wsServer = new WebSocketServer({ noServer: true });
    server.on('upgrade', async (req, socket, head) => {
        try {
            const reqUrl = new URL(req.url, `http://${req.headers.host}`);
            if (!reqUrl.pathname.startsWith('/proxy-stream-jobs/') || !reqUrl.pathname.endsWith('/ws')) {
                socket.destroy();
                return;
            }

            const auth = reqUrl.searchParams.get('risu-auth') || normalizeAuthHeader(req.headers['risu-auth']);
            if (!await isAuthorizedProxyRequest({ headers: { 'risu-auth': auth } })) {
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
                return;
            }

            const pathParts = reqUrl.pathname.split('/').filter(Boolean);
            const jobId = pathParts.length >= 3 ? pathParts[1] : '';
            const job = proxyStreamJobs.get(jobId);
            if (!job) {
                socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
                socket.destroy();
                return;
            }

            wsServer.handleUpgrade(req, socket, head, (ws) => {
                wsServer.emit('connection', ws, req, jobId);
            });
        } catch {
            socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
            socket.destroy();
        }
    });

    wsServer.on('connection', (ws, _req, jobId) => {
        const job = proxyStreamJobs.get(jobId);
        if (!job) {
            ws.close();
            return;
        }

        job.clients.add(ws);
        ws.send(JSON.stringify({ type: 'job_accepted', jobId }));
        for (const event of job.pendingEvents) {
            ws.send(event);
        }
        job.pendingEvents = [];
        job.pendingBytes = 0;

        const pingTimer = setInterval(() => {
            if (ws.readyState !== ws.OPEN) return;
            ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
        }, job.heartbeatSec * 1000);

        ws.on('close', () => {
            clearInterval(pingTimer);
            const currentJob = proxyStreamJobs.get(jobId);
            if (!currentJob) return;
            currentJob.clients.delete(ws);
            if (currentJob.done && currentJob.clients.size === 0) {
                cleanupJob(jobId);
            }
        });

        ws.on('error', () => {
            clearInterval(pingTimer);
        });
    });
}

function encodeBackupEntry(name, data) {
    const encodedName = Buffer.from(name, 'utf-8');
    const nameLength = Buffer.allocUnsafe(4);
    nameLength.writeUInt32LE(encodedName.length, 0);
    const dataLength = Buffer.allocUnsafe(4);
    dataLength.writeUInt32LE(data.length, 0);
    return Buffer.concat([nameLength, encodedName, dataLength, data]);
}

function isInvalidBackupPathSegment(name) {
    return (
        !name ||
        name.includes('\0') ||
        name.includes('\\') ||
        name.startsWith('/') ||
        name.includes('../') ||
        name.includes('/..') ||
        name === '.' ||
        name === '..'
    );
}

function parseInlayBackupName(name) {
    if (!name.startsWith('inlay/')) return null;
    const suffix = name.slice('inlay/'.length);
    if (!suffix || suffix.includes('/')) return null;
    const dotIdx = suffix.lastIndexOf('.');
    if (dotIdx <= 0) {
        return { id: suffix, ext: null };
    }
    return {
        id: suffix.slice(0, dotIdx),
        ext: suffix.slice(dotIdx + 1),
    };
}

function parseInlaySidecarBackupName(name) {
    if (!name.startsWith('inlay_sidecar/')) return null;
    const id = name.slice('inlay_sidecar/'.length);
    if (!isSafeInlayId(id)) return null;
    return { id };
}

function normalizeColdStorageStorageKey(nameOrKey) {
    let key = nameOrKey;
    if (key.startsWith('coldstorage/')) {
        key = key.slice('coldstorage/'.length);
    }
    if (key.endsWith('.json')) {
        key = key.slice(0, -'.json'.length);
    }
    if (!key || key.includes('/') || isInvalidBackupPathSegment(key)) {
        throw new Error(`Invalid cold storage entry name: ${nameOrKey}`);
    }
    return `coldstorage/${key}`;
}

function toColdStorageBackupName(storageKey) {
    return `${normalizeColdStorageStorageKey(storageKey)}.json`;
}

function parseColdStorageJsonBuffer(buffer, sourceLabel, options = {}) {
    const { allowPlainJson = false } = options;
    try {
        const decompressed = zlib.gunzipSync(buffer);
        return {
            coldData: JSON.parse(decompressed.toString('utf-8')),
            format: 'gzip',
        };
    } catch (gzipError) {
        if (!allowPlainJson) {
            throw gzipError;
        }
        try {
            return {
                coldData: JSON.parse(buffer.toString('utf-8')),
                format: 'plain-json',
            };
        } catch (jsonError) {
            throw new Error(`[ColdStorage] failed to parse ${sourceLabel}: gzip=${gzipError.message}; json=${jsonError.message}`);
        }
    }
}

function encodeColdStorageCanonicalBuffer(coldData) {
    return Buffer.from(zlib.gzipSync(Buffer.from(JSON.stringify(coldData), 'utf-8')));
}

function readColdStorageJsonEntry(nameOrKey, options = {}) {
    const { migrateLegacy = false, allowPlainJsonFallback = false } = options;
    const canonicalKey = normalizeColdStorageStorageKey(nameOrKey);
    const legacyBackupKey = `${canonicalKey}.json`;

    let storageKey = canonicalKey;
    let value = kvGet(canonicalKey);
    if (!value) {
        storageKey = legacyBackupKey;
        value = kvGet(legacyBackupKey);
    }
    if (!value) {
        return null;
    }

    const parsed = parseColdStorageJsonBuffer(value, storageKey, {
        allowPlainJson: allowPlainJsonFallback || storageKey !== canonicalKey,
    });

    if (migrateLegacy && (storageKey !== canonicalKey || parsed.format !== 'gzip')) {
        kvSet(canonicalKey, encodeColdStorageCanonicalBuffer(parsed.coldData));
        if (storageKey !== canonicalKey) {
            kvDel(storageKey);
        }
    }

    return {
        coldData: parsed.coldData,
        storageKey,
        canonicalKey,
        format: parsed.format,
    };
}

function listColdStorageBackupEntries() {
    const canonicalKeys = Array.from(new Set(
        kvList('coldstorage/').map((key) => normalizeColdStorageStorageKey(key))
    )).sort((a, b) => a.localeCompare(b));

    return canonicalKeys.map((storageKey) => {
        const entry = readColdStorageJsonEntry(storageKey, {
            migrateLegacy: true,
            allowPlainJsonFallback: true,
        });
        if (!entry) {
            throw new Error(`[ColdStorage] missing cold storage entry while exporting: ${storageKey}`);
        }
        const plainJson = Buffer.from(JSON.stringify(entry.coldData), 'utf-8');
        return {
            kind: 'buffer',
            buffer: plainJson,
            backupName: toColdStorageBackupName(storageKey),
            sortKey: toColdStorageBackupName(storageKey),
            size: plainJson.length,
        };
    });
}

function resolveBackupStorageKey(name) {
    if (Buffer.byteLength(name, 'utf-8') > BACKUP_ENTRY_NAME_MAX_BYTES) {
        throw new Error(`Backup entry name too long: ${name.slice(0, 64)}`);
    }

    if (name === 'database.risudat') {
        return 'database/database.bin';
    }

    if (
        name.startsWith('inlay_thumb/') ||
        name.startsWith('inlay_meta/')
    ) {
        if (isInvalidBackupPathSegment(name)) {
            throw new Error(`Invalid backup entry name: ${name}`);
        }
        return name;
    }

    if (name.startsWith('inlay/')) {
        const parsed = parseInlayBackupName(name);
        if (!parsed || !isSafeInlayId(parsed.id)) {
            throw new Error(`Invalid inlay backup entry name: ${name}`);
        }
        return name;
    }

    if (name.startsWith('inlay_sidecar/')) {
        const parsed = parseInlaySidecarBackupName(name);
        if (!parsed) {
            throw new Error(`Invalid inlay sidecar backup entry name: ${name}`);
        }
        return name;
    }

    // Upstream backups transport cold storage as coldstorage/<uuid>.json.
    // Normalize back to the runtime KV key: coldstorage/<uuid>.
    if (name.startsWith('coldstorage/')) {
        return normalizeColdStorageStorageKey(name);
    }

    if (isInvalidBackupPathSegment(name) || name !== path.basename(name)) {
        throw new Error(`Invalid asset backup entry name: ${name}`);
    }

    return `assets/${name}`;
}

function parseBackupChunk(buffer, onEntry) {
    let offset = 0;
    while (offset + 4 <= buffer.length) {
        const nameLength = buffer.readUInt32LE(offset);
        if (offset + 4 + nameLength > buffer.length) {
            break;
        }
        const nameStart = offset + 4;
        const nameEnd = nameStart + nameLength;
        const name = buffer.subarray(nameStart, nameEnd).toString('utf-8');
        if (nameEnd + 4 > buffer.length) {
            break;
        }
        const dataLength = buffer.readUInt32LE(nameEnd);
        const dataStart = nameEnd + 4;
        const dataEnd = dataStart + dataLength;
        if (dataEnd > buffer.length) {
            break;
        }
        onEntry(name, buffer.subarray(dataStart, dataEnd));
        offset = dataEnd;
    }
    return buffer.subarray(offset);
}

// ─── Shared backup import logic ─────────────────────────────────────────────
// Accepts any async iterable of Buffer chunks (HTTP request body, file stream, etc.)
async function importBackupFromSource(dataSource, { maxBytes = 0, totalBytes = 0, onProgress = null } = {}) {
    const BATCH_SIZE = 5000;
    // Defer Buffer.concat until enough bytes for the next entry are buffered.
    // Concatenating on every chunk arrival is O(n²) when a single entry (e.g.
    // database.risudat) far exceeds chunk size.
    let pendingChunks = [];
    let pendingTotal = 0;
    let nextEntryThreshold = 8;
    let hasDatabase = false;
    let assetsRestored = 0;
    let bytesReceived = 0;
    let batchCount = 0;
    const seenEntryNames = new Set();
    const importedInlayIds = new Set();
    const importedSidecarIds = new Set();
    const explicitSidecarMap = new Map();
    const legacyInlayInfoMap = new Map();

    const stagingDir = path.join(savePath, 'inlays_import_staging');
    const backupInlayDir = path.join(savePath, 'inlays_import_backup');
    await fs.rm(stagingDir, { recursive: true, force: true });
    await fs.rm(backupInlayDir, { recursive: true, force: true });
    await fs.mkdir(stagingDir, { recursive: true });

    function stagingInlayFilePath(id, ext) {
        return path.join(stagingDir, `${id}.${normalizeInlayExt(ext)}`);
    }
    function stagingSidecarPath(id) {
        return path.join(stagingDir, `${id}.meta.json`);
    }
    function writeStagingInlayFileSync(id, ext, buffer, info) {
        const normalizedExt = normalizeInlayExt(ext);
        writeFileSync(stagingInlayFilePath(id, normalizedExt), Buffer.from(buffer));
        const sidecar = {
            ext: normalizedExt,
            name: typeof info?.name === 'string' ? info.name : id,
            type: typeof info?.type === 'string' ? info.type : 'image',
            height: typeof info?.height === 'number' ? info.height : undefined,
            width: typeof info?.width === 'number' ? info.width : undefined,
        };
        writeFileSync(stagingSidecarPath(id), JSON.stringify(sidecar));
    }
    function writeStagingSidecarSync(id, info) {
        const sidecar = {
            ext: normalizeInlayExt(info?.ext),
            name: typeof info?.name === 'string' ? info.name : id,
            type: typeof info?.type === 'string' ? info.type : 'image',
            height: typeof info?.height === 'number' ? info.height : undefined,
            width: typeof info?.width === 'number' ? info.width : undefined,
        };
        writeFileSync(stagingSidecarPath(id), JSON.stringify(sidecar));
    }

    await flushPendingDb();
    createBackupAndRotate();

    sqliteDb.pragma('synchronous = OFF');

    sqliteDb.exec('BEGIN');
    kvDelPrefix('assets/');
    kvDelPrefix('inlay/');
    kvDelPrefix('inlay_thumb/');
    kvDelPrefix('inlay_meta/');
    kvDelPrefix('inlay_info/');
    kvDelPrefix('coldstorage/');
    // Composer drafts are session/device-local and not carried in the backup;
    // wipe stale ones so an old snapshot's chats don't resurrect later drafts.
    kvDelPrefix('drafts/');
    // Same reasoning as clearExistingData (save-folder import path): wipe stale
    // remote payloads from the prior user before this backup's contents land.
    // .bin backups never carry REMOTE blocks today, so the migration won't
    // resolveRemote on them — but keeping the two import paths consistent
    // avoids a contamination regression if that ever changes (upstream sync,
    // plugin-generated buffers, etc.).
    kvDelPrefix('remotes/');
    // Allow remote-block migration to re-evaluate against the new database.bin.
    // (.bin backups themselves never carry REMOTE blocks — legacy msgpack
    // format only — but a fresh import is a clear "data changed" signal.)
    kvDel(REMOTE_MIGRATION_MARKER_KEY);
    clearEntities();

    try {
        for await (const chunk of dataSource) {
            bytesReceived += chunk.length;
            if (maxBytes > 0 && bytesReceived > maxBytes) {
                throw new Error(`Backup exceeds max allowed size (${maxBytes} bytes)`);
            }
            if (onProgress) onProgress(bytesReceived, totalBytes);

            pendingChunks.push(Buffer.from(chunk));
            pendingTotal += chunk.length;
            if (pendingTotal < nextEntryThreshold) continue;

            const buffer = pendingChunks.length === 1
                ? pendingChunks[0]
                : Buffer.concat(pendingChunks, pendingTotal);
            pendingChunks = [];
            pendingTotal = 0;

            const remaining = parseBackupChunk(buffer, (name, data) => {
                if (seenEntryNames.has(name)) {
                    throw new Error(`Duplicate backup entry: ${name}`);
                }
                seenEntryNames.add(name);

                const inlayRaw = parseInlayBackupName(name);
                const inlaySidecar = parseInlaySidecarBackupName(name);

                if (inlayRaw) {
                    importedInlayIds.add(inlayRaw.id);
                    if (inlayRaw.ext) {
                        writeStagingInlayFileSync(inlayRaw.id, inlayRaw.ext, data, legacyInlayInfoMap.get(inlayRaw.id) || { ext: inlayRaw.ext, name: inlayRaw.id, type: 'image' });
                    } else if (data.length > 0 && data[0] === 0x7b) {
                        const parsed = JSON.parse(data.toString('utf-8'));
                        const type = typeof parsed?.type === 'string' ? parsed.type : 'image';
                        const ext = normalizeInlayExt(parsed?.ext);
                        const buffer = type === 'signature'
                            ? Buffer.from(typeof parsed?.data === 'string' ? parsed.data : '', 'utf-8')
                            : decodeDataUri(parsed?.data).buffer;
                        writeStagingInlayFileSync(inlayRaw.id, ext, buffer, legacyInlayInfoMap.get(inlayRaw.id) || {
                            ext,
                            name: typeof parsed?.name === 'string' ? parsed.name : inlayRaw.id,
                            type,
                            height: typeof parsed?.height === 'number' ? parsed.height : undefined,
                            width: typeof parsed?.width === 'number' ? parsed.width : undefined,
                        });
                    } else {
                        writeStagingInlayFileSync(inlayRaw.id, 'bin', data, legacyInlayInfoMap.get(inlayRaw.id) || {
                            ext: 'bin',
                            name: inlayRaw.id,
                            type: 'image',
                        });
                    }
                    if (explicitSidecarMap.has(inlayRaw.id)) {
                        writeStagingSidecarSync(inlayRaw.id, explicitSidecarMap.get(inlayRaw.id));
                    } else if (!importedSidecarIds.has(inlayRaw.id)) {
                        const legacyInfo = legacyInlayInfoMap.get(inlayRaw.id);
                        if (legacyInfo) {
                            writeStagingSidecarSync(inlayRaw.id, legacyInfo);
                        }
                    }
                    assetsRestored += 1;
                } else if (inlaySidecar) {
                    const parsed = JSON.parse(data.toString('utf-8'));
                    explicitSidecarMap.set(inlaySidecar.id, parsed);
                    writeStagingSidecarSync(inlaySidecar.id, parsed);
                    importedSidecarIds.add(inlaySidecar.id);
                } else if (name.startsWith('inlay_info/')) {
                    const id = name.slice('inlay_info/'.length);
                    if (!isSafeInlayId(id)) {
                        throw new Error(`Invalid legacy inlay info entry name: ${name}`);
                    }
                    const parsed = JSON.parse(data.toString('utf-8'));
                    legacyInlayInfoMap.set(id, {
                        ext: normalizeInlayExt(parsed?.ext),
                        name: typeof parsed?.name === 'string' ? parsed.name : id,
                        type: typeof parsed?.type === 'string' ? parsed.type : 'image',
                        height: typeof parsed?.height === 'number' ? parsed.height : undefined,
                        width: typeof parsed?.width === 'number' ? parsed.width : undefined,
                    });
                    if (importedInlayIds.has(id) && !importedSidecarIds.has(id)) {
                        writeStagingSidecarSync(id, legacyInlayInfoMap.get(id));
                    }
                } else if (name.startsWith('inlay_thumb/')) {
                    // Skip deprecated thumbnail entries from legacy backups
                } else {
                    const storageKey = resolveBackupStorageKey(name);
                    const storageValue = storageKey.startsWith('coldstorage/')
                        ? encodeColdStorageCanonicalBuffer(
                            parseColdStorageJsonBuffer(data, name, { allowPlainJson: true }).coldData
                        )
                        : data;
                    kvSet(storageKey, storageValue);
                    if (storageKey === 'database/database.bin') {
                        hasDatabase = true;
                    } else {
                        assetsRestored += 1;
                    }
                }

                batchCount++;
                if (batchCount >= BATCH_SIZE) {
                    sqliteDb.exec('COMMIT');
                    sqliteDb.exec('BEGIN');
                    batchCount = 0;
                }
            });

            if (remaining.length === 0) {
                nextEntryThreshold = 8;
            } else {
                pendingChunks.push(remaining);
                pendingTotal = remaining.length;
                if (remaining.length < 4) {
                    nextEntryThreshold = 8;
                } else {
                    const nameLen = remaining.readUInt32LE(0);
                    const headerEnd = 4 + nameLen + 4;
                    if (remaining.length < headerEnd) {
                        nextEntryThreshold = headerEnd;
                    } else {
                        const dataLen = remaining.readUInt32LE(4 + nameLen);
                        nextEntryThreshold = headerEnd + dataLen;
                    }
                }
            }
        }

        if (pendingTotal > 0) {
            throw new Error('Backup stream ended with incomplete entry');
        }
        if (!hasDatabase) {
            throw new Error('Backup does not contain database.risudat');
        }
        for (const [id, info] of legacyInlayInfoMap.entries()) {
            if (importedInlayIds.has(id) && !importedSidecarIds.has(id)) {
                writeStagingSidecarSync(id, info);
            }
        }
        sqliteDb.exec('COMMIT');
    } catch (error) {
        try { sqliteDb.exec('ROLLBACK'); } catch (_) {}
        await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
        await fs.rm(backupInlayDir, { recursive: true, force: true }).catch(() => {});
        throw error;
    } finally {
        sqliteDb.pragma('synchronous = NORMAL');
    }

    await ensureInlayDir();
    try {
        if (existsSync(inlayDir)) {
            await fs.rename(inlayDir, backupInlayDir);
        }
        await fs.rename(stagingDir, inlayDir);
        await fs.writeFile(inlayMigrationMarker, new Date().toISOString(), 'utf-8');
        await fs.rm(backupInlayDir, { recursive: true, force: true }).catch(() => {});
    } catch (swapError) {
        if (existsSync(backupInlayDir)) {
            await fs.rm(inlayDir, { recursive: true, force: true }).catch(() => {});
            await fs.rename(backupInlayDir, inlayDir).catch(() => {});
        }
        await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
        throw swapError;
    }

    invalidateDbCache();

    // Trigger cold storage migration now so import result includes failure count.
    const dbRaw = kvGet('database/database.bin');
    let coldStorageFailed = 0;
    if (dbRaw) {
        const migration = {};
        const dbObj = await decodeDatabaseWithPersistentChatIds(dbRaw, {
            createBackup: false,
            migrationResult: migration,
        });
        coldStorageFailed = migration.coldStorageFailed || 0;
        initChatStore(dbObj);
    }

    try {
        checkpointWal('TRUNCATE');
    } catch (checkpointError) {
        logger.warn('[Backup Import] WAL checkpoint after import failed:', checkpointError);
    }

    console.log(`[Backup Import] Complete: ${assetsRestored} assets restored, ${(bytesReceived / 1024 / 1024).toFixed(1)}MB processed`);
    if (coldStorageFailed > 0) {
        logger.error(`[Backup Import] ${coldStorageFailed} cold storage character(s) could not be restored`);
    }
    return { assetsRestored, bytesReceived, coldStorageFailed };
}

app.get('/', async (req, res, next) => {

    const clientIP = req.ip || 'Unknown IP';
    const timestamp = new Date().toISOString();
    console.log(`[Server] ${timestamp} | Connection from: ${clientIP}`);
    
    try {
        const mainIndex = await fs.readFile(path.join(process.cwd(), 'dist', 'index.html'))
        const root = htmlparser.parse(mainIndex)
        const head = root.querySelector('head')
        head.innerHTML = `<script>globalThis.__NODE__ = true; globalThis.__PATCH_SYNC__ = ${enablePatchSync}</script>` + head.innerHTML
        
        res.send(root.toString())
    } catch (error) {
        console.log(error)
        next(error)
    }
})

async function checkAuth(req, res, returnOnlyStatus = false, {allowExpired = false} = {}){
    try {
        const authHeader = req.headers['risu-auth'];

        if(!authHeader){
            console.log('No auth header')
            if(returnOnlyStatus){
                return false;
            }
            res.status(400).send({
                error:'No auth header'
            });
            return false
        }


        //jwt token
        const [
            jsonHeaderB64,
            jsonPayloadB64,
            signatureB64,
        ] = authHeader.split('.');

        //alg, typ
        const jsonHeader = JSON.parse(Buffer.from(jsonHeaderB64, 'base64url').toString('utf-8'));

        //iat, exp
        const jsonPayload = JSON.parse(Buffer.from(jsonPayloadB64, 'base64url').toString('utf-8'));

        
        //check expiration
        if(!allowExpired){
            const now = Math.floor(Date.now() / 1000);
            if(jsonPayload.exp < now){
                console.log('Token expired')
                if(returnOnlyStatus){
                    return false;
                }
                res.status(400).send({
                    error:'Token Expired'
                });
                return false
            }
        }

        //check signature (HMAC-SHA256)
        if(jsonHeader.alg !== "HS256"){
            console.log('Unsupported algorithm')
            if(returnOnlyStatus){
                return false;
            }
            res.status(400).send({
                error:'Unsupported Algorithm'
            });
            return false
        }

        const expectedSig = nodeCrypto.createHmac('sha256', jwtSecret)
            .update(`${jsonHeaderB64}.${jsonPayloadB64}`)
            .digest()
        const actualSig = Buffer.from(signatureB64, 'base64url')

        if(expectedSig.length !== actualSig.length || !nodeCrypto.timingSafeEqual(expectedSig, actualSig)){
            console.log('Invalid signature')
            if(returnOnlyStatus){
                return false;
            }
            res.status(400).send({
                error:'Invalid Signature'
            });
            return false
        }
        return true
    } catch (error) {
        console.log(error)
        if(returnOnlyStatus){
            return false;
        }
        res.status(500).send({
            error:'Internal Server Error'
        });
        return false
    }
}

const reverseProxyFunc = async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    
    const urlParam = req.headers['risu-url'] ? decodeURIComponent(req.headers['risu-url']) : req.query.url;

    if (!urlParam) {
        res.status(400).send({
            error:'URL has no param'
        });
        return;
    }
    const timeoutMs = getRequestTimeoutMs(req.headers['risu-timeout-ms']);
    const timeout = createTimeoutController(timeoutMs);
    let originalResponse;
    try {
    const header = req.headers['risu-header'] ? JSON.parse(decodeURIComponent(req.headers['risu-header'])) : req.headers;
    if (req.headers['x-risu-tk'] && !header['x-risu-tk']) {
        header['x-risu-tk'] = req.headers['x-risu-tk'];
    }
    if (req.headers['risu-location'] && !header['risu-location']) {
        header['risu-location'] = req.headers['risu-location'];
    }
    if(!header['x-forwarded-for']){
        header['x-forwarded-for'] = req.ip
    }

    if(req.headers['authorization']?.startsWith('X-SERVER-REGISTER')){
        if(!existsSync(authCodePath)){
            delete header['authorization']
        }
        else{
            const authCode = await fs.readFile(authCodePath, {
                encoding: 'utf-8'
            })
            header['authorization'] = `Bearer ${authCode}`
        }
    }
        let requestBody = undefined;
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            if (Buffer.isBuffer(req.body) || typeof req.body === 'string') {
                requestBody = req.body;
            }
            else if (req.body !== undefined) {
                requestBody = JSON.stringify(req.body);
            }
        }
        // make request to original server
        originalResponse = await fetch(urlParam, {
            method: req.method,
            headers: header,
            body: requestBody,
            signal: timeout.signal
        });
        // get response body as stream
        const originalBody = originalResponse.body;
        // get response headers
        const head = new Headers(originalResponse.headers);
        head.delete('content-security-policy');
        head.delete('content-security-policy-report-only');
        head.delete('clear-site-data');
        head.delete('Cache-Control');
        head.delete('Content-Encoding');
        // Node's fetch already decompressed the body, so the upstream
        // (compressed) Content-Length no longer matches and would truncate the
        // response. Drop it and let the body stream out chunked.
        head.delete('Content-Length');
        const headObj = {};
        for (let [k, v] of head) {
            headObj[k] = v;
        }
        // send response headers to client
        res.header(headObj);
        // send response status to client
        res.status(originalResponse.status);
        // send response body to client
        await pipeline(originalResponse.body, res);


    }
    catch (err) {
        if (err?.name === 'AbortError') {
            if (!res.headersSent) {
                res.status(504).send({
                    error: timeoutMs
                        ? `Proxy request timed out after ${timeoutMs}ms`
                        : 'Proxy request aborted'
                });
            } else {
                res.end();
            }
            return;
        }
        // Pass the actual `err` (not err.cause) so logger.* can tag it and the
        // Express error middleware knows to skip. The cause chain is preserved
        // via formatErrorWithCause in normalizeArgs.
        logger.error(`[Proxy] ${req.method} ${urlParam}`, err);
        next(err);
        return;
    } finally {
        timeout.cleanup();
    }
}

const reverseProxyFunc_get = async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    
    const urlParam = req.headers['risu-url'] ? decodeURIComponent(req.headers['risu-url']) : req.query.url;

    if (!urlParam) {
        res.status(400).send({
            error:'URL has no param'
        });
        return;
    }
    const timeoutMs = getRequestTimeoutMs(req.headers['risu-timeout-ms']);
    const timeout = createTimeoutController(timeoutMs);
    let originalResponse;
    try {
    const header = req.headers['risu-header'] ? JSON.parse(decodeURIComponent(req.headers['risu-header'])) : req.headers;
    if (req.headers['x-risu-tk'] && !header['x-risu-tk']) {
        header['x-risu-tk'] = req.headers['x-risu-tk'];
    }
    if (req.headers['risu-location'] && !header['risu-location']) {
        header['risu-location'] = req.headers['risu-location'];
    }
    if(!header['x-forwarded-for']){
        header['x-forwarded-for'] = req.ip
    }
        // make request to original server
        originalResponse = await fetch(urlParam, {
            method: 'GET',
            headers: header,
            signal: timeout.signal
        });
        // get response body as stream
        const originalBody = originalResponse.body;
        // get response headers
        const head = new Headers(originalResponse.headers);
        head.delete('content-security-policy');
        head.delete('content-security-policy-report-only');
        head.delete('clear-site-data');
        head.delete('Cache-Control');
        head.delete('Content-Encoding');
        // Node's fetch already decompressed the body, so the upstream
        // (compressed) Content-Length no longer matches and would truncate the
        // response. Drop it and let the body stream out chunked.
        head.delete('Content-Length');
        const headObj = {};
        for (let [k, v] of head) {
            headObj[k] = v;
        }
        // send response headers to client
        res.header(headObj);
        // send response status to client
        res.status(originalResponse.status);
        // send response body to client
        await pipeline(originalResponse.body, res);
    }
    catch (err) {
        if (err?.name === 'AbortError') {
            if (!res.headersSent) {
                res.status(504).send({
                    error: timeoutMs
                        ? `Proxy request timed out after ${timeoutMs}ms`
                        : 'Proxy request aborted'
                });
            } else {
                res.end();
            }
            return;
        }
        next(err);
        return;
    } finally {
        timeout.cleanup();
    }
}

let accessTokenCache = {
    token: null,
    expiry: 0
}
async function getSionywAccessToken() {
    if(accessTokenCache.token && Date.now() < accessTokenCache.expiry){
        return accessTokenCache.token;
    }
    //Schema of the client data file
    // {
    //     refresh_token: string;
    //     client_id: string;
    //     client_secret: string;
    // }
    
    const clientDataPath = path.join(process.cwd(), 'save', '__sionyw_client_data.json');
    let refreshToken = ''
    let clientId = ''
    let clientSecret = ''
    if(!existsSync(clientDataPath)){
        throw new Error('No Sionyw client data found');
    }
    const clientDataRaw = readFileSync(clientDataPath, 'utf-8');
    const clientData = JSON.parse(clientDataRaw);
    refreshToken = clientData.refresh_token;
    clientId = clientData.client_id;
    clientSecret = clientData.client_secret;

    //Oauth Refresh Token Flow
    
    const tokenResponse = await fetch('account.sionyw.com/account/api/oauth/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: clientId,
            client_secret: clientSecret
        })
    })

    if(!tokenResponse.ok){
        throw new Error('Failed to refresh Sionyw access token');
    }

    const tokenData = await tokenResponse.json();

    //Update the refresh token in the client data file
    if(tokenData.refresh_token && tokenData.refresh_token !== refreshToken){
        clientData.refresh_token = tokenData.refresh_token;
        writeFileSync(clientDataPath, JSON.stringify(clientData), 'utf-8');
    }

    accessTokenCache.token = tokenData.access_token;
    accessTokenCache.expiry = Date.now() + (tokenData.expires_in * 1000) - (5 * 60 * 1000); //5 minutes early

    return tokenData.access_token;
}


async function hubProxyFunc(req, res) {
    const excludedHeaders = [
        'content-encoding',
        'content-length',
        'transfer-encoding'
    ];

    try {
        let externalURL = '';

        const pathHeader = req.headers['x-risu-node-path'];
        if (pathHeader) {
            const decodedPath = decodeURIComponent(pathHeader);
            externalURL = decodedPath;
        } else {
            const pathAndQuery = req.originalUrl.replace(/^\/hub-proxy/, '');
            externalURL = hubURL + pathAndQuery;
        }
        
        const headersToSend = { ...req.headers };
        delete headersToSend.host;
        delete headersToSend.connection;
        delete headersToSend['content-length'];
        delete headersToSend['x-risu-node-path'];

        const hubOrigin = new URL(hubURL).origin;
        headersToSend.origin = hubOrigin;

        //if Authorization header is "Server-Auth, set the token to be Server-Auth
        if(headersToSend['Authorization'] === 'X-Node-Server-Auth'){
            //this requires password auth
            if(!await checkAuth(req, res)){
                return;
            }

            headersToSend['Authorization'] = "Bearer " + await getSionywAccessToken();
            delete headersToSend['risu-auth'];
        }
        
        
        const response = await fetch(externalURL, {
            method: req.method,
            headers: headersToSend,
            body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
            redirect: 'manual',
            duplex: 'half'
        });
        
        for (const [key, value] of response.headers.entries()) {
            // Skip encoding-related headers to prevent double decoding
            if (excludedHeaders.includes(key.toLowerCase())) {
                continue;
            }
            res.setHeader(key, value);
        }
        res.status(response.status);

        if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
            const redirectUrl = response.headers.get('location');
            const newHeaders = { ...headersToSend };
            const redirectResponse = await fetch(redirectUrl, {
                method: req.method,
                headers: newHeaders,
                body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
                redirect: 'manual',
                duplex: 'half'
            });
            for (const [key, value] of redirectResponse.headers.entries()) {
                if (excludedHeaders.includes(key.toLowerCase())) {
                    continue;
                }
                res.setHeader(key, value);
            }
            res.status(redirectResponse.status);
            if (redirectResponse.body) {
                await pipeline(redirectResponse.body, res);
            } else {
                res.end();
            }
            return;
        }
        
        if (response.body) {
            await pipeline(response.body, res);
        } else {
            res.end();
        }
        
    } catch (error) {
        logger.error("[Hub Proxy] Error:", error);
        if (!res.headersSent) {
            res.status(502).send({ error: 'Proxy request failed: ' + error.message });
        } else {
            res.end();
        }
    }
}

app.get('/proxy', reverseProxyFunc_get);
app.get('/proxy2', reverseProxyFunc_get);
app.get('/hub-proxy/*', hubProxyFunc);

app.post('/proxy', reverseProxyFunc);
app.post('/proxy2', reverseProxyFunc);
app.put('/proxy', reverseProxyFunc);
app.put('/proxy2', reverseProxyFunc);
app.patch('/proxy', reverseProxyFunc);
app.patch('/proxy2', reverseProxyFunc);
app.delete('/proxy', reverseProxyFunc);
app.delete('/proxy2', reverseProxyFunc);
app.post('/hub-proxy/*', hubProxyFunc);

// --- Proxy Stream Job endpoints ---
app.post('/proxy-stream-jobs', async (req, res) => {
    if (!await checkProxyAuth(req, res)) {
        return;
    }

    const rawUrl = typeof req.body?.url === 'string' ? req.body.url : '';
    const encodedUrl = encodeURIComponent(rawUrl);
    const url = sanitizeTargetUrl(decodeURIComponent(encodedUrl));
    if (!url) {
        res.status(400).send({ error: 'Invalid target URL. Only local/private network http(s) endpoints are allowed.' });
        return;
    }

    const method = typeof req.body?.method === 'string' ? req.body.method.toUpperCase() : 'POST';
    if (!['POST', 'GET', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
        res.status(400).send({ error: 'Invalid method' });
        return;
    }

    const bodyBase64 = typeof req.body?.bodyBase64 === 'string' ? req.body.bodyBase64 : '';
    if (bodyBase64.length > PROXY_STREAM_MAX_BODY_BASE64_BYTES) {
        res.status(413).send({ error: 'Request body too large' });
        return;
    }
    if (proxyStreamJobs.size >= PROXY_STREAM_MAX_ACTIVE_JOBS) {
        res.status(429).send({ error: 'Too many active stream jobs. Retry shortly.' });
        return;
    }
    const headers = normalizeForwardHeaders(req.body?.headers);
    const heartbeatSec = normalizeHeartbeatSec(Number(req.body?.heartbeatSec));
    const job = createProxyStreamJob({
        heartbeatSec,
        timeoutMs: req.body?.timeoutMs
    });

    void runProxyStreamJob(job, {
        targetUrl: url,
        headers,
        method,
        bodyBase64,
        clientIp: req.ip
    });

    res.send({
        jobId: job.id,
        heartbeatSec: job.heartbeatSec
    });
});

app.delete('/proxy-stream-jobs/:jobId', async (req, res) => {
    if (!await checkProxyAuth(req, res)) {
        return;
    }
    const job = proxyStreamJobs.get(req.params.jobId);
    if (!job) {
        res.send({ success: true });
        return;
    }
    job.abortController.abort();
    markJobDone(job);
    cleanupJob(job.id);
    res.send({ success: true });
});

// app.get('/api/password', async(req, res)=> {
//     if(password === ''){
//         res.send({status: 'unset'})
//     }
//     else if(req.body.password && req.body.password.trim() === password.trim()){
//         res.send({status:'correct'})
//     }
//     else{
//         res.send({status:'incorrect'})
//     }
// })

app.get('/api/test_auth', async(req, res) => {

    if(!password){
        res.send({status: 'unset'})
    }
    else if(!await checkAuth(req, res, true)){
        // JWT missing/invalid – fall back to session cookie (survives page refresh)
        const sessionToken = parseSessionCookie(req)
        if (sessionToken && (sessions.get(sessionToken) ?? 0) > Date.now()) {
            res.send({status: 'success', token: createServerJwt()})
        } else {
            res.send({status: 'incorrect'})
        }
    }
    else{
        res.send({status: 'success', token: createServerJwt()})
    }
})

app.post('/api/login', loginRouteLimiter, async (req, res) => {
    if(password === ''){
        res.status(400).send({error: 'Password not set'})
        return;
    }
    if(req.body.password && req.body.password.trim() === password.trim()){
        res.send({status:'success', token: createServerJwt()})
    }
    else{
        res.status(400).send({error: 'Password incorrect'})
    }
})

// NodeOnly: token refresh endpoint (pairs with server-side JWT)
app.post('/api/token/refresh', async (req, res) => {
    if (!await checkAuth(req, res, false, {allowExpired: true})) return
    res.json({ token: createServerJwt() })
})

// ── Session cookie issuance (F-0) ──────────────────────────────────────────
// Called once after JWT auth succeeds. Issues a long-lived cookie so that
// <img src="/api/asset/..."> requests can be authenticated without JS.
app.post('/api/session', async (req, res) => {
    if (!await checkAuth(req, res)) return
    const clientSessionId = req.headers['x-session-id']
    if (clientSessionId) {
        activeSessionId = clientSessionId
        console.log('[Session] Active writer session updated')
    }
    const token = nodeCrypto.randomBytes(32).toString('hex')
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000
    sessions.set(token, expiresAt)
    // Prune stale sessions (bounded by single-user usage, safe to do inline)
    for (const [t, exp] of sessions) {
        if (exp < Date.now()) sessions.delete(t)
    }
    saveSessions()
    const maxAge = 7 * 24 * 60 * 60 // seconds
    res.setHeader('Set-Cookie', `risu-session=${token}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}; Path=/`)
    res.json({ ok: true })
})

// ── Direct asset serving (F-1) ─────────────────────────────────────────────
// Serves KV-stored assets as proper HTTP responses with long-term caching.
// Key is hex-encoded to safely pass through URL. Auth via session cookie.
//
// Storage formats differ by key prefix:
//   assets/*        → raw binary (Uint8Array)
//   inlay/*         → JSON { data: "data:<mime>;base64,...", ext, type, ... }
//   inlay_thumb/*   → JSON { data: "data:<mime>;base64,...", ext, type, ... }

/**
 * Extract raw binary and content-type from a KV value.
 * Handles both raw binary (assets/) and JSON+base64 wrapped (inlay/) formats.
 */
function resolveAssetPayload(key, rawValue) {
    // inlay/ and inlay_thumb/ keys store JSON with base64 data URI
    if (key.startsWith('inlay/') || key.startsWith('inlay_thumb/')) {
        try {
            const json = JSON.parse(rawValue.toString('utf-8'))
            const dataUri = json.data
            if (typeof dataUri === 'string' && dataUri.startsWith('data:')) {
                // Parse "data:<mime>;base64,<payload>"
                const commaIdx = dataUri.indexOf(',')
                const meta = dataUri.substring(5, commaIdx) // after "data:"
                const mime = meta.split(';')[0]
                const binary = Buffer.from(dataUri.substring(commaIdx + 1), 'base64')
                return { binary, contentType: mime || 'application/octet-stream' }
            }
            // Fallback: ext field
            const ext = (json.ext || '').toLowerCase()
            const mime = ASSET_EXT_MIME[ext] || 'application/octet-stream'
            return { binary: rawValue, contentType: mime }
        } catch {
            // JSON parse failed — treat as raw binary
        }
    }

    // assets/* and others: raw binary
    const ext = key.split('.').pop()?.toLowerCase()
    const contentType = ASSET_EXT_MIME[ext] || detectMime(rawValue)
    return { binary: rawValue, contentType }
}

const THUMB_MAX_SIDE = 320;
const THUMB_QUALITY = 75;
const THUMB_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

async function generateThumbnail(buffer) {
    const vips = await getVips()
    const img = vips.Image.thumbnailBuffer(buffer, THUMB_MAX_SIDE, {
        height: THUMB_MAX_SIDE,
        size: 'down',
    })
    try {
        const out = img.writeToBuffer('.webp', { Q: THUMB_QUALITY })
        return Buffer.from(out);
    } finally {
        img.delete()
    }
}

app.get('/api/asset/:hexKey', sessionAuthMiddleware, async (req, res) => {
    try {
        const key = Buffer.from(req.params.hexKey, 'hex').toString('utf-8')

        if (key.startsWith('inlay/')) {
            const id = key.slice('inlay/'.length)
            const file = await readInlayFile(id)
            if (file) {
                const etag = `"${Math.floor(file.mtimeMs)}"`
                if (req.headers['if-none-match'] === etag) {
                    return res.status(304).set('Cache-Control', 'public, max-age=31536000, immutable').end()
                }
                res.set({
                    'Content-Type': file.mime,
                    'Cache-Control': 'public, max-age=31536000, immutable',
                    'ETag': etag,
                })
                return res.send(file.buffer)
            }
            return res.status(404).set('Cache-Control', 'no-store').end()
        }

        if (key.startsWith('inlay_thumb/')) {
            const id = key.slice('inlay_thumb/'.length)
            const sidecar = await readInlaySidecar(id);
            if (!sidecar || sidecar.type !== 'image' || !THUMB_IMAGE_EXTS.has(sidecar.ext)) {
                return res.status(404).end()
            }
            const file = await readInlayFile(id)
            if (!file) return res.status(404).set('Cache-Control', 'no-store').end()
            const etag = `"thumb-${Math.floor(file.mtimeMs)}"`
            if (req.headers['if-none-match'] === etag) {
                return res.status(304).set('Cache-Control', 'public, max-age=31536000, immutable').end()
            }
            const thumb = await generateThumbnail(file.buffer)
            res.set({
                'Content-Type': 'image/webp',
                'Cache-Control': 'public, max-age=31536000, immutable',
                'ETag': etag,
            })
            return res.send(thumb)
        }

        // Fast-path 304: check updated_at BEFORE loading the blob.
        const updatedAt = kvGetUpdatedAt(key)
        if (updatedAt === null) return res.status(404).set('Cache-Control', 'no-store').end()

        const etag = `"${updatedAt}"`
        if (req.headers['if-none-match'] === etag) {
            return res.status(304).set('Cache-Control', 'public, max-age=31536000, immutable').end()
        }

        const data = kvGet(key)
        if (!data) return res.status(404).set('Cache-Control', 'no-store').end()

        const { binary, contentType } = resolveAssetPayload(key, data)
        res.set({
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=31536000, immutable',
            'ETag': etag,
        })
        res.send(binary)
    } catch (error) {
        logger.error('[Asset] Failed to serve asset:', error);
        res.status(500).end()
    }
})

app.post('/api/crypto', async (req, res) => {
    try {
        const hash = nodeCrypto.createHash('sha256')
        hash.update(Buffer.from(req.body.data, 'utf-8'))
        res.send(hash.digest('hex'))
    } catch (error) {
        res.status(500).send({ error: 'Crypto operation failed' });
    }
})

// Vertex / google-service-account access tokens. The browser cannot sign the
// RS256 JWT itself: crypto.subtle needs a Secure Context that HTTP remote
// access lacks, and node:crypto isn't in the client bundle. So the client
// forwards the SA JSON here and the server signs + exchanges it. Google's token
// response is forwarded verbatim so the client maps statuses unchanged.
// Never log the SA JSON / private key / assertion / OAuth body.
const GOOGLE_OAUTH_TOKEN_URI = 'https://oauth2.googleapis.com/token'
app.post('/api/model-preset/google-service-account/token', async (req, res) => {
    if (!await checkAuth(req, res)) return
    try {
        const serviceAccountJson = req.body && req.body.serviceAccountJson
        const scope = (req.body && typeof req.body.scope === 'string' && req.body.scope.length > 0)
            ? req.body.scope
            : 'https://www.googleapis.com/auth/cloud-platform'
        if (typeof serviceAccountJson !== 'string' || serviceAccountJson.length === 0) {
            res.status(400).send({ error: 'serviceAccountJson required' })
            return
        }
        let sa
        try {
            sa = JSON.parse(serviceAccountJson)
        } catch {
            res.status(400).send({ error: 'invalid service account JSON' })
            return
        }
        const clientEmail = sa && sa.client_email
        const privateKey = sa && sa.private_key
        const kid = sa && sa.private_key_id
        const tokenUri = (sa && typeof sa.token_uri === 'string' && sa.token_uri.length > 0)
            ? sa.token_uri
            : GOOGLE_OAUTH_TOKEN_URI
        if (typeof clientEmail !== 'string' || typeof privateKey !== 'string') {
            res.status(400).send({ error: 'service account missing client_email / private_key' })
            return
        }
        // SSRF / signed-JWT exfiltration guard: only Google's documented endpoint.
        if (tokenUri !== GOOGLE_OAUTH_TOKEN_URI) {
            res.status(400).send({ error: 'unsupported token_uri' })
            return
        }
        const nowSec = Math.floor(Date.now() / 1000)
        const header = { alg: 'RS256', typ: 'JWT' }
        if (typeof kid === 'string' && kid.length > 0) header.kid = kid
        const payload = { iss: clientEmail, scope, aud: tokenUri, iat: nowSec, exp: nowSec + 3600 }
        const signingInput =
            `${Buffer.from(JSON.stringify(header)).toString('base64url')}.` +
            `${Buffer.from(JSON.stringify(payload)).toString('base64url')}`
        let signature
        try {
            const signer = nodeCrypto.createSign('RSA-SHA256')
            signer.update(signingInput)
            signer.end()
            signature = signer.sign(privateKey).toString('base64url')
        } catch {
            res.status(400).send({ error: 'failed to sign with the provided private key' })
            return
        }
        const assertion = `${signingInput}.${signature}`

        let googleRes
        try {
            googleRes = await fetch(tokenUri, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Accept: 'application/json',
                },
                body: new URLSearchParams({
                    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                    assertion,
                }).toString(),
            })
        } catch {
            res.status(502).send({ error: 'OAuth token endpoint unreachable' })
            return
        }

        // Forward Google's status + body verbatim (client maps errors).
        const text = await googleRes.text().catch(() => '')
        const contentType = googleRes.headers.get('content-type')
        if (contentType) res.set('content-type', contentType)
        res.status(googleRes.status).send(text)
    } catch {
        res.status(500).send({ error: 'service account token exchange failed' })
    }
})


app.post('/api/set_password', async (req, res) => {
    if(password === ''){
        password = req.body.password
        writeFileSync(passwordPath, password, 'utf-8')
        res.send({status: 'success'})
    }
    else{
        res.status(400).send("already set")
    }
})

app.get('/api/read', async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    const filePath = req.headers['file-path'];
    if (!filePath) {
        console.log('no path')
        res.status(400).send({ error:'File path required' });
        return;
    }
    if(!isHex(filePath)){
        res.status(400).send({ error:'Invaild Path' });
        return;
    }
    try {
        const key = Buffer.from(filePath, 'hex').toString('utf-8');
        // Flush pending patches before reading database.bin
        if (key === 'database/database.bin') {
            await flushPendingDb();
        }
        let value = null;
        if (key.startsWith('inlay/')) {
            value = await readInlayAssetPayload(key.slice('inlay/'.length));
        } else if (key.startsWith('inlay_info/')) {
            value = await readInlayInfoPayload(key.slice('inlay_info/'.length));
        }
        if (value === null) {
            value = kvGet(key);
        }
        if(value === null){
            res.send();
        } else {
            // Strip chat payloads from database.bin — client gets stubs only
            if (key === 'database/database.bin') {
                try {
                    const dbObj = await decodeDatabaseWithPersistentChatIds(value, {
                        createBackup: true,
                    });
                    initChatStore(dbObj);
                    const stripped = normalizeJSON(stripChatsFromDb(dbObj));
                    // Populate dbCache so patch endpoint uses the same data
                    dbCache[filePath] = stripped;
                    value = Buffer.from(encodeRisuSaveLegacy(stripped));
                } catch (e) {
                    // Log the Error itself (not just e.message) so logger.*
                    // tags it and the Express middleware won't re-log after next().
                    logger.error('[Read] Failed to strip chats from database.bin', e);
                    return next(e);
                }
                dbEtag = computeBufferEtag(value);
                if (req.headers['if-none-match'] === dbEtag) {
                    return res.status(304).end();
                }
                res.setHeader('x-db-etag', dbEtag);
            }
            res.setHeader('Content-Type', 'application/octet-stream');
            res.send(value);
        }
    } catch (error) {
        next(error);
    }
});

app.get('/api/remove', async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    const filePath = req.headers['file-path'];
    if (!filePath) {
        res.status(400).send({ error:'File path required' });
        return;
    }
    if(!isHex(filePath)){
        res.status(400).send({ error:'Invaild Path' });
        return;
    }
    try {
        const key = Buffer.from(filePath, 'hex').toString('utf-8');
        if (key.startsWith('inlay/')) {
            const id = key.slice('inlay/'.length)
            await deleteInlayFile(id)
            kvDel(key);
            kvDel(`inlay_thumb/${id}`);
            kvDel(`inlay_info/${id}`);
            return res.send({ success: true });
        }
        if (key.startsWith('inlay_info/')) {
            await fs.unlink(getInlaySidecarPath(key.slice('inlay_info/'.length))).catch(() => {});
        }
        kvDel(key);
        res.send({ success: true });
    } catch (error) {
        next(error);
    }
});

app.get('/api/list', async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    try {
        const keyPrefix = req.headers['key-prefix'] || '';
        let data;
        if (keyPrefix === 'inlay/') {
            const fileKeys = (await listInlayFiles()).map((entry) => `inlay/${entry.id}`);
            data = [...new Set([
                ...fileKeys,
                ...kvList('inlay/'),
            ])];
        } else {
            data = kvList(keyPrefix || undefined);
        }
        res.send({ success: true, content: data });
    } catch (error) {
        next(error);
    }
});

// ─── /api/logs — client-side error/warning/info log persistence ───────────────
const LOGS_POST_MAX_ENTRIES = 1000;
app.post('/api/logs', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    try {
        const body = req.body;
        const entries = Array.isArray(body) ? body : [body];
        if (entries.length === 0) {
            return res.send({ success: true, written: 0 });
        }
        if (entries.length > LOGS_POST_MAX_ENTRIES) {
            return res.status(413).send({ error: `too many entries (max ${LOGS_POST_MAX_ENTRIES})` });
        }
        const prepared = entries
            .filter(e => e && typeof e === 'object' && typeof e.message === 'string')
            .map(e => ({
                timestamp: typeof e.timestamp === 'number' ? e.timestamp : Date.now(),
                level: e.level,
                origin: 'client',
                message: e.message,
                description: e.description,
                source: e.source,
                count: e.count,
                platform: e.platform,
                clientId: e.clientId,
                userAgent: e.userAgent,
            }));
        const written = addLogBatch(prepared);
        res.send({ success: true, written });
    } catch (error) {
        next(error);
    }
});

app.get('/api/logs', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    try {
        const parseCsv = (v) => typeof v === 'string' && v.length ? v.split(',').filter(Boolean) : undefined;
        const filterArgs = {
            level: typeof req.query.level === 'string' ? req.query.level : undefined,
            origin: typeof req.query.origin === 'string' ? req.query.origin : undefined,
            since: req.query.since ? Number(req.query.since) : undefined,
            excludeLevels: parseCsv(req.query.exclude_levels),
            excludeOrigins: parseCsv(req.query.exclude_origins),
            excludeBackground: req.query.exclude_background === '1',
        };
        const rows = queryLogs({
            ...filterArgs,
            beforeId: req.query.before_id ? Number(req.query.before_id) : undefined,
            limit: req.query.limit ? Number(req.query.limit) : undefined,
        });
        // total reflects rows matching the same filter — pagination math depends on it.
        res.send({ success: true, content: rows, total: countLogs(filterArgs) });
    } catch (error) {
        next(error);
    }
});

app.delete('/api/logs', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    try {
        clearLogs();
        res.send({ success: true });
    } catch (error) {
        next(error);
    }
});

app.post('/api/write', async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    if (!checkActiveSession(req, res)) return;
    const filePath = req.headers['file-path'];
    const fileContent = req.body;
    if (!filePath || !fileContent) {
        res.status(400).send({ error:'File path required' });
        return;
    }
    if(!isHex(filePath)){
        res.status(400).send({ error:'Invaild Path' });
        return;
    }
    try {
        await queueStorageOperation(async () => {
            const key = Buffer.from(filePath, 'hex').toString('utf-8');

            // ETag conflict detection for database.bin
            if (key === 'database/database.bin') {
                const ifMatch = req.headers['x-if-match'];
                if (ifMatch && dbEtag && ifMatch !== dbEtag) {
                    res.status(409).send({
                        error: 'ETag mismatch - concurrent modification detected',
                        currentEtag: dbEtag
                    });
                    return;
                }
            }

            if (key.startsWith('inlay/')) {
                const id = key.slice('inlay/'.length)
                const parsed = JSON.parse(Buffer.from(fileContent).toString('utf-8'));
                const type = typeof parsed?.type === 'string' ? parsed.type : 'image';
                const ext = normalizeInlayExt(parsed?.ext);
                const buffer = type === 'signature'
                    ? Buffer.from(typeof parsed?.data === 'string' ? parsed.data : '', 'utf-8')
                    : decodeDataUri(parsed?.data).buffer;
                await writeInlayFile(id, ext, buffer, {
                    ext,
                    name: typeof parsed?.name === 'string' ? parsed.name : id,
                    type,
                    height: typeof parsed?.height === 'number' ? parsed.height : undefined,
                    width: typeof parsed?.width === 'number' ? parsed.width : undefined,
                });
                kvDel(key);
                kvDel(`inlay_thumb/${id}`);
                kvDel(`inlay_info/${id}`);
            } else if (key.startsWith('inlay_info/')) {
                const id = key.slice('inlay_info/'.length)
                const parsed = JSON.parse(Buffer.from(fileContent).toString('utf-8'));
                await writeInlaySidecar(id, parsed);
                kvDel(key);
            } else if (key === 'database/database.bin') {
                // Client sends stubs-only DB — merge full chats from server before persisting
                try {
                    const incomingDb = await decodeRisuSave(fileContent);
                    await ensureChatStore();
                    const fullDb = reassembleFullDb(incomingDb);

                    // Mirror the patch-persist guard (persistDbCacheWithChats):
                    // a malformed full-write payload could carry chats with
                    // neither `_stub` nor `message` (the v1.4.x metadata-only
                    // pattern). reassembleFullDb passes them through unchanged
                    // because there's no fullChat lookup to merge in, so they
                    // would land on disk and silently strip user messages.
                    // Normal clients are safe (RisuSaveEncoder runs chatToStub
                    // on every chat first), but external tools / future
                    // regressions could bypass that — keep the guard at the
                    // disk boundary for defense in depth.
                    const losses = findStubFlagLossChats(fullDb);
                    if (losses.length > 0) {
                        const sample = losses.slice(0, 3).map(l => `${l.chaId}/${l.chatId ?? l.chatIndex}`).join(', ');
                        const err = new Error(
                            `write aborted: ${losses.length} chat(s) lost _stub flag without upgrade — `
                            + `would silently strip messages on disk. sample=[${sample}]`
                        );
                        recordPersistFailure(err, '/api/write:stub-flag-loss');
                        logger.error(`[Write] ${err.message}`);
                        res.status(500).json({ error: 'Write aborted: chat data integrity check failed' });
                        return;
                    }

                    const mergedContent = Buffer.from(encodeRisuSaveLegacy(fullDb));
                    // Re-init chat store from merged result
                    initChatStore(fullDb);
                    kvSet(key, mergedContent);
                } catch (e) {
                    logger.error('[Write] Failed to merge chats into database.bin:', e.message);
                    // Do NOT write stubs-only to disk — that would permanently
                    // destroy existing full chat data. Preserve disk as-is.
                    res.status(500).json({ error: 'Database merge failed' });
                    return;
                }
            } else {
                kvSet(key, fileContent);
            }

            // Update ETag, backup, and invalidate cache after database.bin write
            if (key === 'database/database.bin') {
                delete dbCache[DB_HEX_KEY];
                if (saveTimers[DB_HEX_KEY]) {
                    clearTimeout(saveTimers[DB_HEX_KEY]);
                    delete saveTimers[DB_HEX_KEY];
                }
                // ETag based on stripped version (what client sees)
                dbEtag = computeBufferEtag(fileContent);
                createBackupAndRotate();
            }

            res.send({
                success: true,
                etag: key === 'database/database.bin' ? dbEtag : undefined
            });
        });
    } catch (error) {
        next(error);
    }
});

app.post('/api/db/flush', sessionAuthMiddleware, async (req, res, next) => {
    if (!checkActiveSession(req, res)) return;
    try {
        await queueStorageOperation(async () => {
            await flushPendingDb();
            res.send({
                success: true,
                etag: dbEtag ?? undefined
            });
        });
    } catch (error) {
        next(error);
    }
});

// ─── Patch sync endpoint ──────────────────────────────────────────────────────
app.post('/api/patch', async (req, res, next) => {
    if (!enablePatchSync) {
        res.status(404).send({ error: 'Patch sync is not enabled' });
        return;
    }
    if(!await checkAuth(req, res)){
        return;
    }
    if (!checkActiveSession(req, res)) return;
    const filePath = req.headers['file-path'];
    const patch = req.body.patch;
    const expectedHash = req.body.expectedHash;

    if (!filePath || !patch || !expectedHash) {
        res.status(400).send({ error: 'File path, patch, and expected hash required' });
        return;
    }
    if (!isHex(filePath)) {
        res.status(400).send({ error: 'Invaild Path' });
        return;
    }

    try {
        await queueStorageOperation(async () => {
            const decodedKey = Buffer.from(filePath, 'hex').toString('utf-8');

            // Load database into memory if not already cached
            // For database.bin, cache holds the STRIPPED version (stubs only)
            if (!dbCache[filePath]) {
                const fileContent = kvGet(decodedKey);
                if (fileContent) {
                    const decoded = decodedKey === 'database/database.bin'
                        ? await decodeDatabaseWithPersistentChatIds(fileContent)
                        : normalizeJSON(await decodeRisuSave(fileContent));
                    if (decodedKey === 'database/database.bin') {
                        initChatStore(decoded);
                        dbCache[filePath] = normalizeJSON(stripChatsFromDb(decoded));
                    } else {
                        dbCache[filePath] = decoded;
                    }
                } else {
                    dbCache[filePath] = {};
                }
            }

            // Reject patch ops that touch chat-internal fields. Lazy loading
            // strips chats to stubs in dbCache; the only legitimate chat ops
            // are stub metadata (id, name, _stub, lastDate, folderId, modules)
            // or whole-chat add/replace/remove. Field-level ops on chats —
            // particularly remove of message/hypaV3Data/scriptstate/etc —
            // strip the `_stub` flag and cause silent on-disk data loss when
            // reassembleFullDb later sees the metadata-only chat. Reject as
            // 409 so the client falls through to a full write and rebases its
            // patcher baseline. See findStubFlagLossChats for the disk-side
            // partner guard.
            const chatInternalOps = decodedKey === 'database/database.bin'
                ? findChatInternalFieldOps(patch)
                : [];
            if (chatInternalOps.length > 0) {
                const sample = chatInternalOps.slice(0, 5).map(v => `${v.op} ${v.path}`).join(', ');
                logger.warn(
                    `[Patch] Rejected ${chatInternalOps.length} chat-internal field op(s) `
                    + `(would corrupt lazy-loaded chats): ${sample}`
                );
                let currentEtag;
                try {
                    currentEtag = computeBufferEtag(Buffer.from(encodeRisuSaveLegacy(dbCache[filePath])));
                    dbEtag = currentEtag;
                } catch {}
                res.status(409).send({
                    error: 'Patch rejected: chat-internal field ops not allowed for lazy-loaded chats',
                    code: 'CHAT_GUARD_REJECTED',
                    chatGuardRejected: true,
                    currentEtag,
                });
                return;
            }

            const serverHash = calculateHash(dbCache[filePath]).toString(16);

            if (expectedHash !== serverHash) {
                console.log(`[Patch] Hash mismatch for ${decodedKey}: expected=${expectedHash}, server=${serverHash}`);
                let currentEtag = undefined;
                if (decodedKey === 'database/database.bin') {
                    currentEtag = computeBufferEtag(Buffer.from(encodeRisuSaveLegacy(dbCache[filePath])));
                    dbEtag = currentEtag;
                }
                res.status(409).send({
                    error: 'Hash mismatch - data out of sync',
                    currentEtag
                });
                return;
            }

            // Apply patch to in-memory database (clone first to prevent partial mutation on failure)
            const snapshot = JSON.parse(JSON.stringify(dbCache[filePath]));
            let result;
            try {
                result = applyPatch(snapshot, patch, true);
            } catch (patchErr) {
                // Invalidate corrupted cache entry to force reload on next request
                delete dbCache[filePath];
                throw patchErr;
            }
            dbCache[filePath] = snapshot;

            // Schedule save to KV (debounced) — merge full chats back for database.bin
            if (saveTimers[filePath]) {
                clearTimeout(saveTimers[filePath]);
            }
            saveTimers[filePath] = setTimeout(async () => {
                try {
                    if (decodedKey === 'database/database.bin') {
                        await persistDbCacheWithChats(filePath, decodedKey);
                    } else {
                        const data = Buffer.from(encodeRisuSaveLegacy(dbCache[filePath]));
                        try {
                            kvSet(decodedKey, data);
                        } catch (err) {
                            if (err && typeof err === 'object') {
                                try { err.attemptedSize = data.length; } catch {}
                            }
                            throw err;
                        }
                    }
                    // Persist succeeded — clear before backup so a backup-only
                    // failure isn't attributed to data loss.
                    clearPersistFailure();
                    if (decodedKey === 'database/database.bin') {
                        try {
                            createBackupAndRotate();
                        } catch (backupErr) {
                            logger.warn(`[Patch] Backup rotation failed for ${decodedKey}:`, backupErr);
                        }
                    }
                } catch (error) {
                    logger.error(`[Patch] Error saving ${decodedKey}:`, error);
                    recordPersistFailure(error, `patch:${decodedKey}`);
                } finally {
                    delete saveTimers[filePath];
                }
            }, SAVE_INTERVAL);

            // Update ETag after successful patch (based on stripped version)
            if (decodedKey === 'database/database.bin') {
                dbEtag = computeBufferEtag(Buffer.from(encodeRisuSaveLegacy(dbCache[filePath])));
            }

            const responsePayload = {
                success: true,
                appliedOperations: result.length,
                etag: decodedKey === 'database/database.bin' ? dbEtag : undefined,
            };
            const persistWarning = currentPersistWarning();
            if (persistWarning) {
                responsePayload.persistWarning = persistWarning;
            }
            res.send(responsePayload);
        });
    } catch (error) {
        logger.error(`[Patch] Error applying patch to ${filePath}:`, error.name);
        res.status(500).send({
            error: 'Patch application failed: ' + (error && error.message ? error.message : error)
        });
    }
});

// ─── Bulk asset endpoints (3-2-B) ─────────────────────────────────────────────
const BULK_BATCH = 50;

app.post('/api/assets/bulk-read', async (req, res, next) => {
    if(!await checkAuth(req, res)){ return; }
    try {
        const keys = req.body; // string[] — decoded key strings
        if(!Array.isArray(keys)){
            res.status(400).send({ error: 'Body must be a JSON array of keys' });
            return;
        }

        const acceptsBinary = (req.headers['accept'] || '').includes('application/octet-stream');

        if (acceptsBinary) {
            // Binary protocol: [count(4)] then per entry: [keyLen(4)][key][valLen(4)][value]
            // Eliminates ~33% base64 overhead
            const entries = [];
            let totalSize = 4; // count header
            for (let i = 0; i < keys.length; i += BULK_BATCH) {
                const batch = keys.slice(i, i + BULK_BATCH);
                for (const key of batch) {
                    let value = null;
                    if (typeof key === 'string' && key.startsWith('inlay_info/')) {
                        value = await readInlayInfoPayload(key.slice('inlay_info/'.length));
                    }
                    if (value === null) {
                        value = kvGet(key);
                    }
                    if (value !== null) {
                        const keyBuf = Buffer.from(key, 'utf-8');
                        const valBuf = Buffer.from(value);
                        entries.push({ keyBuf, valBuf });
                        totalSize += 4 + keyBuf.length + 4 + valBuf.length;
                    }
                }
            }
            const out = Buffer.allocUnsafe(totalSize);
            let offset = 0;
            out.writeUInt32BE(entries.length, offset); offset += 4;
            for (const { keyBuf, valBuf } of entries) {
                out.writeUInt32BE(keyBuf.length, offset); offset += 4;
                keyBuf.copy(out, offset); offset += keyBuf.length;
                out.writeUInt32BE(valBuf.length, offset); offset += 4;
                valBuf.copy(out, offset); offset += valBuf.length;
            }
            res.set('Content-Type', 'application/octet-stream');
            res.send(out);
        } else {
            // Legacy JSON+base64 fallback
            const results = [];
            for (let i = 0; i < keys.length; i += BULK_BATCH) {
                const batch = keys.slice(i, i + BULK_BATCH);
                for (const key of batch) {
                    let value = null;
                    if (typeof key === 'string' && key.startsWith('inlay_info/')) {
                        value = await readInlayInfoPayload(key.slice('inlay_info/'.length));
                    }
                    if (value === null) {
                        value = kvGet(key);
                    }
                    if (value !== null) {
                        results.push({ key, value: Buffer.from(value).toString('base64') });
                    }
                }
            }
            res.json(results);
        }
    } catch(error){ next(error); }
});

app.post('/api/assets/bulk-write', async (req, res, next) => {
    if(!await checkAuth(req, res)){ return; }
    if (!checkActiveSession(req, res)) return;
    try {
        const entries = req.body; // {key: string, value: base64}[]
        if(!Array.isArray(entries)){
            res.status(400).send({ error: 'Body must be a JSON array of {key, value}' });
            return;
        }
        for(let i = 0; i < entries.length; i += BULK_BATCH){
            const batch = entries.slice(i, i + BULK_BATCH);
            const writeBatch = sqliteDb.transaction(() => {
                for(const { key, value } of batch){
                    kvSet(key, Buffer.from(value, 'base64'));
                }
            });
            writeBatch();
        }
        res.json({ success: true, count: entries.length });
    } catch(error){ next(error); }
});

app.get('/api/backup/export', async (req, res, next) => {
    if(!await checkAuth(req, res)){ return; }
    try {
        // ?target=upstream excludes NodeOnly-only inlay namespaces (inlay/,
        // inlay_sidecar/, inlay_meta/). Their entry names contain a slash,
        // which upstream RisuAI's import treats as a path under assets/ and
        // fails with ENOENT. The export becomes lossy on inlay images but
        // imports cleanly into upstream.
        const target = req.query.target === 'upstream' ? 'upstream' : 'nodeonly';
        // Flush any pending patches to ensure export includes latest data
        await flushPendingDb();
        const inlayFiles = target === 'upstream' ? [] : await listInlayFiles();
        const inlayEntries = await Promise.all(inlayFiles.map(async (entry) => {
            const stat = await fs.stat(entry.filePath);
            return {
                kind: 'file',
                sourcePath: entry.filePath,
                backupName: `inlay/${entry.id}.${entry.ext}`,
                sortKey: `inlay/${entry.id}`,
                size: stat.size,
            };
        }));
        const sidecarEntries = await Promise.all(inlayFiles.map(async (entry) => {
            const sidecarPath = getInlaySidecarPath(entry.id);
            try {
                const stat = await fs.stat(sidecarPath);
                return {
                    kind: 'sidecar',
                    sourcePath: sidecarPath,
                    backupName: `inlay_sidecar/${entry.id}`,
                    sortKey: `inlay_sidecar/${entry.id}`,
                    size: stat.size,
                };
            } catch {
                return null;
            }
        }));
        const inlayMetaEntries = target === 'upstream' ? [] : kvListWithSizes('inlay_meta/').map((entry) => ({
            kind: 'kv',
            key: entry.key,
            backupName: entry.key,
            sortKey: entry.key,
            size: entry.size,
        }));
        const namespacedEntries = [
            ...kvListWithSizes('assets/').map((entry) => ({
                kind: 'kv',
                key: entry.key,
                backupName: path.basename(entry.key),
                sortKey: entry.key,
                size: entry.size,
            })),
            ...listColdStorageBackupEntries(),
            ...inlayMetaEntries,
            ...inlayEntries,
            ...sidecarEntries.filter(Boolean),
        ].sort((a, b) => a.sortKey.localeCompare(b.sortKey));
        const dbSize = kvSize('database/database.bin');
        const totalBytes = namespacedEntries.reduce((sum, entry) => {
            return sum + 8 + Buffer.byteLength(entry.backupName, 'utf-8') + entry.size;
        }, 0) + (dbSize ? 8 + Buffer.byteLength('database.risudat', 'utf-8') + dbSize : 0);

        const filenameSuffix = target === 'upstream' ? '-upstream' : '';
        res.setHeader('content-type', 'application/octet-stream');
        res.setHeader('content-disposition', `attachment; filename="risu-backup-${Date.now()}${filenameSuffix}.bin"`);
        res.setHeader('content-length', totalBytes);
        res.setHeader('x-risu-backup-assets', namespacedEntries.length);

        let closed = false;
        res.once('close', () => { closed = true; });

        function waitForDrain() {
            if (closed) return Promise.resolve();
            return new Promise(resolve => {
                function done() {
                    res.removeListener('drain', done);
                    res.removeListener('close', done);
                    resolve();
                }
                res.once('drain', done);
                res.once('close', done);
            });
        }

        for (const entry of namespacedEntries) {
            if (closed) break;
            const value = entry.kind === 'kv'
                ? kvGet(entry.key)
                : entry.kind === 'buffer'
                    ? entry.buffer
                    : await fs.readFile(entry.sourcePath);
            if (closed) break;
            if (value) {
                const ok = res.write(encodeBackupEntry(entry.backupName, value));
                if (!ok) {
                    await waitForDrain();
                    if (closed) break;
                }
            }
        }

        if (!closed && dbSize) {
            const dbValue = kvGet('database/database.bin');
            if (dbValue) {
                const ok = res.write(encodeBackupEntry('database.risudat', dbValue));
                if (!ok) {
                    await waitForDrain();
                }
            }
        }
        if (!closed) res.end();
    } catch (error) {
        next(error);
    }
});

// Pre-flight check: auth + size + disk space before client starts uploading
app.post('/api/backup/import/prepare', async (req, res, next) => {
    if (!await checkAuth(req, res)) { return; }
    if (!checkActiveSession(req, res)) return;
    try {
        if (importInProgress) {
            res.status(409).json({ error: 'Another import is already in progress' });
            return;
        }

        const size = Number(req.body?.size ?? 0);
        if (BACKUP_IMPORT_MAX_BYTES > 0 && size > BACKUP_IMPORT_MAX_BYTES) {
            res.status(413).json({ error: `Backup exceeds max allowed size (${BACKUP_IMPORT_MAX_BYTES} bytes)` });
            return;
        }

        if (size > 0) {
            const disk = await checkDiskSpace(size * BACKUP_DISK_HEADROOM);
            if (!disk.ok) {
                res.status(507).json({
                    error: 'Insufficient disk space',
                    available: disk.available,
                    required: size * BACKUP_DISK_HEADROOM,
                });
                return;
            }
        }

        res.json({ ok: true });
    } catch (error) {
        next(error);
    }
});

app.post('/api/backup/import', async (req, res, next) => {
    if(!await checkAuth(req, res)){ return; }
    if (!checkActiveSession(req, res)) return;

    if (importInProgress) {
        res.status(409).json({ error: 'Another import is already in progress' });
        return;
    }
    importInProgress = true;

    // Disable timeouts for large backup uploads
    const prevRequestTimeout = req.socket.server?.requestTimeout;
    req.socket.setTimeout(0);
    req.socket.setKeepAlive(true);
    if (req.socket.server) req.socket.server.requestTimeout = 0;

    // NDJSON streaming keeps the response socket alive during long
    // post-upload work (WAL checkpoint, cold-storage migration). Without it
    // a reverse proxy in front of the server can hit its response timeout
    // and bounce the request back to the client as 502 Bad Gateway.
    const wantsNdjson = String(req.headers['accept'] ?? '').includes('application/x-ndjson');
    let heartbeatTimer = null;

    try {
        const contentType = String(req.headers['content-type'] ?? '');
        if (contentType && !contentType.includes('application/x-risu-backup') && !contentType.includes('application/octet-stream')) {
            res.status(415).json({ error: 'Unsupported backup content-type' });
            return;
        }

        const contentLength = Number(req.headers['content-length'] ?? '0');
        if (BACKUP_IMPORT_MAX_BYTES > 0 && Number.isFinite(contentLength) && contentLength > BACKUP_IMPORT_MAX_BYTES) {
            res.status(413).json({ error: `Backup exceeds max allowed size (${BACKUP_IMPORT_MAX_BYTES} bytes)` });
            return;
        }

        if (wantsNdjson) {
            res.setHeader('content-type', 'application/x-ndjson');
            res.setHeader('cache-control', 'no-cache, no-transform');
            // Disable nginx response buffering so progress events flush immediately.
            res.setHeader('x-accel-buffering', 'no');
            res.flushHeaders();

            // Periodic keepalive — covers the post-stream phase (commit,
            // inlay dir swap, cold storage migration) where onProgress is silent.
            heartbeatTimer = setInterval(() => {
                if (!res.writableEnded) res.write('{"type":"heartbeat"}\n');
            }, BACKUP_NDJSON_HEARTBEAT_MS);

            let lastProgressWrite = 0;
            const totalBytes = Number.isFinite(contentLength) ? contentLength : 0;
            const result = await importBackupFromSource(req, {
                maxBytes: BACKUP_IMPORT_MAX_BYTES,
                totalBytes,
                onProgress: (received, total) => {
                    const now = Date.now();
                    if (now - lastProgressWrite < 200) return;
                    lastProgressWrite = now;
                    res.write(JSON.stringify({ type: 'progress', bytes: received, totalBytes: total }) + '\n');
                },
            });
            res.write(JSON.stringify({
                type: 'done',
                ok: true,
                assetsRestored: result.assetsRestored,
                coldStorageFailed: result.coldStorageFailed,
            }) + '\n');
            res.end();
        } else {
            const result = await importBackupFromSource(req, { maxBytes: BACKUP_IMPORT_MAX_BYTES });
            res.json({
                ok: true,
                assetsRestored: result.assetsRestored,
                coldStorageFailed: result.coldStorageFailed,
            });
        }
    } catch (error) {
        if (wantsNdjson && res.headersSent) {
            try {
                res.write(JSON.stringify({ type: 'error', message: error?.message || 'backup import failed' }) + '\n');
                res.end();
            } catch (_) {}
        } else {
            next(error);
        }
    } finally {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        importInProgress = false;
        if (req.socket.server && prevRequestTimeout !== undefined) {
            req.socket.server.requestTimeout = prevRequestTimeout;
        }
    }
});

// ── Server-side backup endpoints ────────────────────────────────────────────

// Save current data as a .bin backup file on the server
app.post('/api/backup/server/save', async (req, res, next) => {
    if (!await checkAuth(req, res)) { return; }
    if (!checkActiveSession(req, res)) return;
    try {
        await flushPendingDb();

        // Pre-flight disk check — bail before streaming if the target dir
        // can't fit the backup. Avoids wasted minutes + half-written tmp files.
        try {
            const estimate = await estimateServerBackupSize();
            const required = Math.ceil(estimate * 1.05); // 5% safety margin
            const sf = await fs.statfs(backupsDir);
            const free = sf.bsize * sf.bavail;
            if (estimate > 0 && free < required) {
                return res.status(400).json({
                    error: `Insufficient disk space (need ~${(required / 1024 / 1024).toFixed(0)} MB, free ${(free / 1024 / 1024).toFixed(0)} MB)`,
                    code: 'insufficient_space',
                    required,
                    free,
                });
            }
        } catch (e) {
            // Non-fatal: log and proceed. statfs may be unavailable, in which
            // case the streaming fallback path below still fails gracefully.
            console.warn('[Backup] pre-flight disk check failed:', e?.message || e);
        }

        const inlayFiles = await listInlayFiles();
        const inlayEntries = await Promise.all(inlayFiles.map(async (entry) => {
            const stat = await fs.stat(entry.filePath);
            return { kind: 'file', sourcePath: entry.filePath, backupName: `inlay/${entry.id}.${entry.ext}`, size: stat.size };
        }));
        const sidecarEntries = (await Promise.all(inlayFiles.map(async (entry) => {
            const sidecarPath = getInlaySidecarPath(entry.id);
            try {
                const stat = await fs.stat(sidecarPath);
                return { kind: 'sidecar', sourcePath: sidecarPath, backupName: `inlay_sidecar/${entry.id}`, size: stat.size };
            } catch { return null; }
        }))).filter(Boolean);

        const namespacedEntries = [
            ...kvListWithSizes('assets/').map((e) => ({ kind: 'kv', key: e.key, backupName: path.basename(e.key), size: e.size })),
            ...listColdStorageBackupEntries(),
            ...kvListWithSizes('inlay_meta/').map((e) => ({ kind: 'kv', key: e.key, backupName: e.key, size: e.size })),
            ...inlayEntries,
            ...sidecarEntries,
        ];

        const totalEntries = namespacedEntries.length + 1; // +1 for database
        const totalBytes = namespacedEntries.reduce((sum, e) => sum + e.size, 0);

        // Stream progress as NDJSON
        res.setHeader('content-type', 'application/x-ndjson');
        res.flushHeaders();

        const filename = `risu-backup-${Date.now()}.bin`;
        const finalPath = path.join(backupsDir, filename);
        const tmpPath = finalPath + '.tmp';
        const { createWriteStream: createFsWriteStream } = require('fs');
        const writeStream = createFsWriteStream(tmpPath);

        let closed = false;
        let writeComplete = false;
        res.once('close', () => { closed = true; });

        try {
            await new Promise((resolve, reject) => {
                writeStream.on('error', reject);

                (async () => {
                    let written = 0;
                    let bytesWritten = 0;
                    for (const entry of namespacedEntries) {
                        if (closed) break;
                        const value = entry.kind === 'kv'
                            ? kvGet(entry.key)
                            : entry.kind === 'buffer'
                                ? entry.buffer
                                : await fs.readFile(entry.sourcePath);
                        if (value) {
                            const ok = writeStream.write(encodeBackupEntry(entry.backupName, value));
                            if (!ok) await new Promise(r => writeStream.once('drain', r));
                            bytesWritten += value.length;
                        }
                        written++;
                        if (written % 50 === 0 || written === namespacedEntries.length) {
                            res.write(JSON.stringify({ type: 'progress', current: written, total: totalEntries, bytes: bytesWritten, totalBytes }) + '\n');
                        }
                    }
                    if (closed) throw new Error('Client disconnected during backup save');
                    const dbValue = kvGet('database/database.bin');
                    if (dbValue) {
                        const ok = writeStream.write(encodeBackupEntry('database.risudat', dbValue));
                        if (!ok) await new Promise(r => writeStream.once('drain', r));
                        bytesWritten += dbValue.length;
                    }
                    res.write(JSON.stringify({ type: 'progress', current: totalEntries, total: totalEntries, bytes: bytesWritten, totalBytes }) + '\n');
                    writeStream.end(resolve);
                })().catch(reject);
            });

            // Atomic rename: only expose the file after successful write
            await fs.rename(tmpPath, finalPath);
            writeComplete = true;

            const stat = await fs.stat(finalPath);
            console.log(`[Server Backup] Saved: ${filename} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
            res.write(JSON.stringify({ type: 'done', ok: true, filename, size: stat.size }) + '\n');
            res.end();
        } catch (innerError) {
            // Clean up incomplete temp file
            if (!writeComplete) {
                await fs.unlink(tmpPath).catch(() => {});
            }
            throw innerError;
        }
    } catch (error) {
        if (!res.headersSent) {
            next(error);
        } else {
            res.write(JSON.stringify({ type: 'error', message: error.message }) + '\n');
            res.end();
        }
    }
});

// List backup files on the server
app.get('/api/backup/server/list', async (req, res, next) => {
    if (!await checkAuth(req, res)) { return; }
    try {
        let entries;
        try {
            entries = await fs.readdir(backupsDir, { withFileTypes: true });
        } catch {
            res.json({ backups: [] });
            return;
        }
        const backups = [];
        for (const entry of entries) {
            if (!entry.isFile() || !BACKUP_FILENAME_REGEX.test(entry.name)) continue;
            const stat = await fs.stat(path.join(backupsDir, entry.name));
            const tsMatch = entry.name.match(/^risu-backup-(\d+)\.bin$/);
            backups.push({
                filename: entry.name,
                size: stat.size,
                createdAt: tsMatch ? Number(tsMatch[1]) : stat.mtimeMs,
            });
        }
        backups.sort((a, b) => b.createdAt - a.createdAt);
        res.json({ backups });
    } catch (error) {
        next(error);
    }
});

// Restore from a server backup file
app.post('/api/backup/server/restore', async (req, res, next) => {
    if (!await checkAuth(req, res)) { return; }
    if (!checkActiveSession(req, res)) return;

    if (importInProgress) {
        res.status(409).json({ error: 'Another import is already in progress' });
        return;
    }
    importInProgress = true;

    try {
        const filename = req.body?.filename;
        if (!filename || !BACKUP_FILENAME_REGEX.test(filename)) {
            res.status(400).json({ error: 'Invalid backup filename' });
            return;
        }
        const filePath = path.join(backupsDir, filename);
        let fileStat;
        try {
            fileStat = await fs.stat(filePath);
        } catch {
            res.status(404).json({ error: 'Backup file not found' });
            return;
        }

        const disk = await checkDiskSpace(fileStat.size * BACKUP_DISK_HEADROOM);
        if (!disk.ok) {
            res.status(507).json({
                error: 'Insufficient disk space',
                available: disk.available,
                required: fileStat.size * BACKUP_DISK_HEADROOM,
            });
            return;
        }

        res.setHeader('content-type', 'application/x-ndjson');
        res.flushHeaders();

        let lastProgressWrite = 0;
        const { createReadStream } = require('fs');
        const stream = createReadStream(filePath, { highWaterMark: 256 * 1024 });
        const result = await importBackupFromSource(stream, {
            totalBytes: fileStat.size,
            onProgress: (received, total) => {
                const now = Date.now();
                if (now - lastProgressWrite < 200) return;
                lastProgressWrite = now;
                res.write(JSON.stringify({ type: 'progress', bytes: received, totalBytes: total }) + '\n');
            },
        });
        res.write(JSON.stringify({
            type: 'done',
            ok: true,
            assetsRestored: result.assetsRestored,
            coldStorageFailed: result.coldStorageFailed,
        }) + '\n');
        res.end();
    } catch (error) {
        if (!res.headersSent) {
            next(error);
        } else {
            res.write(JSON.stringify({ type: 'error', message: error.message }) + '\n');
            res.end();
        }
    } finally {
        importInProgress = false;
    }
});

// Delete a server backup file
app.delete('/api/backup/server/:filename', async (req, res, next) => {
    if (!await checkAuth(req, res)) { return; }
    if (!checkActiveSession(req, res)) return;
    try {
        const filename = req.params.filename;
        if (!BACKUP_FILENAME_REGEX.test(filename)) {
            res.status(400).json({ error: 'Invalid backup filename' });
            return;
        }
        const filePath = path.join(backupsDir, filename);
        try {
            await fs.unlink(filePath);
        } catch (err) {
            if (err.code === 'ENOENT') {
                res.status(404).json({ error: 'Backup file not found' });
                return;
            }
            throw err;
        }
        res.json({ ok: true });
    } catch (error) {
        next(error);
    }
});

// Download a server backup file
app.get('/api/backup/server/download/:filename', async (req, res, next) => {
    if (!await checkAuth(req, res)) { return; }
    try {
        const filename = req.params.filename;
        if (!BACKUP_FILENAME_REGEX.test(filename)) {
            res.status(400).json({ error: 'Invalid backup filename' });
            return;
        }
        const filePath = path.join(backupsDir, filename);
        let stat;
        try {
            stat = await fs.stat(filePath);
        } catch {
            res.status(404).json({ error: 'Backup file not found' });
            return;
        }
        res.setHeader('content-type', 'application/octet-stream');
        res.setHeader('content-disposition', `attachment; filename="${filename}"`);
        res.setHeader('content-length', stat.size);
        const { createReadStream } = require('fs');
        createReadStream(filePath).pipe(res);
    } catch (error) {
        next(error);
    }
});

// ── Chat content endpoints (runtime lazy load) ─────────────────────────────

// Cold storage compatibility: restore data stored in coldstorage/ KV entries
const COLD_STORAGE_HEADER = '\uEF01COLDSTORAGE\uEF01';

function restoreColdStorageCharacter(character) {
    if (!character?.coldstorage) return true;
    const key = character.coldstorage;
    const entry = readColdStorageJsonEntry(key, {
        migrateLegacy: true,
    });
    if (!entry) {
        logger.error(`[ColdStorage] character data not found for key: ${key}`);
        return false;
    }
    try {
        const coldData = entry.coldData;
        if (coldData?.character) {
            Object.assign(character, coldData.character);
            delete character.coldstorage;
            delete character.coldStoragedChats;
        } else {
            logger.error(`[ColdStorage] unexpected character cold data format for key: ${key}`);
            return false;
        }
        return true;
    } catch (err) {
        logger.error(`[ColdStorage] character restore failed for key ${key}:`, err.message);
        return false;
    }
}

function promoteFailedColdStorageStub(char) {
    const coldKey = char.coldstorage;
    // Fill in missing fields with safe defaults matching createBlankChar() in src/ts/characters.ts.
    // SYNC: if createBlankChar() defaults change, update this object to match.
    const defaults = {
        firstMessage: '', desc: '', notes: '', chatFolders: [],
        emotionImages: [], bias: [], viewScreen: 'none', globalLore: [],
        sdData: [
            ['always', 'solo, 1girl'], ['negative', ''],
            ["|character's appearance", ''], ['current situation', ''],
            ["$character's pose", ''], ["$character's emotion", ''],
            ['current location', ''],
        ],
        utilityBot: false, customscript: [], exampleMessage: '',
        creatorNotes: '', systemPrompt: '', postHistoryInstructions: '',
        alternateGreetings: [], tags: [], creator: '', characterVersion: '',
        personality: '', scenario: '',
        firstMsgIndex: -1,
        replaceGlobalNote: '', additionalText: '',
        triggerscript: [
            { comment: '', type: 'manual', conditions: [], effect: [{ type: 'v2Header', code: '', indent: 0 }] },
            { comment: 'New Event', type: 'manual', conditions: [], effect: [] },
        ],
    };
    for (const [key, value] of Object.entries(defaults)) {
        if (char[key] === undefined || char[key] === null) {
            char[key] = value;
        }
    }
    // Force firstMsgIndex to -1 even if stub had 0 — prevents alternateGreetings[0] access on empty array
    char.firstMsgIndex = -1;
    // Ensure chats array is valid
    if (!Array.isArray(char.chats) || char.chats.length === 0) {
        char.chats = [{ message: [], note: '', name: 'Chat 1', localLore: [] }];
    }
    // Leave recovery breadcrumb and remove cold storage markers
    char.desc = `[Cold storage restore failed. Original key: ${coldKey}]\n\n${char.desc || ''}`.trim();
    delete char.coldstorage;
    delete char.coldStoragedChats;
}

function restoreColdStorageCharactersInDb(dbObj) {
    const result = { restored: 0, failed: 0, failedNames: [] };
    if (!Array.isArray(dbObj?.characters)) return result;
    for (let i = 0; i < dbObj.characters.length; i++) {
        const char = dbObj.characters[i];
        if (!char?.coldstorage) continue;
        if (restoreColdStorageCharacter(char)) {
            result.restored++;
        } else {
            result.failed++;
            result.failedNames.push(char.name || `(index ${i})`);
            promoteFailedColdStorageStub(char);
        }
    }
    return result;
}

function isColdStorageChat(chat) {
    return chat?.message?.[0]?.data?.startsWith(COLD_STORAGE_HEADER);
}

function restoreColdStorageChat(chat) {
    if (!isColdStorageChat(chat)) return true;
    const key = chat.message[0].data.slice(COLD_STORAGE_HEADER.length);
    const entry = readColdStorageJsonEntry(key, {
        migrateLegacy: true,
    });
    if (!entry) {
        logger.error(`[ColdStorage] data not found for key: ${key}`);
        return false;
    }
    try {
        const coldData = entry.coldData;
        if (Array.isArray(coldData)) {
            chat.message = coldData;
        } else if (coldData?.message) {
            chat.message = coldData.message;
            if (coldData.hypaV3Data) chat.hypaV3Data = coldData.hypaV3Data;
            if (coldData.scriptstate) chat.scriptstate = coldData.scriptstate;
            if (coldData.localLore) chat.localLore = coldData.localLore;
        }
        chat.lastDate = Date.now();
        return true;
    } catch (err) {
        logger.error(`[ColdStorage] restore failed for key ${key}:`, err.message);
        return false;
    }
}

// GET /api/chat-content/:chaId/:chatIndex — retrieve full chat from server
app.get('/api/chat-content/:chaId/:chatIndex', async (req, res, next) => {
    if (!await checkAuth(req, res)) { return; }
    try {
        const chaId = req.params.chaId;
        const chatIndex = parseInt(req.params.chatIndex, 10);
        const expectedChatId = req.headers['x-chat-id'];

        await ensureChatStore();
        // First try fullChatStore (fast path)
        const charChats = fullChatStore.get(chaId);
        if (charChats && expectedChatId) {
            const chat = charChats.get(expectedChatId);
            if (chat) {
                if (!restoreColdStorageChat(chat)) {
                    return res.status(500).json({ error: 'Cold storage restore failed' });
                }
                const encoded = Buffer.from(encodeRisuSaveLegacy(chat));
                res.setHeader('Content-Type', 'application/octet-stream');
                return res.send(encoded);
            }
        }

        // Fallback: load from disk and find by index
        const raw = kvGet('database/database.bin');
        if (!raw) {
            return res.status(404).json({ error: 'Database not found' });
        }
        const dbObj = await decodeRisuSave(raw);
        const char = dbObj.characters?.find(c => c?.chaId === chaId);
        if (!char?.chats?.[chatIndex]) {
            return res.status(404).json({ error: 'Chat not found' });
        }
        const chat = char.chats[chatIndex];
        // Verify chatId matches if provided
        if (expectedChatId && chat.id !== expectedChatId) {
            return res.status(409).json({ error: 'Chat ID mismatch — index may have shifted' });
        }
        if (!restoreColdStorageChat(chat)) {
            return res.status(500).json({ error: 'Cold storage restore failed' });
        }
        const encoded = Buffer.from(encodeRisuSaveLegacy(chat));
        res.setHeader('Content-Type', 'application/octet-stream');
        res.send(encoded);
    } catch (error) {
        next(error);
    }
});

// POST /api/chat-content/:chaId/:chatIndex — save chat content to server
app.post('/api/chat-content/:chaId/:chatIndex', async (req, res, next) => {
    if (!await checkAuth(req, res)) { return; }
    if (!checkActiveSession(req, res)) return;
    try {
        await queueStorageOperation(async () => {
            const chaId = req.params.chaId;
            const chatIndex = parseInt(req.params.chatIndex, 10);
            const expectedChatId = req.headers['x-chat-id'];
            let chatData;
            if (Buffer.isBuffer(req.body)) {
                // Binary msgpack body (application/octet-stream)
                try {
                    chatData = await decodeRisuSave(req.body);
                } catch (e) {
                    return res.status(400).json({ error: 'Invalid binary chat data' });
                }
            } else {
                // JSON body (legacy)
                chatData = req.body;
            }

            if (!chatData || !expectedChatId) {
                return res.status(400).json({ error: 'Chat data and x-chat-id required' });
            }

            await ensureChatStore();

            // Update fullChatStore
            if (!fullChatStore.has(chaId)) {
                fullChatStore.set(chaId, new Map());
            }
            fullChatStore.get(chaId).set(expectedChatId, chatData);

            // Schedule debounced persist (reuses existing timer mechanism)
            if (saveTimers[DB_HEX_KEY]) {
                clearTimeout(saveTimers[DB_HEX_KEY]);
            }
            saveTimers[DB_HEX_KEY] = setTimeout(async () => {
                try {
                    // If dbCache has stripped DB, persist with merged chats
                    if (dbCache[DB_HEX_KEY]) {
                        await persistDbCacheWithChats(DB_HEX_KEY, 'database/database.bin');
                    } else {
                        // No stripped cache — load, merge, save
                        const raw = kvGet('database/database.bin');
                        if (raw) {
                            const dbObj = normalizeJSON(await decodeRisuSave(raw));
                            const fullDb = reassembleFullDb(stripChatsFromDb(dbObj));
                            const encoded = Buffer.from(encodeRisuSaveLegacy(fullDb));
                            try {
                                kvSet('database/database.bin', encoded);
                            } catch (err) {
                                if (err && typeof err === 'object') {
                                    try { err.attemptedSize = encoded.length; } catch {}
                                }
                                throw err;
                            }
                        }
                    }
                    // Persist succeeded — clear before backup so a backup-only
                    // failure isn't attributed to data loss.
                    clearPersistFailure();
                    try {
                        createBackupAndRotate();
                    } catch (backupErr) {
                        logger.warn('[ChatContent] Backup rotation failed:', backupErr);
                    }
                } catch (error) {
                    logger.error('[ChatContent] Error persisting chat:', error);
                    recordPersistFailure(error, 'chat-content');
                } finally {
                    delete saveTimers[DB_HEX_KEY];
                }
            }, SAVE_INTERVAL);

            res.json({ success: true });
        });
    } catch (error) {
        next(error);
    }
});

// ── Save-folder migration endpoints ──────────────────────────────────────────
const migrationMarkerPath = path.join(savePath, '.migrated_to_sqlite');

function scanHexFilesInDir(dirPath) {
    let files;
    try {
        files = readdirSync(dirPath);
    } catch {
        return { hexFiles: [], count: 0, totalSize: 0, hasDatabase: false };
    }
    const hexFiles = files.filter(f => hexRegex.test(f));
    let totalSize = 0;
    let hasDatabase = false;
    for (const f of hexFiles) {
        try {
            const stat = require('fs').statSync(path.join(dirPath, f));
            totalSize += stat.size;
        } catch { /* skip unreadable files */ }
        try {
            if (Buffer.from(f, 'hex').toString('utf-8') === 'database/database.bin') hasDatabase = true;
        } catch { /* invalid hex */ }
    }
    return { hexFiles, count: hexFiles.length, totalSize, hasDatabase };
}

function clearExistingData() {
    kvDelPrefix('assets/');
    kvDelPrefix('inlay/');
    kvDelPrefix('inlay_thumb/');
    kvDelPrefix('inlay_meta/');
    kvDelPrefix('inlay_info/');
    // Composer drafts aren't part of a save folder; clear stale ones on import.
    kvDelPrefix('drafts/');
    // Drop the previous user's remote payloads. The new save folder usually
    // brings its own remotes/<id>.local.bin files (INSERT OR REPLACE), but if
    // the imported character ids reuse names from the prior user without
    // shipping a matching payload, the migration's resolveRemote would silently
    // stitch in stale cross-user data. Wiping here ensures only payloads
    // that arrived in this import survive.
    kvDelPrefix('remotes/');
    // Clear remote-block migration marker — newly imported database.bin may
    // contain REMOTE blocks (it usually does, since save-folder imports
    // preserve upstream's split-character format) and we want the migration
    // to re-evaluate against the new contents on the next ensureChatStore.
    kvDel(REMOTE_MIGRATION_MARKER_KEY);
    clearEntities();
}

async function importHexFilesFromDir(dirPath) {
    const { hexFiles, hasDatabase } = scanHexFilesInDir(dirPath);
    if (hexFiles.length === 0) return { imported: 0 };
    if (!hasDatabase) throw new Error('Save folder does not contain database/database.bin');

    await flushPendingDb();
    createBackupAndRotate();
    invalidateDbCache();

    const insert = sqliteDb.prepare(
        `INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)`
    );
    const now = Date.now();

    const run = sqliteDb.transaction(() => {
        clearExistingData();
        for (const hexFile of hexFiles) {
            const key = Buffer.from(hexFile, 'hex').toString('utf-8');
            const value = readFileSync(path.join(dirPath, hexFile));
            // Chunk the DB blob so an oversized database.bin imports instead of
            // failing the BLOB bind limit; other keys keep the bulk fast path.
            if (key === DB_BLOB_KEY) { kvSet(key, value); continue; }
            insert.run(key, value, now);
        }
    });
    run();

    writeFileSync(migrationMarkerPath, new Date().toISOString(), 'utf-8');
    return { imported: hexFiles.length };
}

async function importHexEntries(entries) {
    if (entries.length === 0) return { imported: 0 };
    const hasDb = entries.some(e => e.key === 'database/database.bin');
    if (!hasDb) throw new Error('Data does not contain database/database.bin');

    await flushPendingDb();
    createBackupAndRotate();
    invalidateDbCache();

    const insert = sqliteDb.prepare(
        `INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)`
    );
    const now = Date.now();

    const run = sqliteDb.transaction(() => {
        clearExistingData();
        for (const { key, value } of entries) {
            // Chunk the DB blob so an oversized database.bin imports instead of
            // failing the BLOB bind limit; other keys keep the bulk fast path.
            if (key === DB_BLOB_KEY) { kvSet(key, value); continue; }
            insert.run(key, value, now);
        }
    });
    run();

    writeFileSync(migrationMarkerPath, new Date().toISOString(), 'utf-8');
    return { imported: entries.length };
}

app.post('/api/migrate/save-folder/scan', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    try {
        const folderPath = req.body?.path || savePath;
        const resolved = path.resolve(folderPath);
        try {
            const stat = require('fs').statSync(resolved);
            if (!stat.isDirectory()) {
                res.status(400).json({ error: 'Path is not a directory' });
                return;
            }
        } catch {
            res.status(400).json({ error: 'Cannot access directory' });
            return;
        }
        const { count, totalSize, hasDatabase } = scanHexFilesInDir(resolved);
        res.json({ count, totalSize, hasDatabase });
    } catch (error) {
        next(error);
    }
});

app.post('/api/migrate/save-folder/execute', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    if (importInProgress) {
        res.status(409).json({ error: 'Another import is already in progress' });
        return;
    }
    importInProgress = true;
    try {
        const folderPath = req.body?.path || savePath;
        const resolved = path.resolve(folderPath);
        try {
            const stat = require('fs').statSync(resolved);
            if (!stat.isDirectory()) {
                res.status(400).json({ error: 'Path is not a directory' });
                return;
            }
        } catch {
            res.status(400).json({ error: 'Cannot access directory' });
            return;
        }
        const result = await importHexFilesFromDir(resolved);
        res.json({ ok: true, imported: result.imported });
    } catch (error) {
        res.status(400).json({ error: error.message || 'Import failed' });
    } finally {
        importInProgress = false;
    }
});

app.post('/api/migrate/save-folder/upload', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    if (importInProgress) {
        res.status(409).json({ error: 'Another import is already in progress' });
        return;
    }
    importInProgress = true;

    req.socket.setTimeout(0);
    req.socket.setKeepAlive(true);
    const prevRequestTimeout = req.socket.server?.requestTimeout;
    if (req.socket.server) req.socket.server.requestTimeout = 0;

    try {
        const chunks = [];
        let totalSize = 0;
        for await (const chunk of req) {
            totalSize += chunk.length;
            if (BACKUP_IMPORT_MAX_BYTES > 0 && totalSize > BACKUP_IMPORT_MAX_BYTES) {
                res.status(413).json({ error: 'Zip file exceeds max allowed size' });
                return;
            }
            chunks.push(chunk);
        }
        const zipBuffer = Buffer.concat(chunks);

        const fflate = require('fflate');
        let unzipped;
        try {
            unzipped = fflate.unzipSync(new Uint8Array(zipBuffer));
        } catch {
            res.status(400).json({ error: 'Invalid or corrupted zip file' });
            return;
        }

        const entries = [];
        for (const [entryPath, data] of Object.entries(unzipped)) {
            if (data.length === 0) continue;
            const basename = path.basename(entryPath);
            if (!hexRegex.test(basename)) continue;
            try {
                const key = Buffer.from(basename, 'hex').toString('utf-8');
                entries.push({ key, value: Buffer.from(data) });
            } catch { /* invalid hex filename */ }
        }

        if (entries.length === 0) {
            res.status(400).json({ error: 'No compatible hex files found in zip' });
            return;
        }

        const result = await importHexEntries(entries);
        res.json({ ok: true, imported: result.imported });
    } catch (error) {
        res.status(400).json({ error: error.message || 'Import failed' });
    } finally {
        importInProgress = false;
        if (req.socket.server && prevRequestTimeout !== undefined) {
            req.socket.server.requestTimeout = prevRequestTimeout;
        }
    }
});

app.post('/api/migrate/save-folder/cleanup/scan', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    try {
        if (!existsSync(migrationMarkerPath)) {
            res.status(400).json({ error: 'Migration has not been completed yet' });
            return;
        }
        const { count, totalSize } = scanHexFilesInDir(savePath);
        res.json({ count, totalSize });
    } catch (error) {
        next(error);
    }
});

app.post('/api/migrate/save-folder/cleanup/execute', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    try {
        if (!existsSync(migrationMarkerPath)) {
            res.status(400).json({ error: 'Migration has not been completed yet' });
            return;
        }
        const { hexFiles } = scanHexFilesInDir(savePath);
        let removed = 0;
        let freedBytes = 0;
        for (const f of hexFiles) {
            try {
                const filePath = path.join(savePath, f);
                const stat = require('fs').statSync(filePath);
                unlinkSync(filePath);
                freedBytes += stat.size;
                removed++;
            } catch { /* skip unremovable files */ }
        }
        res.json({ ok: true, removed, freedBytes });
    } catch (error) {
        next(error);
    }
});

// ── Storage dashboard endpoints ──────────────────────────────────────────────

const DB_BLOB_KEY = 'database/database.bin';
const DB_BACKUP_PREFIX = 'database/dbbackup-';
const ASSET_PREFIXES = ['assets/', 'remotes/', 'inlay/', 'inlay_thumb/', 'inlay_meta/', 'inlay_info/', 'coldstorage/'];

function statsBasename(s) {
    if (!s) return '';
    return String(s).replace(/\\/g, '/').split('/').pop();
}

// Mirrors src/ts/globalApi.svelte.ts:getUncleanables — every asset reference reachable from the DB.
function buildUncleanableSet(dbObj) {
    const set = new Set();
    const add = (v) => {
        const bn = statsBasename(v);
        if (bn) set.add(bn);
    };
    if (!dbObj) return set;
    add(dbObj.customBackground);
    add(dbObj.userIcon);
    if (Array.isArray(dbObj.characters)) {
        for (const cha of dbObj.characters) {
            if (!cha) continue;
            add(cha.image);
            if (Array.isArray(cha.emotionImages)) for (const em of cha.emotionImages) add(em?.[1]);
            if (Array.isArray(cha.additionalAssets)) for (const em of cha.additionalAssets) add(em?.[1]);
            if (cha.vits?.files) for (const k of Object.keys(cha.vits.files)) add(cha.vits.files[k]);
            if (Array.isArray(cha.ccAssets)) for (const a of cha.ccAssets) add(a?.uri);
        }
    }
    if (Array.isArray(dbObj.modules)) {
        for (const m of dbObj.modules) if (Array.isArray(m?.assets)) for (const a of m.assets) add(a?.[1]);
    }
    if (Array.isArray(dbObj.personas)) for (const p of dbObj.personas) add(p?.icon);
    if (Array.isArray(dbObj.characterOrder)) {
        for (const item of dbObj.characterOrder) {
            if (item && typeof item === 'object' && 'imgFile' in item) add(item.imgFile);
        }
    }
    return set;
}

function statSafe(p) {
    try { return require('fs').statSync(p); } catch { return null; }
}

async function diskFreeStat(dirPath) {
    try {
        const sf = await fs.statfs(dirPath);
        return { free: sf.bsize * sf.bavail, total: sf.bsize * sf.blocks };
    } catch { return { free: null, total: null }; }
}

// Sum the on-disk inlay payload (image files + sidecar JSONs in save/inlays).
// Returns 0 if the directory is missing. Used by both the backup-size
// estimator and the dashboard inlay total — kv inlay/* prefixes don't
// reflect filesystem bytes after the inlay→fs migration.
async function sumInlayFsBytes() {
    let total = 0;
    try {
        const inlayFiles = await listInlayFiles();
        await Promise.all(inlayFiles.map(async (entry) => {
            try {
                const st = await fs.stat(entry.filePath);
                total += st.size;
            } catch { /* missing — skip */ }
            try {
                const sst = await fs.stat(getInlaySidecarPath(entry.id));
                total += sst.size;
            } catch { /* sidecar may not exist */ }
        }));
    } catch { /* dir missing */ }
    return total;
}

// Estimated server-backup size — mirrors the enumeration in
// /api/backup/server/save without writing anything. Inlay files live on the
// filesystem (post-migration), so we have to fs.stat them rather than read
// kvSize. Cost: ~5-50 ms typical, ~200 ms for users with thousands of inlays.
async function estimateServerBackupSize() {
    let total = 0;
    total += kvSize(DB_BLOB_KEY) || 0;
    for (const it of kvListWithSizes('assets/')) total += it.size;
    for (const it of kvListWithSizes('inlay_meta/')) total += it.size;
    for (const e of listColdStorageBackupEntries()) total += e.size;
    total += await sumInlayFsBytes();
    return total;
}

app.get('/api/db/stats', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    try {
        const saveDir = path.join(process.cwd(), 'save');
        const dbFilePath = path.join(saveDir, 'risuai.db');
        const walPath = dbFilePath + '-wal';
        const shmPath = dbFilePath + '-shm';

        const files = {
            db: statSafe(dbFilePath)?.size ?? 0,
            wal: statSafe(walPath)?.size ?? 0,
            shm: statSafe(shmPath)?.size ?? 0,
        };

        const disk = await diskFreeStat(saveDir);
        // Backup destination disk — same as save/ in the default config but
        // can diverge when the user points backupsDir at a different mount.
        // Surfaced separately so backup-side warnings target the right disk.
        // `sameAsSaveDir` is true when both paths land on the same filesystem
        // (compared by Stat.dev). Dashboard uses this to decide whether to
        // count file backups against the save/ disk in the storage chart.
        let backupDisk;
        if (backupsDir === DEFAULT_BACKUPS_DIR) {
            backupDisk = { ...disk, path: backupsDir, sameAsSaveDir: true };
        } else {
            const bDisk = await diskFreeStat(backupsDir);
            let sameAsSaveDir = false;
            try {
                const saveStat = require('fs').statSync(saveDir);
                const bStat = require('fs').statSync(backupsDir);
                sameAsSaveDir = saveStat.dev === bStat.dev;
            } catch { /* non-fatal */ }
            backupDisk = { ...bDisk, path: backupsDir, sameAsSaveDir };
        }

        const pageSize = sqliteDb.pragma('page_size', { simple: true });
        const pageCount = sqliteDb.pragma('page_count', { simple: true });
        const freelistCount = sqliteDb.pragma('freelist_count', { simple: true });
        const journalMode = sqliteDb.pragma('journal_mode', { simple: true });
        const autoVacuum = sqliteDb.pragma('auto_vacuum', { simple: true });
        const reclaimable = freelistCount * pageSize;

        const dbBlobSize = kvSize(DB_BLOB_KEY) || 0;

        // Physical storage of the chunked DB blob (and all snapshots, which share
        // chunks). This is where the blob bytes actually live post-chunking — kv
        // holds only a tiny marker, so the chart must count this table separately.
        const chunkStat = sqliteDb.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(LENGTH(data)), 0) AS b FROM chunks').get();
        // Bytes the next gc() would reclaim (true orphans + chunks pinned only by
        // stale/raw-overwritten manifests) — drives the Optimize button.
        const orphanChunkBytes = reclaimableChunkBytes();
        const liveChunked = isDbBlobChunked();

        // Prefix breakdown — split database/ into the live blob vs rotated backups.
        const prefixes = {};
        prefixes[DB_BLOB_KEY] = { totalSize: dbBlobSize, count: dbBlobSize > 0 ? 1 : 0 };
        const backupKeys = kvList(DB_BACKUP_PREFIX);
        let backupTotal = 0;
        let backupOldest = null, backupNewest = null;
        for (const k of backupKeys) {
            const sz = kvSize(k) || 0;
            backupTotal += sz;
            const tsRaw = parseInt(k.slice(DB_BACKUP_PREFIX.length, -4), 10);
            if (Number.isFinite(tsRaw)) {
                const ts = tsRaw * 100;
                if (!backupOldest || ts < backupOldest) backupOldest = ts;
                if (!backupNewest || ts > backupNewest) backupNewest = ts;
            }
        }
        prefixes[DB_BACKUP_PREFIX] = { totalSize: backupTotal, count: backupKeys.length };
        for (const p of ASSET_PREFIXES) {
            const items = kvListWithSizes(p);
            let total = 0;
            for (const it of items) total += it.size;
            prefixes[p] = { totalSize: total, count: items.length };
        }

        const kvRows = sqliteDb.prepare('SELECT COUNT(*) AS c FROM kv').get().c;
        const kvTotalBytes = sqliteDb.prepare('SELECT COALESCE(SUM(LENGTH(value)), 0) AS s FROM kv').get().s;

        let fileBackups = { count: 0, totalSize: 0, oldest: null, newest: null };
        try {
            const entries = await fs.readdir(backupsDir, { withFileTypes: true });
            for (const e of entries) {
                if (!e.isFile() || !BACKUP_FILENAME_REGEX.test(e.name)) continue;
                const st = await fs.stat(path.join(backupsDir, e.name));
                fileBackups.count++;
                fileBackups.totalSize += st.size;
                const ts = st.mtimeMs;
                if (!fileBackups.oldest || ts < fileBackups.oldest) fileBackups.oldest = ts;
                if (!fileBackups.newest || ts > fileBackups.newest) fileBackups.newest = ts;
            }
        } catch { /* backups dir may not exist */ }

        // Quick estimates from in-memory cache only — never decode the BLOB just for stats.
        let trashed = { count: 0, expiredCount: 0, available: false };
        let orphan = { count: 0, totalSize: 0, available: false };
        const stripped = dbCache[DB_HEX_KEY];
        if (stripped?.characters) {
            const now = Date.now();
            const GRACE = 1000 * 60 * 60 * 24 * 3;
            for (const c of stripped.characters) {
                if (c?.trashTime) {
                    trashed.count++;
                    if (c.trashTime + GRACE < now) trashed.expiredCount++;
                }
            }
            trashed.available = true;
        }
        if (stripped) {
            const uncleanable = buildUncleanableSet(stripped);
            for (const it of kvListWithSizes('assets/')) {
                if (!uncleanable.has(statsBasename(it.key))) {
                    orphan.count++;
                    orphan.totalSize += it.size;
                }
            }
            orphan.available = true;
        }

        const estimatedBackupSize = await estimateServerBackupSize();
        // Inlay payload now lives on the filesystem (post-migration) rather
        // than in kv `inlay/*` prefixes. Surface explicitly so the dashboard
        // chart can include it in the inlay slice instead of underreporting.
        const inlayFsBytes = await sumInlayFsBytes();

        res.json({
            files,
            disk,
            backupDisk,
            sqlite: { pageSize, pageCount, freelistCount, reclaimable, journalMode, autoVacuum },
            chunks: { count: chunkStat.c, bytes: chunkStat.b, orphanBytes: orphanChunkBytes, liveChunked },
            prefixes,
            kvRows,
            kvTotalBytes,
            estimatedBackupSize,
            inlayFsBytes,
            backups: {
                kv: { count: backupKeys.length, totalSize: backupTotal, oldest: backupOldest, newest: backupNewest },
                file: fileBackups,
            },
            trashed,
            orphan,
            etag: dbEtag,
        });
    } catch (err) { next(err); }
});

app.get('/api/db/stats/characters', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    try {
        await ensureChatStore();
        const raw = kvGet(DB_BLOB_KEY);
        if (!raw) {
            res.json({ characters: [], orphan: { count: 0, totalSize: 0 }, chatBytesNote: 'estimate' });
            return;
        }
        const dbObj = await decodeRisuSave(raw);

        const assetSize = new Map();
        for (const it of kvListWithSizes('assets/')) {
            assetSize.set(statsBasename(it.key), it.size);
        }
        // remotes/<chaId>.local.bin (+ optional .meta sidecar) → bucket by chaId.
        const remoteSize = new Map();
        for (const it of kvListWithSizes('remotes/')) {
            const bn = statsBasename(it.key).replace(/\.meta$/, '');
            const chaId = bn.replace(/\.local\.bin$/, '');
            if (chaId) remoteSize.set(chaId, (remoteSize.get(chaId) || 0) + it.size);
        }

        const claimed = new Set();
        const characters = [];
        const list = Array.isArray(dbObj.characters) ? dbObj.characters : [];
        for (const cha of list) {
            if (!cha) continue;
            const refs = [];
            const collect = (v) => { if (v) refs.push(statsBasename(v)); };
            collect(cha.image);
            if (Array.isArray(cha.emotionImages)) for (const em of cha.emotionImages) collect(em?.[1]);
            if (Array.isArray(cha.additionalAssets)) for (const em of cha.additionalAssets) collect(em?.[1]);
            if (cha.vits?.files) for (const k of Object.keys(cha.vits.files)) collect(cha.vits.files[k]);
            if (Array.isArray(cha.ccAssets)) for (const a of cha.ccAssets) collect(a?.uri);

            // Same asset shared across characters is attributed to the first one we see — avoids double-counting.
            let imgBytes = 0;
            for (const bn of refs) {
                if (!bn || claimed.has(bn)) continue;
                const sz = assetSize.get(bn);
                if (sz != null) {
                    imgBytes += sz;
                    claimed.add(bn);
                }
            }
            const remoteBytes = remoteSize.get(cha.chaId) || 0;

            let chatBytes = 0;
            const charChats = fullChatStore?.get(cha.chaId);
            if (charChats) {
                for (const chat of charChats.values()) {
                    try { chatBytes += JSON.stringify(chat).length; } catch { /* skip un-serializable */ }
                }
            }

            // Card body = the character row minus chats (which we count separately).
            // Asset URIs themselves are tiny strings — leaving them in card body is fine.
            let cardBytes = 0;
            try {
                const { chats: _drop, ...body } = cha;
                cardBytes = JSON.stringify(body).length;
            } catch { /* skip un-serializable */ }

            characters.push({
                chaId: cha.chaId || '',
                name: cha.name || '',
                image: cha.image || '',
                trashed: !!cha.trashTime,
                cardBytes,
                imgBytes: imgBytes + remoteBytes,
                chatBytes,
                totalBytes: cardBytes + imgBytes + remoteBytes + chatBytes,
            });
        }

        const uncleanable = buildUncleanableSet(dbObj);
        let orphanCount = 0, orphanTotal = 0;
        for (const it of kvListWithSizes('assets/')) {
            if (!uncleanable.has(statsBasename(it.key))) {
                orphanCount++;
                orphanTotal += it.size;
            }
        }

        characters.sort((a, b) => b.totalBytes - a.totalBytes);
        res.json({
            characters,
            orphan: { count: orphanCount, totalSize: orphanTotal },
            chatBytesNote: 'JSON.stringify estimate; on-disk msgpack ~0.6×',
            etag: dbEtag,
        });
    } catch (err) { next(err); }
});

// Per-module breakdown — modules live inside database.bin (no separate kv keys
// for module bodies), so size = JSON.stringify of the module + sum of its
// referenced assets. Assets attribution is independent from /characters; an
// asset shared between a character and a module would be counted in both.
app.get('/api/db/stats/modules', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    try {
        const raw = kvGet(DB_BLOB_KEY);
        if (!raw) {
            res.json({ modules: [] });
            return;
        }
        const dbObj = await decodeRisuSave(raw);
        const list = Array.isArray(dbObj.modules) ? dbObj.modules : [];

        const assetSize = new Map();
        for (const it of kvListWithSizes('assets/')) {
            assetSize.set(statsBasename(it.key), it.size);
        }

        const modules = [];
        for (const m of list) {
            if (!m) continue;

            let bodyBytes = 0;
            try {
                const { assets: _drop, ...body } = m;
                bodyBytes = JSON.stringify(body).length;
            } catch { /* skip un-serializable */ }

            let assetBytes = 0;
            const seen = new Set();
            if (Array.isArray(m.assets)) {
                for (const a of m.assets) {
                    const bn = statsBasename(a?.[1]);
                    if (!bn || seen.has(bn)) continue;
                    seen.add(bn);
                    const sz = assetSize.get(bn);
                    if (sz != null) assetBytes += sz;
                }
            }

            modules.push({
                id: m.id || m.namespace || m.name || '',
                name: m.name || m.namespace || '',
                bodyBytes,
                assetBytes,
                totalBytes: bodyBytes + assetBytes,
            });
        }

        modules.sort((a, b) => b.totalBytes - a.totalBytes);
        res.json({ modules, etag: dbEtag });
    } catch (err) { next(err); }
});

app.post('/api/db/optimize', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    try {
        const saveDir = path.join(process.cwd(), 'save');
        const dbFilePath = path.join(saveDir, 'risuai.db');
        const preDbSize = statSafe(dbFilePath)?.size ?? 0;

        const { free } = await diskFreeStat(saveDir);
        if (preDbSize > 0 && free != null && free < preDbSize * 1.2) {
            return res.status(400).json({
                error: 'Insufficient disk space for VACUUM',
                required: Math.ceil(preDbSize * 1.2),
                free,
            });
        }

        const result = await queueStorageOperation(async () => {
            await flushPendingDb();
            const t0 = Date.now();
            // Reclaim chunks orphaned by edits/snapshot rotation before VACUUM, so
            // their pages get compacted in the same pass. Serialized with saves by
            // the surrounding queueStorageOperation.
            let gcDeleted = 0;
            try { gcDeleted = gcChunks(); } catch (e) { logger.warn('[Optimize] chunk gc failed:', e?.message || e); }
            try { checkpointWal('TRUNCATE'); } catch (e) { logger.warn('[Optimize] checkpoint failed:', e?.message || e); }
            sqliteDb.exec('VACUUM');
            // VACUUM streams the whole DB through the WAL; without this checkpoint the
            // -wal file stays inflated until the next 5-min background TRUNCATE.
            try { checkpointWal('TRUNCATE'); } catch (e) { logger.warn('[Optimize] post-VACUUM checkpoint failed:', e?.message || e); }
            const elapsed = Date.now() - t0;
            const postDbSize = statSafe(dbFilePath)?.size ?? 0;
            return {
                ok: true,
                elapsedMs: elapsed,
                preDbSize,
                postDbSize,
                reclaimed: Math.max(0, preDbSize - postDbSize),
                chunksReclaimed: gcDeleted,
            };
        });
        res.json(result);
    } catch (err) { next(err); }
});

app.post('/api/db/wal-checkpoint', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    try {
        const saveDir = path.join(process.cwd(), 'save');
        const walFilePath = path.join(saveDir, 'risuai.db-wal');
        const preWalSize = statSafe(walFilePath)?.size ?? 0;

        const result = await queueStorageOperation(async () => {
            await flushPendingDb();
            const t0 = Date.now();
            checkpointWal('TRUNCATE');
            const elapsed = Date.now() - t0;
            const postWalSize = statSafe(walFilePath)?.size ?? 0;
            return {
                ok: true,
                elapsedMs: elapsed,
                preWalSize,
                postWalSize,
                reclaimed: Math.max(0, preWalSize - postWalSize),
            };
        });
        res.json(result);
    } catch (err) { next(err); }
});

// ── Snapshot list (database/dbbackup-* keys) ─────────────────────────────────

app.get('/api/db/snapshots/limits', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    try {
        const { maxCount, maxBytes } = getSnapshotLimits();
        const usage = snapshotUsage();
        res.json({
            maxCount,
            maxBytes,
            currentCount: usage.count,
            currentBytes: usage.bytes,
            logicalBytes: usage.logicalBytes,
            bounds: {
                minCount: SNAPSHOT_LIMIT_MIN_COUNT,
                maxCount: SNAPSHOT_LIMIT_MAX_COUNT,
                minBytes: SNAPSHOT_LIMIT_MIN_BYTES,
                maxBytes: SNAPSHOT_LIMIT_MAX_BYTES,
            },
            defaults: {
                count: SNAPSHOT_LIMIT_DEFAULT_COUNT,
                bytes: SNAPSHOT_LIMIT_DEFAULT_BYTES,
            },
        });
    } catch (err) { next(err); }
});

app.put('/api/db/snapshots/limits', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    try {
        const rawCount = Number(req.body?.maxCount);
        const rawBytes = Number(req.body?.maxBytes);
        if (!Number.isFinite(rawCount) || rawCount < SNAPSHOT_LIMIT_MIN_COUNT || rawCount > SNAPSHOT_LIMIT_MAX_COUNT) {
            return res.status(400).json({ error: `maxCount out of range (${SNAPSHOT_LIMIT_MIN_COUNT}-${SNAPSHOT_LIMIT_MAX_COUNT})` });
        }
        if (!Number.isFinite(rawBytes) || rawBytes < SNAPSHOT_LIMIT_MIN_BYTES || rawBytes > SNAPSHOT_LIMIT_MAX_BYTES) {
            return res.status(400).json({ error: `maxBytes out of range` });
        }
        const maxCount = Math.floor(rawCount);
        const maxBytes = Math.floor(rawBytes);
        kvSet(SNAPSHOT_LIMIT_COUNT_KEY, Buffer.from(String(maxCount), 'utf-8'));
        kvSet(SNAPSHOT_LIMIT_BYTES_KEY, Buffer.from(String(maxBytes), 'utf-8'));
        const trim = trimSnapshotsToLimits();
        const usage = snapshotUsage();
        res.json({
            maxCount, maxBytes,
            currentCount: usage.count,
            currentBytes: usage.bytes,
            logicalBytes: usage.logicalBytes,
            removed: trim.removed,
        });
    } catch (err) { next(err); }
});

app.get('/api/db/snapshots', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    try {
        const out = kvList(DB_BACKUP_PREFIX).map((key) => {
            const tsRaw = parseInt(key.slice(DB_BACKUP_PREFIX.length, -4), 10);
            const ts = Number.isFinite(tsRaw) ? tsRaw * 100 : null;
            // Logical size — the full data this snapshot represents (the whole DB),
            // not its marginal on-disk cost. Users expect "this backup = my 53 MB
            // DB"; the dedup win is shown once, as the section's savings figure.
            // (kvSize reassembles via the manifest; the marker's 13 bytes are not
            // what a user wants to see for a full backup.) Trimming still sizes by
            // snapshotFootprint in db.cjs, so this display change can't over-trim.
            return { key, size: kvSize(key) || 0, timestamp: ts };
        }).sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
        res.json({ snapshots: out });
    } catch (err) { next(err); }
});

app.delete('/api/db/snapshots', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    try {
        const key = typeof req.query?.key === 'string' ? req.query.key : '';
        // Restrict to snapshot prefix — never let this endpoint touch other kv keys.
        if (!key.startsWith(DB_BACKUP_PREFIX)) {
            return res.status(400).json({ error: 'Invalid snapshot key' });
        }
        kvDel(key);
        res.json({ ok: true });
    } catch (err) { next(err); }
});

// Restore a snapshot atomically server-side: copy snapshot blob → live blob,
// invalidate caches, rebuild chat store. Client-side setDatabase + reload is
// racy because the patch-sync save loop is debounced and the reload can fire
// before the snapshot data lands on disk.
app.post('/api/db/snapshots/restore', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    try {
        const key = typeof req.body?.key === 'string' ? req.body.key : '';
        if (!key.startsWith(DB_BACKUP_PREFIX)) {
            return res.status(400).json({ error: 'Invalid snapshot key' });
        }
        const blob = kvGet(key);
        if (!blob) {
            return res.status(404).json({ error: 'Snapshot not found' });
        }
        await queueStorageOperation(async () => {
            // Drain any pending debounced persist first — same pattern as
            // /api/db/optimize. Without this, an in-flight save could land
            // after kvCopyValue and overwrite the restored snapshot.
            await flushPendingDb();
            kvCopyValue(key, DB_BLOB_KEY);
            invalidateDbCache();
            // Snapshot may pre-date the remote-block migration. Clear the marker
            // so migrateRemoteBlocksIfNeeded re-evaluates against the restored
            // bytes instead of skipping based on the prior post-migration state.
            kvDel(REMOTE_MIGRATION_MARKER_KEY);
            // Pre-warm chat store from the just-restored blob so subsequent
            // /api/read fetches and patch-sync baselines see the new data.
            // Use decodeDatabaseWithPersistentChatIds so it runs the migration
            // (now unmarked) and refreshes stale raw if the snapshot was a
            // REMOTE-block format.
            try {
                const raw = kvGet(DB_BLOB_KEY);
                if (raw) {
                    const dbObj = await decodeDatabaseWithPersistentChatIds(raw, {
                        createBackup: false,
                    });
                    initChatStore(dbObj);
                    // Migration may have rewritten database.bin — etag must
                    // reflect the post-migration bytes the next /api/read sends.
                    const finalRaw = kvGet(DB_BLOB_KEY);
                    if (finalRaw) dbEtag = computeBufferEtag(Buffer.from(finalRaw));
                }
            } catch (e) {
                logger.warn('[Snapshot restore] post-restore decode failed:', e?.message || e);
            }
        });
        res.json({ ok: true });
    } catch (err) { next(err); }
});

// ── Boot-time backup reminder ───────────────────────────────────────────────

const BOOT_REMINDER_KEY = 'config/boot-backup-reminder';

function readBootReminder() {
    try {
        const raw = kvGet(BOOT_REMINDER_KEY);
        if (!raw) return false;
        return Buffer.from(raw).toString('utf-8').trim() === '1';
    } catch { return false; }
}

app.get('/api/backup/boot-reminder', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    try {
        res.json({ enabled: readBootReminder() });
    } catch (err) { next(err); }
});

app.put('/api/backup/boot-reminder', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    try {
        const enabled = !!req.body?.enabled;
        kvSet(BOOT_REMINDER_KEY, Buffer.from(enabled ? '1' : '0', 'utf-8'));
        res.json({ enabled });
    } catch (err) { next(err); }
});

// ── Backup directory configuration ──────────────────────────────────────────

app.get('/api/backup/server/path', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    try {
        res.json({
            path: backupsDir,
            default: DEFAULT_BACKUPS_DIR,
            isDefault: backupsDir === DEFAULT_BACKUPS_DIR,
        });
    } catch (err) { next(err); }
});

app.put('/api/backup/server/path', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    try {
        const next = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
        if (!next) {
            return res.status(400).json({ error: 'Path required' });
        }
        const resolved = path.resolve(next);
        if (isManagedBackupPath(resolved)) {
            return res.status(400).json({
                error: 'Backup path cannot be inside PocketRisu app files. Choose a separate folder such as data/backups.',
            });
        }
        // Ensure parent exists / target is writable. Create the dir if missing.
        try {
            if (!existsSync(resolved)) {
                mkdirSync(resolved, { recursive: true });
            }
            // Probe writability with a tmpfile.
            const probe = path.join(resolved, `.risu-write-probe-${Date.now()}`);
            require('fs').writeFileSync(probe, '');
            require('fs').unlinkSync(probe);
        } catch (e) {
            return res.status(400).json({ error: 'Path is not writable: ' + (e?.message || String(e)) });
        }
        const previous = backupsDir;
        backupsDir = resolved;
        kvSet(BACKUP_PATH_CONFIG_KEY, Buffer.from(resolved, 'utf-8'));
        writeBackupPathMarker(resolved);
        res.json({
            path: backupsDir,
            previous,
            default: DEFAULT_BACKUPS_DIR,
            isDefault: backupsDir === DEFAULT_BACKUPS_DIR,
        });
    } catch (err) { next(err); }
});

// ── Inlay bulk compression endpoint ──────────────────────────────────────────
const COMPRESS_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp']);

app.post('/api/inlays/compress', sessionAuthMiddleware, async (req, res) => {
    if (!checkActiveSession(req, res)) return;
    const quality = typeof req.body?.quality === 'number' ? req.body.quality : 85;

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
    });

    const send = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
        const files = await listInlayFiles();
        const imageFiles = [];

        for (const entry of files) {
            if (!COMPRESS_IMAGE_EXTS.has(entry.ext)) continue;
            const sidecar = await readInlaySidecar(entry.id);
            if (sidecar && sidecar.type !== 'image') continue;
            imageFiles.push(entry);
        }

        const total = imageFiles.length;
        let compressed = 0;
        let skipped = 0;
        let totalSaved = 0;

        const vips = await getVips()

        for (let i = 0; i < imageFiles.length; i++) {
            const entry = imageFiles[i];
            try {
                const original = await fs.readFile(entry.filePath);
                const img = vips.Image.newFromBuffer(original)
                let webpBuf
                try {
                    const out = img.writeToBuffer('.webp', { Q: quality })
                    webpBuf = Buffer.from(out);
                } finally {
                    img.delete()
                }

                if (webpBuf.length < original.length) {
                    const sidecar = await readInlaySidecar(entry.id);
                    const info = sidecar || {};
                    await writeInlayFile(entry.id, 'webp', webpBuf, { ...info, ext: 'webp' });
                    // invalidate thumbnail cache
                    kvDel(`inlay_thumb/${entry.id}`);
                    const saved = original.length - webpBuf.length;
                    totalSaved += saved;
                    compressed++;
                } else {
                    skipped++;
                }
            } catch {
                skipped++;
            }

            send({ type: 'progress', current: i + 1, total, compressed, skipped, totalSaved });
        }

        send({ type: 'done', total, compressed, skipped, totalSaved });
    } catch (err) {
        send({ type: 'error', message: err?.message || 'Unknown error' });
    }

    res.end();
});

// ── Public stats proxy ───────────────────────────────────────────────────────
app.get('/api/public-stats', async (req, res) => {
    try {
        const r = await fetch(PUBLIC_STATS_URL);
        if (!r.ok) { res.status(r.status).json({ error: 'upstream error' }); return; }
        const data = await r.json();
        res.json(data);
    } catch {
        res.status(502).json({ error: 'fetch failed' });
    }
});

// ── Update check endpoint ────────────────────────────────────────────────────
app.get('/api/update-check', async (req, res) => {
    const currentVersion = getCurrentVersion();
    if (UPDATE_CHECK_DISABLED) {
        res.json({ currentVersion, hasUpdate: false, severity: 'none', disabled: true, deploymentType, canSelfUpdate: false });
        return;
    }
    const result = await fetchLatestRelease(req.query.lang);
    const response = result || { currentVersion, hasUpdate: false, severity: 'none' };
    response.deploymentType = deploymentType;
    response.canSelfUpdate = deploymentType === 'portable'
        && !!response.hasUpdate
        && !response.manualOnly
        && !!getSelfUpdateAssetInfo(response.latestVersion);
    res.json(response);
});

// ── Self-update endpoint (portable only) ─────────────────────────────────────
let selfUpdateInProgress = false;

app.post('/api/self-update', async (req, res) => {
    if (!await checkAuth(req, res)) return;

    if (deploymentType !== 'portable') {
        res.status(400).json({ error: 'Self-update is only available for portable deployments' });
        return;
    }
    if (selfUpdateInProgress) {
        res.status(409).json({ error: 'Update already in progress' });
        return;
    }
    selfUpdateInProgress = true;

    // Track client disconnect — used to abort download, but NOT to release the lock.
    // The lock stays held until the update fully completes or fails, preventing
    // a second request from touching the same install directory concurrently.
    let clientDisconnected = false;
    res.on('close', () => {
        clientDisconnected = true;
        console.log('[Update] Client disconnected (update continues if past download stage).');
    });

    // NDJSON streaming response
    res.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
    });
    const send = (step, progress, message) => {
        try { res.write(JSON.stringify({ step, progress, message }) + '\n'); } catch {}
    };

    let tmpDir = null;
    try {
        // 1. Check update
        send('checking', 0, 'Checking for updates...');
        const updateInfo = await fetchLatestRelease();
        if (!updateInfo?.hasUpdate) {
            send('done', 100, 'Already up to date.');
            res.end();
            selfUpdateInProgress = false;
            return;
        }

        const targetVersion = updateInfo.latestVersion;
        const assetInfo = getSelfUpdateAssetInfo(targetVersion);
        if (!assetInfo) {
            throw new Error(`No release asset for ${process.platform}-${process.arch}`);
        }

        // 2. Download
        tmpDir = path.join(os.tmpdir(), `risu-update-${Date.now()}`);
        await fs.mkdir(tmpDir, { recursive: true });
        const archivePath = path.join(tmpDir, assetInfo.filename);

        send('downloading', 0, 'Starting download...');
        const dlRes = await fetch(assetInfo.url, { redirect: 'follow' });
        if (!dlRes.ok) throw new Error(`Download failed: ${dlRes.status} ${dlRes.statusText}`);

        const totalSize = parseInt(dlRes.headers.get('content-length'), 10) || 0;
        const fileStream = require('fs').createWriteStream(archivePath);
        let downloaded = 0;
        let lastPct = -1;

        const progress = new Transform({
            transform(chunk, _enc, cb) {
                if (clientDisconnected) { cb(new Error('Client disconnected')); return; }
                downloaded += chunk.length;
                if (totalSize > 0) {
                    const pct = Math.round((downloaded / totalSize) * 100);
                    if (pct >= lastPct + 5) {
                        lastPct = pct;
                        const dlMB = (downloaded / 1048576).toFixed(0);
                        const totalMB = (totalSize / 1048576).toFixed(0);
                        send('downloading', pct, `Downloading... ${pct}% (${dlMB}/${totalMB} MB)`);
                    }
                }
                cb(null, chunk);
            },
        });
        await pipeline(Readable.fromWeb(dlRes.body), progress, fileStream);
        send('downloading', 100, 'Download complete.');

        // 3. Extract
        send('extracting', null, 'Extracting...');
        const extractDir = path.join(tmpDir, 'extracted');
        await fs.mkdir(extractDir, { recursive: true });

        if (process.platform === 'win32') {
            try {
                // Windows 10 1803+ has tar.exe built-in, handles zip, much faster than PowerShell
                execSync(`tar -xf "${archivePath}" -C "${extractDir}"`, { timeout: 300000 });
            } catch {
                execSync(
                    `powershell -NoProfile -Command "Expand-Archive -Force -Path '${archivePath}' -DestinationPath '${extractDir}'"`,
                    { timeout: 300000 },
                );
            }
        } else {
            execSync(`tar -xzf "${archivePath}" -C "${extractDir}"`, { timeout: 300000 });
        }

        // Resolve possibly nested root directory (same as updater.cjs resolveExtractedRoot)
        const entries = await fs.readdir(extractDir);
        let sourceDir = extractDir;
        if (entries.length === 1) {
            const candidate = path.join(extractDir, entries[0]);
            if ((await fs.stat(candidate)).isDirectory()) sourceDir = candidate;
        }

        // 4. Validate extracted package (mirrors updater.cjs validateExtractedRoot)
        const REQUIRED_ENTRIES = ['dist', 'server', 'package.json'];
        const REQUIRED_DIST_FILES = ['index.html'];
        for (const entry of REQUIRED_ENTRIES) {
            try { await fs.access(path.join(sourceDir, entry)); }
            catch { throw new Error(`Downloaded package is missing required entry: ${entry}`); }
        }
        for (const file of REQUIRED_DIST_FILES) {
            try { await fs.access(path.join(sourceDir, 'dist', file)); }
            catch { throw new Error(`Downloaded package is missing dist/${file}`); }
        }
        if (process.platform === 'win32') {
            try { await fs.access(path.join(sourceDir, 'bin')); }
            catch { throw new Error('Downloaded Windows package is missing bin/'); }
        }

        // 5. Replace files (follows updater.cjs Phase 1-4 pattern)
        // Stop tunnel before replacing files to avoid file lock issues
        stopTunnel();
        send('replacing', null, 'Replacing files...');
        const appDir = process.cwd();
        const isWin = process.platform === 'win32';
        const updateTmp = path.join(appDir, '.update-tmp');

        // Restore from a previous interrupted update if leftover exists
        const prevBackup = path.join(updateTmp, 'backup');
        try {
            await fs.access(prevBackup);
            console.log('[Update] Restoring files from previous interrupted update...');
            await restoreBackup(prevBackup, appDir);
        } catch { /* no leftover */ }
        await fs.rm(updateTmp, { recursive: true, force: true }).catch(() => {});
        await fs.mkdir(updateTmp, { recursive: true });

        // Carry over SSL certificates into new package before swap
        const sslSrc = path.join(appDir, 'server', 'node', 'ssl', 'certificate');
        try {
            await fs.access(sslSrc);
            const sslDst = path.join(sourceDir, 'server', 'node', 'ssl', 'certificate');
            await fs.mkdir(path.dirname(sslDst), { recursive: true });
            await fs.cp(sslSrc, sslDst, { recursive: true });
        } catch { /* no user certs */ }

        // Keep set — matches updater.cjs + user data/config that must survive updates
        const keep = new Set(['save', 'backups', '.installed-version', '.update-tmp', 'scripts', '.env', '.npmrc', '.portable']);
        if (isWin) keep.add('bin');

        // Phase 1: move old files to backup — rollback immediately on any failure
        const backupDir = path.join(updateTmp, 'backup');
        await fs.mkdir(backupDir, { recursive: true });

        const oldEntries = await fs.readdir(appDir);
        for (const e of oldEntries) {
            if (keep.has(e)) continue;
            try {
                await fs.rename(path.join(appDir, e), path.join(backupDir, e));
            } catch (backupErr) {
                logger.error(`[Update] Failed to back up ${e}: ${backupErr.message}`);
                console.log('[Update] Restoring files already moved to backup...');
                await restoreBackup(backupDir, appDir);
                throw new Error(isWin
                    ? 'Update failed: some files are in use. Close RisuAI first, then try again.'
                    : 'Update failed: some files are in use. Stop the server first, then try again.');
            }
        }

        // Phase 2: move new files from extracted to app root
        const skipMove = new Set(['save', 'scripts']);
        if (isWin) skipMove.add('bin');
        const moved = [];
        try {
            const newEntries = await fs.readdir(sourceDir);
            for (const e of newEntries) {
                if (skipMove.has(e)) continue;
                const dest = path.join(appDir, e);
                await fs.rm(dest, { recursive: true, force: true }).catch(() => {});
                await moveAcrossVolumes(path.join(sourceDir, e), dest);
                moved.push(e);
            }
            // Post-move validation
            for (const entry of REQUIRED_ENTRIES) {
                if (!moved.includes(entry) && !existsSync(path.join(appDir, entry))) {
                    throw new Error(`Required entry was not installed: ${entry}`);
                }
            }
            for (const file of REQUIRED_DIST_FILES) {
                if (!existsSync(path.join(appDir, 'dist', file))) {
                    throw new Error(`Required file was not installed: dist/${file}`);
                }
            }
        } catch (moveErr) {
            logger.error(`[Update] Move failed: ${moveErr.message}`);
            console.log('[Update] Restoring from backup...');
            await restoreBackup(backupDir, appDir);
            throw new Error('Update failed, previous version restored. Please try again.');
        }

        // Phase 3: update scripts/ from new release
        const newScripts = path.join(sourceDir, 'scripts');
        try {
            await fs.access(newScripts);
            await fs.mkdir(path.join(appDir, 'scripts'), { recursive: true });
            for (const f of await fs.readdir(newScripts)) {
                await fs.copyFile(path.join(newScripts, f), path.join(appDir, 'scripts', f));
            }
        } catch { /* no scripts in release */ }

        // Phase 4 (Windows): stage bin/ for restart script to apply after exit
        if (isWin) {
            const newBin = path.join(sourceDir, 'bin');
            const stagedBin = path.join(updateTmp, 'new-bin');
            await fs.rm(stagedBin, { recursive: true, force: true }).catch(() => {});
            await fs.cp(newBin, stagedBin, { recursive: true });
            // Version marker — finalized after bin/ is applied
            await fs.writeFile(path.join(updateTmp, 'latest-version'), `v${targetVersion}`);
        } else {
            await fs.writeFile(path.join(appDir, '.installed-version'), `v${targetVersion}`);
        }

        // Cleanup temp download (not .update-tmp — that stays on Windows for bin/ post-step)
        fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        tmpDir = null;
        if (!isWin) {
            fs.rm(updateTmp, { recursive: true, force: true }).catch(() => {});
        }

        send('restarting', 100, 'Update complete. Restarting...');
        res.end();

        // 6. Flush DB and restart
        setTimeout(async () => {
            try {
            console.log(`[Update] Self-update to v${targetVersion} complete. Restarting...`);
            try { await flushPendingDb(); } catch {}
            try { checkpointWal('TRUNCATE'); } catch {}

            const port = process.env.PORT || 6001;

            if (isWin) {
                // Windows: use a .bat script to apply bin/, finalize version, and restart.
                // A bat script can replace bin/node.exe after the Node process exits,
                // avoiding file-lock issues that a Node child process would hit.
                const batScript = path.join(os.tmpdir(), `risu-restart-${Date.now()}.bat`);
                const utmp = path.join(appDir, '.update-tmp');
                const binDir = path.join(appDir, 'bin');
                const binBackup = path.join(utmp, 'old-bin');
                const batLines = [
                    '@echo off',
                    'timeout /t 3 /nobreak >nul',
                    // Apply staged bin/: backup current → copy new → on failure restore backup
                    `if exist "${path.join(utmp, 'new-bin')}\\" (`,
                    `  if exist "${binDir}\\" (`,
                    `    xcopy /E /I /Y "${binDir}\\*" "${binBackup}\\" >nul`,
                    `  )`,
                    `  xcopy /E /I /Y "${path.join(utmp, 'new-bin')}\\*" "${binDir}\\" >nul`,
                    `  if errorlevel 1 (`,
                    `    echo [Update] bin/ copy failed, restoring backup...`,
                    `    if exist "${binBackup}\\" (`,
                    `      xcopy /E /I /Y "${binBackup}\\*" "${binDir}\\" >nul`,
                    `    )`,
                    `    echo [Update] bin/ restored. Staged files kept for retry.`,
                    `    goto start`,
                    `  )`,
                    `)`,
                    // Finalize version marker only after successful bin/ copy
                    `if exist "${path.join(utmp, 'latest-version')}" (`,
                    `  copy /Y "${path.join(utmp, 'latest-version')}" "${path.join(appDir, '.installed-version')}" >nul`,
                    `)`,
                    // Cleanup .update-tmp (includes old-bin backup)
                    `rmdir /s /q "${utmp}" 2>nul`,
                    ':start',
                    // Start server with correct working directory
                    `cd /d "${appDir}"`,
                    `start "" "${path.join(appDir, 'bin', 'node.exe')}" "${path.join(appDir, 'server', 'node', 'server.cjs')}"`,
                    'exit /b 0',
                ];
                writeFileSync(batScript, batLines.join('\r\n'));
                spawn('cmd.exe', ['/c', batScript], { detached: true, stdio: 'ignore' }).unref();
            } else {
                // Unix: Node restart helper with port-check to avoid clashing with process managers
                const restartScript = path.join(os.tmpdir(), `risu-restart-${Date.now()}.cjs`);
                writeFileSync(restartScript, [
                    `const net = require('net');`,
                    `const { spawn } = require('child_process');`,
                    `setTimeout(() => {`,
                    `  const s = net.createServer();`,
                    `  s.once('error', () => process.exit(0));`,
                    `  s.once('listening', () => {`,
                    `    s.close();`,
                    `    spawn(${JSON.stringify(process.execPath)}, ['server/node/server.cjs'], {`,
                    `      cwd: ${JSON.stringify(appDir)},`,
                    `      detached: true,`,
                    `      stdio: 'inherit',`,
                    `      env: Object.assign({}, process.env),`,
                    `    }).unref();`,
                    `    setTimeout(() => process.exit(0), 500);`,
                    `  });`,
                    `  s.listen(${Number(port)});`,
                    `}, 3000);`,
                ].join('\n'));
                spawn(process.execPath, [restartScript], { detached: true, stdio: 'ignore' }).unref();
            }
            process.exit(0);
            } catch (restartErr) {
                logger.error('[Update] Restart failed:', restartErr);
                selfUpdateInProgress = false;
            }
        }, 500);

    } catch (e) {
        logger.error('[Update] Self-update failed:', e);
        send('error', null, `Update failed: ${e.message}`);
        res.end();
        selfUpdateInProgress = false;
        if (tmpDir) fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
});

// Helper: rename, falling back to copy+remove when src and dest are on
// different volumes (Windows EXDEV — e.g. app on D:, os.tmpdir() on C:)
async function moveAcrossVolumes(src, dest) {
    try {
        await fs.rename(src, dest);
    } catch (err) {
        if (err && err.code === 'EXDEV') {
            await fs.cp(src, dest, { recursive: true, force: true });
            await fs.rm(src, { recursive: true, force: true });
            return;
        }
        throw err;
    }
}

// Helper: restore files from backup directory into app root (mirrors updater.cjs restoreBackupIntoRoot)
async function restoreBackup(backupDir, rootDir) {
    try { await fs.access(backupDir); } catch { return; }
    for (const entry of await fs.readdir(backupDir)) {
        const src = path.join(backupDir, entry);
        const dest = path.join(rootDir, entry);
        try {
            await fs.rm(dest, { recursive: true, force: true }).catch(() => {});
            await moveAcrossVolumes(src, dest);
        } catch { /* best effort */ }
    }
}

// ── Cloudflare Quick Tunnel API ──────────────────────────────────────────────

app.get('/api/tunnel/status', async (req, res) => {
    if (!await checkAuth(req, res)) return;
    res.json({
        disabled: TUNNEL_DISABLED,
        status: tunnelStatus,
        url: tunnelUrl,
        error: tunnelError,
        platform: process.platform,
    });
});

app.post('/api/tunnel/start', async (req, res) => {
    if (!await checkAuth(req, res)) return;
    if (TUNNEL_DISABLED) return res.status(403).json({ error: 'Tunnel is disabled via RISU_TUNNEL_DISABLED' });
    if (tunnelStatus === 'running' || tunnelStatus === 'starting' || tunnelStatus === 'downloading') {
        return res.status(409).json({ error: 'Tunnel is already ' + tunnelStatus });
    }

    let cfPath = findCloudflaredBinary();

    // Auto-download if not found
    if (!cfPath) {
        tunnelStatus = 'downloading';
        tunnelError = null;
        res.json({ status: 'downloading' });

        try {
            cfPath = await downloadCloudflared();
        } catch (e) {
            logger.error('[Tunnel] Download failed:', e.message);
            tunnelStatus = 'error';
            tunnelError = `Failed to download cloudflared: ${e.message}`;
            return;
        }
        // After download, start the tunnel (response already sent)
        startTunnelProcess(cfPath);
        return;
    }

    tunnelStatus = 'starting';
    tunnelError = null;
    tunnelUrl = null;
    startTunnelProcess(cfPath);
    res.json({ status: 'starting' });
});

function startTunnelProcess(cfPath) {
    const port = process.env.PORT || 6001;
    tunnelStatus = 'starting';
    tunnelError = null;
    tunnelUrl = null;

    try {
        tunnelProcess = spawn(cfPath, ['tunnel', '--url', 'http://localhost:' + port], {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        tunnelProcess.stderr.on('data', (chunk) => {
            const text = chunk.toString();
            const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
            if (match && tunnelStatus === 'starting') {
                tunnelUrl = match[0];
                tunnelStatus = 'running';
                if (tunnelStartTimeout) { clearTimeout(tunnelStartTimeout); tunnelStartTimeout = null; }
                console.log(`[Tunnel] Quick tunnel URL: ${tunnelUrl}`);
            }
        });

        tunnelProcess.on('error', (err) => {
            logger.error('[Tunnel] Process error:', err.message);
            tunnelStatus = 'error';
            tunnelError = err.message;
            tunnelProcess = null;
            if (tunnelStartTimeout) { clearTimeout(tunnelStartTimeout); tunnelStartTimeout = null; }
        });

        tunnelProcess.on('exit', (code) => {
            if (tunnelStatus === 'running' || tunnelStatus === 'starting') {
                console.log(`[Tunnel] Process exited with code ${code}`);
                tunnelStatus = 'error';
                tunnelError = `cloudflared exited unexpectedly (code ${code})`;
            }
            tunnelProcess = null;
            tunnelUrl = null;
            if (tunnelStartTimeout) { clearTimeout(tunnelStartTimeout); tunnelStartTimeout = null; }
        });

        tunnelStartTimeout = setTimeout(() => {
            if (tunnelStatus === 'starting') {
                tunnelStatus = 'error';
                tunnelError = 'Tunnel failed to start within 30 seconds';
                if (tunnelProcess) { try { tunnelProcess.kill('SIGTERM'); } catch {} tunnelProcess = null; }
            }
            tunnelStartTimeout = null;
        }, 30000);
    } catch (e) {
        tunnelStatus = 'error';
        tunnelError = e.message;
        tunnelProcess = null;
    }
}

app.post('/api/tunnel/stop', async (req, res) => {
    if (!await checkAuth(req, res)) return;
    stopTunnel();
    res.json({ status: 'off' });
});

// ─── Express error middleware — must be registered after all routes ─────────
app.use(expressErrorMiddleware);
app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    res.status(500).json({ error: err?.message || 'internal server error' });
});

// ─────────────────────────────────────────────────────────────────────────────

async function getHttpsOptions() {

    const keyPath = path.join(sslPath, 'server.key');
    const certPath = path.join(sslPath, 'server.crt');

    try {
 
        await fs.access(keyPath);
        await fs.access(certPath);

        const [key, cert] = await Promise.all([
            fs.readFile(keyPath),
            fs.readFile(certPath)
        ]);
       
        return { key, cert };

    } catch (error) {
        if (error.code === 'ENOENT') {
            logger.info('[Server] No SSL certificate found, starting with HTTP');
        } else {
            logger.error('[Server] SSL setup errors:', error.message);
            console.log('[Server] Start the server with HTTP instead of HTTPS...');
        }
        return null;
    }
}

async function startServer() {
    try {
        await migrateInlaysToFilesystem();
        await migrateRemoteBlocksIfNeeded();
        const port = process.env.PORT || 6001;
        const httpsOptions = await getHttpsOptions();
        let server;

        if (httpsOptions) {
            // HTTPS
            server = https.createServer(httpsOptions, app);
            setupProxyStreamWebSocket(server);
            server.listen(port, () => {
                console.log("[Server] HTTPS server is running.");
                console.log(`[Server] https://localhost:${port}/`);
            });
        } else {
            // HTTP
            server = http.createServer(app);
            setupProxyStreamWebSocket(server);
            server.listen(port, () => {
                console.log("[Server] HTTP server is running.");
                console.log(`[Server] http://localhost:${port}/`);
            });
        }
    } catch (error) {
        logger.error('[Server] Failed to start server :', error);
        process.exit(1);
    }
}

// Graceful shutdown: flush pending patches and checkpoint WAL before exit
for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, async () => {
        console.log(`[Server] Received ${sig}, flushing pending data...`);
        stopTunnel();
        try { await flushPendingDb(); } catch (e) { logger.error('[Server] Flush error:', e); }
        try { checkpointWal('TRUNCATE'); } catch { /* non-fatal */ }
        process.exit(0);
    });
}

(async () => {
    // Proxy stream job garbage collection
    setInterval(() => {
        const now = Date.now();
        for (const [jobId, job] of proxyStreamJobs.entries()) {
            if (!job.done && now >= job.deadlineAt && !job.abortController.signal.aborted) {
                job.abortController.abort();
            }
            if (job.done && job.clients.size === 0 && job.cleanupAt > 0 && now >= job.cleanupAt) {
                cleanupJob(jobId);
                continue;
            }
            if (!job.done && now - job.updatedAt > Math.max(PROXY_STREAM_DEFAULT_TIMEOUT_MS, job.timeoutMs * 2)) {
                cleanupJob(jobId);
            }
        }
    }, PROXY_STREAM_GC_INTERVAL_MS);

    await startServer();

    // Periodically checkpoint WAL to reclaim disk space.
    // TRUNCATE (vs RESTART) shrinks the -wal file on disk, not just the writer
    // pointer — required for journal_size_limit to actually take effect.
    setInterval(() => {
        try { checkpointWal('TRUNCATE'); }
        catch { /* non-fatal */ }
    }, 5 * 60 * 1000); // every 5 minutes

})();

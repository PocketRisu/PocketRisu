const express = require('express');
const app = express();
const http = require('http');
const https = require('https');
const path = require('path');
const net = require('net');
const compression = require('compression');
const { messageFingerprints, prefixFingerprint } = require('./chatFingerprint.cjs');
const htmlparser = require('node-html-parser');
const { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, statSync } = require('fs');
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
const { createRequestLogs } = require('./request-logs.cjs');
const { applyPatch } = require('fast-json-patch');
const { decodeRisuSave, encodeRisuSaveLegacy, calculateHash, normalizeJSON, normalizeForwardHeaders, hasRemoteBlocks } = require('./utils.cjs');
const { createPatchHashCache, decodePointerSegment } = require('./patch-hash-cache.cjs');
const { clonePatchSnapshot } = require('./patch-selective-clone.cjs');
const pluginStorage = require('./plugin-storage-store.cjs');
const upstreamPluginStorage = require('./upstream-plugin-storage.cjs');
const { createAssetManifestStore } = require('./assetManifestStore.cjs');
const {
    stripAssetManifests,
    hydrateAssetManifests,
    findAssetManifestLossOwners,
    assetManifestSummary,
    moduleOwnerId,
    characterOwnerId,
    personaOwnerId,
} = require('./assetManifestMigration.cjs');
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
// Invariant: server code never mutates a cached database's nested branches
// in place. /api/patch derives the next root via clonePatchSnapshot (untouched
// top-level branches are shared with the previous root) and keeps per-branch
// hashes in databasePatchHashCache keyed on the root object — an in-place edit
// would silently alias into the previous snapshot and leave a stale hash.
// Replace the branch (or the whole root) instead.
let dbCache = {};
let saveTimers = {};
const SAVE_INTERVAL = 5000;
let fullChatStore = null; // Map<chaId, Map<chatId, chatObject>> — lazy-initialized
// chaId → archivedAt of characters activated in this process whose return to
// `characters` the client has not saved yet. Their chats live only in
// fullChatStore until then, so initChatStore carries them over (see there).
const pendingActivations = new Map();
const databasePatchHashCache = createPatchHashCache(calculateHash);

// ETag for database.bin
let dbEtag = null;

function computeBufferEtag(buffer) {
    return nodeCrypto.createHash('md5').update(buffer).digest('hex');
}

function computeDatabaseEtagFromObject(databaseObject) {
    return computeBufferEtag(Buffer.from(encodeRisuSaveLegacy(databaseObject)));
}

// Per-root-key and per-character hashes of a client-view database, in the
// hex form RisuSavePatcher.describeHashMismatch compares against its own
// baseline. Characters are keyed by chaId (or `#index` when missing); the
// first occurrence of a repeated id wins and the repeats are listed so the
// client sees a stable pair instead of a last-writer-wins collision.
function databaseHashDiagnostics(databaseObject) {
    const keyHashes = {};
    for (const [key, value] of Object.entries(databasePatchHashCache.keyHashes(databaseObject))) {
        keyHashes[key] = value.toString(16);
    }
    const characterHashes = {};
    const duplicateCharIds = [];
    const characters = Array.isArray(databaseObject?.characters) ? databaseObject.characters : [];
    characters.forEach((character, index) => {
        const id = typeof character?.chaId === 'string' && character.chaId ? character.chaId : `#${index}`;
        if (Object.prototype.hasOwnProperty.call(characterHashes, id)) {
            duplicateCharIds.push(id);
            return;
        }
        characterHashes[id] = calculateHash(character).toString(16);
    });
    return { keyHashes, characterHashes, duplicateCharIds };
}

let storageOperationQueue = Promise.resolve();
function queueStorageOperation(operation) {
    const operationRun = storageOperationQueue.then(operation, operation);
    storageOperationQueue = operationRun.catch(() => {});
    return operationRun;
}

const DB_HEX_KEY = Buffer.from('database/database.bin', 'utf-8').toString('hex');
const assetManifestStore = createAssetManifestStore(sqliteDb, {
    maxCacheBytes: process.env.POCKETRISU_ASSET_MANIFEST_CACHE_BYTES
        ? Number(process.env.POCKETRISU_ASSET_MANIFEST_CACHE_BYTES)
        : undefined,
});

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
// Snapshot a restore is reading from. The restore flushes a pending save
// first, and that flush can take a new snapshot and trim the oldest one —
// which may be the very snapshot being restored.
let restoringSnapshotKey = null;

function trimSnapshotsToLimits() {
    const { maxCount, maxBytes } = getSnapshotLimits();
    const pluginSize = snapshotPluginSizer();
    // Size each snapshot by its marginal disk cost (chunks not shared with the
    // live blob), not its logical size — chunked snapshots share chunks, so a
    // logical measure would over-trim ones that cost almost nothing on disk.
    const entries = listSnapshotKeys()
        .map((key) => {
            const tsRaw = parseInt(key.slice(DB_BACKUP_PREFIX.length, -4), 10);
            // Plugin bytes are marginal too: blobs only this snapshot references
            // (see plugin-storage-store.cjs snapshotBytes).
            return { key, size: snapshotFootprint(key) + pluginSize(key).bytes, ts: Number.isFinite(tsRaw) ? tsRaw : 0 };
        })
        .sort((a, b) => b.ts - a.ts);

    let runningBytes = 0;
    const toDelete = [];
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const isFirst = i === 0;
        const fitsByCount = i < maxCount;
        const fitsByBytes = runningBytes + e.size <= maxBytes;
        if (e.key === restoringSnapshotKey) continue;
        if (isFirst || (fitsByCount && fitsByBytes)) {
            runningBytes += e.size;
        } else {
            toDelete.push(e.key);
        }
    }
    for (const key of toDelete) deleteSnapshot(key);
    return { kept: entries.length - toDelete.length, removed: toDelete.length };
}

// ── Snapshot ↔ plugin storage ───────────────────────────────────────────────
// The blob under database/dbbackup-* holds an empty pluginCustomStorage once
// the split has run, so every snapshot also carries a content-addressed map
// of the plugin-storage/ rows (see plugin-storage-store.cjs snapshotTo).
// These helpers keep the two halves created, sized, deleted and restored
// together. snapshotPluginSizer gives the marginal cost (blobs only that
// snapshot references + its map row); dropping a snapshot GCs its unique
// blobs in the same transaction.
// Only the exact `database/dbbackup-<digits>.bin` shape names a snapshot. A
// looser check (prefix + strip 4 chars) let `dbbackup-1234xxxx` map to plugin
// id `1234` and GC another snapshot's blobs while its DB blob stayed behind.
function isSnapshotKey(key) {
    return typeof key === 'string' && DB_BACKUP_KEY_RE.test(key);
}

function snapshotPluginId(key) {
    const m = typeof key === 'string' ? DB_BACKUP_KEY_RE.exec(key) : null;
    if (!m) throw new Error(`Not a snapshot key: ${key}`);
    return m[1];
}

// Sizes the plugin halves of all snapshots in one pass and returns
// key → { bytes, logicalBytes }; bytes is the marginal cost.
function snapshotPluginSizer() {
    const sizeOf = pluginStorage.snapshotSizer();
    return (key) => sizeOf(snapshotPluginId(key));
}

function deleteSnapshot(key) {
    const id = snapshotPluginId(key);
    kvDel(key);
    pluginStorage.dropSnapshot(id);
}

// Current snapshot count + two totals:
//   bytes        — marginal disk cost (snapshotFootprint), the SAME measure the
//                  byte limit/trim uses, so the limit gauge matches what trimming
//                  sees. kvListWithSizes would report a chunked snapshot's marker.
//   logicalBytes — sum of each snapshot's full logical size (kvSize), i.e. what
//                  the snapshots would cost WITHOUT dedup. Drives the "saved by
//                  deduplication" figure; never used for trimming.
function listSnapshotKeys() {
    return kvList(DB_BACKUP_PREFIX).filter(isSnapshotKey);
}

function snapshotUsage() {
    const keys = listSnapshotKeys();
    const pluginSize = snapshotPluginSizer();
    let bytes = 0, logicalBytes = 0;
    for (const k of keys) {
        const plugin = pluginSize(k);
        bytes += snapshotFootprint(k) + plugin.bytes;
        logicalBytes += (kvSize(k) || 0) + plugin.logicalBytes;
    }
    return { count: keys.length, bytes, logicalBytes };
}

// `force` skips the cooldown — used before one-way migrations, where a
// snapshot of the pre-migration blob is the only rollback path.
function createBackupAndRotate({ force = false } = {}) {
    const now = Date.now();
    if (!force && lastBackupTime && now - lastBackupTime < BACKUP_INTERVAL_MS) {
        return;
    }
    // Nothing to snapshot before the first database exists (fresh install
    // importing a backup). kvCopyValue would silently skip the blob while
    // snapshotTo still wrote a plugin-storage map row, leaving an orphan map
    // with no snapshot behind it. The cooldown still advances, as it always
    // has for this attempt.
    if (kvSize('database/database.bin') === null) {
        lastBackupTime = now;
        return;
    }

    const backupKey = `${DB_BACKUP_PREFIX}${(now / 100).toFixed()}.bin`;
    // Blob + plugin rows land atomically so a snapshot never exists half-made.
    sqliteDb.transaction(() => {
        kvCopyValue('database/database.bin', backupKey);
        pluginStorage.snapshotTo(snapshotPluginId(backupKey));
    })();
    // Advance the cooldown only once the snapshot is committed: a throw above
    // must not suppress the next attempt for the whole interval.
    lastBackupTime = now;
    trimSnapshotsToLimits();
}

// The flush that took the persist timer, while it is still writing.
let dbFlushInFlight = null;

async function flushPendingDb() {
    // /api/read and export flush outside the storage queue. A flush that
    // finds the timer already taken must wait for that write: a cold load
    // right after would otherwise read the disk from before it.
    while (dbFlushInFlight) await dbFlushInFlight.catch(() => {});
    if (!saveTimers[DB_HEX_KEY]) return;
    const flush = writePendingDb();
    dbFlushInFlight = flush;
    try {
        await flush;
    } finally {
        if (dbFlushInFlight === flush) dbFlushInFlight = null;
    }
}

async function writePendingDb() {
    clearTimeout(saveTimers[DB_HEX_KEY]);
    delete saveTimers[DB_HEX_KEY];
    const cold = !dbCache[DB_HEX_KEY];
    try {
        if (dbCache[DB_HEX_KEY]) {
            await persistDbCacheWithChats(DB_HEX_KEY, 'database/database.bin');
        } else if (fullChatStore && fullChatStore.size > 0) {
            // No stripped cache but chat store has data — merge and persist directly
            const raw = kvGet('database/database.bin');
            if (raw) {
                const dbObj = normalizeJSON(await decodeRisuSave(raw));
                const fullDb = hydrateDatabaseForDisk(stripDatabaseForClient(dbObj, { reconcileManifests: true }));
                kvSet('database/database.bin', Buffer.from(encodeRisuSaveLegacy(fullDb)));
                clearPersistFailure();
            }
        }
    } catch (error) {
        // The timer was the only record that memory is ahead of disk.
        if (cold) retryColdPersistLater('flush');
        else retryDatabasePersistLater('flush');
        throw error;
    }
    createBackupAndRotate();
}

// A failed persist used to drop its timer, so nothing wrote the pending
// changes again until the next edit (and a restart lost them). Try again
// later while the cache still holds them. A guard that refused to persist
// drops dbCache on purpose; then there is nothing to retry, and a no-op
// "success" must not clear the failure it recorded.
const PERSIST_RETRY_MS = process.env.POCKETRISU_PERSIST_RETRY_MS
    ? Number(process.env.POCKETRISU_PERSIST_RETRY_MS)
    : 30_000; // override for tests
function retryDatabasePersistLater(source) {
    if (!dbCache[DB_HEX_KEY] || saveTimers[DB_HEX_KEY]) return;
    scheduleDatabasePersist(`${source}:retry`, PERSIST_RETRY_MS);
}

// The same for a write of the chat store with no dbCache (right after a
// restart or an import): the store is still ahead of disk. The timer is the
// record of that — the next flush writes again, a cold load's included,
// which then fails rather than rebuild the store without those bodies — and
// it also retries on its own.
function retryColdPersistLater(source) {
    if (saveTimers[DB_HEX_KEY]) return;
    const timer = setTimeout(() => {
        queueStorageOperation(async () => {
            if (saveTimers[DB_HEX_KEY] !== timer) return;
            await flushPendingDb();
        }).catch((error) => logger.error(`[${source}] Retry failed:`, error));
    }, PERSIST_RETRY_MS);
    saveTimers[DB_HEX_KEY] = timer;
}

// ── /api/patch × plugin storage ─────────────────────────────────────────────
// During the mixed old/new client window, an older client still patches
// `/pluginCustomStorage/<key>` in database.bin. Applying those to dbCache
// would land them in the blob, where the next cold decode discards them
// (kv-wins re-migration). So direct-child add/replace/remove ops are routed
// to the kv store and stripped from the DB patch; anything else touching the
// subtree (deeper paths, the field itself, move/copy/test) is rejected so
// the client falls back to a full write, which splits DB-wins.
const PLUGIN_STORAGE_POINTER = '/pluginCustomStorage';
const PLUGIN_STORAGE_KV_OPS = new Set(['add', 'replace', 'remove']);

function partitionPluginStorageOps(patch) {
    const kvOps = [];
    const rejected = [];
    const rest = [];
    for (const op of Array.isArray(patch) ? patch : []) {
        const path = typeof op?.path === 'string' ? op.path : '';
        const from = typeof op?.from === 'string' ? op.from : '';
        const inSubtree = (p) => p === PLUGIN_STORAGE_POINTER || p.startsWith(`${PLUGIN_STORAGE_POINTER}/`);
        if (!inSubtree(path) && !inSubtree(from)) {
            rest.push(op);
            continue;
        }
        const tail = path.slice(PLUGIN_STORAGE_POINTER.length + 1);
        const directChild = path.startsWith(`${PLUGIN_STORAGE_POINTER}/`) && !tail.includes('/');
        if (directChild && PLUGIN_STORAGE_KV_OPS.has(op.op) && !from) {
            kvOps.push({ op: op.op, key: decodePointerSegment(tail), value: op.value });
        } else {
            rejected.push(op);
        }
    }
    return { kvOps, rejected, rest };
}

// Cold-load database.bin into dbCache (stripped) + fullChatStore. Every
// caller must run this inside queueStorageOperation: /api/read used to decode
// outside the queue, so a concurrent /api/patch could cold-load, apply and
// cache first, then be overwritten by the read's older snapshot — losing an
// acknowledged patch on the next persist. Re-checks the cache inside the
// queue so a load that already happened while waiting is not repeated.
// Returns false when there is no blob on disk.
async function loadDbCacheIfMissing({ createBackup = false } = {}) {
    if (dbCache[DB_HEX_KEY]) return true;
    // A chat body saved while the cache was cold (right after a restart or an
    // import) is only in fullChatStore until the debounced persist, and the
    // load below rebuilds the store from disk. Write it out first.
    await flushPendingDb();
    const raw = kvGet('database/database.bin');
    if (!raw) return false;
    // The flush writes only chats the database lists; a body posted before
    // its entry is carried across the rebuild (carryUnlistedChatPosts).
    const dbObj = await initChatStoreFromDisk(await decodeDatabaseWithPersistentChatIds(raw, { createBackup }));
    dbCache[DB_HEX_KEY] = normalizeJSON(stripDatabaseForClient(dbObj, { reconcileManifests: true }));
    return true;
}

function invalidateDbCache() {
    delete dbCache[DB_HEX_KEY];
    fullChatStore = null;
    pendingActivations.clear();
    unlistedChatPosts.clear();
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

// Character and chat ids made unique the way the browser's assignIds
// (src/ts/bootstrap.ts) does it — one set over every chaId and chat id, in
// order, the first occurrence keeps its id — but here, on the full decoded
// database, where each chat still carries its body. The browser renaming a
// duplicate on its own left the server's body under the old id: the chat
// opened empty and the next save dropped the body from disk (and two chats
// sharing an id inside one character shared one body on the server). Once
// this has run and persisted, the browser finds nothing to rename.
function dedupeCharacterAndChatIds(dbObj) {
    const renamed = [];
    if (!Array.isArray(dbObj?.characters)) return renamed;
    const seen = new Set();
    for (const char of dbObj.characters) {
        if (!char || typeof char !== 'object') continue;
        if (!char.chaId || seen.has(char.chaId)) {
            const next = nodeCrypto.randomUUID();
            if (char.chaId) renamed.push(`character ${char.chaId} → ${next}`);
            char.chaId = next;
        }
        seen.add(char.chaId);
        if (!Array.isArray(char.chats)) continue;
        for (const chat of char.chats) {
            if (!chat || typeof chat !== 'object') continue;
            if (!chat.id || seen.has(chat.id)) {
                const next = nodeCrypto.randomUUID();
                if (chat.id) renamed.push(`chat ${char.chaId}/${chat.id} → ${next}`);
                chat.id = next;
            }
            seen.add(chat.id);
        }
    }
    return renamed;
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

    // After the cold-storage restore: it replaces restored characters' chats
    // wholesale and may bring duplicate or missing ids back.
    const renamedIds = dedupeCharacterAndChatIds(dbObj);
    if (renamedIds.length > 0) {
        needsPersist = true;
        logger.warn(`[Load] Renamed ${renamedIds.length} duplicate character/chat id(s), keeping each chat's content: ${renamedIds.slice(0, 5).join(', ')}`);
    }
    if (coldRestoreResult.failed > 0) {
        logger.error(`[ColdStorage] ${coldRestoreResult.failed} character(s) could not be restored and were converted to safe blank characters. Cold storage KV data is preserved.`);
        for (const name of coldRestoreResult.failedNames) {
            logger.error(`[ColdStorage]   - "${name}"`);
        }
    }

    // Same one-time path for upstream's cold-storage-backed plugin storage.
    // Must run before the kv split below so the restored values move with it.
    const coldPluginResult = restoreColdPluginStorageInDb(dbObj);
    if (coldPluginResult) {
        needsPersist = true;
        logPluginStorageRestore('Restored', coldPluginResult);
    }

    // One-time move of pluginCustomStorage into kv (plugin-storage/*). Runs on
    // every cold decode (boot, /api/read, /api/patch, import, snapshot restore)
    // so a blob written by an older build or upstream is split on first load.
    // Throws leave dbObj and the blob untouched; the next load retries.
    // Not on the migrationResult failure path: a failed migration keeps the
    // data in the blob, which is still a fully working state.
    // kvWinsOnRemigration: if the marker already exists, the blob still
    // holding data means the emptied blob never persisted; kv has since been
    // the live copy, so it must not be clobbered (see store comment).
    let pluginSplit = false;
    try {
        const pluginMigration = pluginStorage.migrateFromDb(dbObj, {
            createSnapshot: () => createBackupAndRotate({ force: true }),
            kvWinsOnRemigration: true,
        });
        if (pluginMigration.migrated) {
            dbObj.pluginCustomStorage = {};
            needsPersist = true;
            pluginSplit = true;
            logger.info(`[PluginStorage] Migrated ${pluginMigration.keys} key(s), ${(pluginMigration.bytes / 1024 / 1024).toFixed(1)}MB from database.bin to kv`);
        }
    } catch (e) {
        logger.error('[PluginStorage] Migration failed; plugin data stays in database.bin', e);
    }

    let leakedPluginResult = null;
    try {
        leakedPluginResult = recoverLeakedPluginStorageKeys(dbObj);
    } catch (e) {
        logger.error('[PluginStorage] Recovering upstream plugin storage keys from kv failed; they stay as they are', e);
    }
    if (leakedPluginResult) {
        needsPersist = true;
        logPluginStorageRestore('Recovered', leakedPluginResult);
    }

    if (needsPersist) {
        try {
            kvSet('database/database.bin', Buffer.from(encodeRisuSaveLegacy(dbObj)));
        } catch (e) {
            // The split already committed to kv, so the decoded (emptied) DB is
            // the correct live state even if the blob could not be rewritten
            // (e.g. size limit). Serve it rather than failing the request;
            // the next cold decode re-splits the stale blob kv-wins.
            if (!pluginSplit) throw e;
            logger.error('[PluginStorage] Blob persist after split failed; serving from kv', e);
            recordPersistFailure(e, 'decode:plugin-split');
            return dbObj;
        }
        if (createBackup) {
            createBackupAndRotate();
        }
    }
    if (migrationResult) {
        migrationResult.coldStorageFailed = coldRestoreResult.failed;
        migrationResult.pluginStorageColdFailed = (coldPluginResult?.failed || 0) + (leakedPluginResult?.failed || 0);
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
    const previous = fullChatStore;
    fullChatStore = new Map();
    carryPendingActivations(previous, dbObj);
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
    carryUnlistedChatPosts(previous, dbObj);
}

// Chat bodies posted while the database did not list the chat: a chat (or a
// character) created on the client reaches the server before the patch that
// adds its entry. Every store rebuild — a persist, a full write, a cold load —
// keeps only listed chats, and disk has no copy of these, so carry them across
// until the database lists them. A post the entry never follows (the chat was
// deleted first) is forgotten after UNLISTED_CHAT_POST_TTL_MS.
const unlistedChatPosts = new Map(); // `${chaId}\0${chatId}` → { chaId, chatId, at }
const UNLISTED_CHAT_POST_TTL_MS = 10 * 60 * 1000;

function isChatListed(dbObj, chaId, chatId) {
    const char = Array.isArray(dbObj?.characters) ? dbObj.characters.find((c) => c?.chaId === chaId) : null;
    return Array.isArray(char?.chats) && char.chats.some((chat) => chat?.id === chatId);
}

function recordChatPost(chaId, chatId) {
    if (isChatListed(dbCache[DB_HEX_KEY], chaId, chatId)) return;
    unlistedChatPosts.set(`${chaId}\0${chatId}`, { chaId, chatId, at: Date.now() });
}

// Once the database lists a posted chat, its body is persisted like any other
// one. A delete that follows before the next rebuild must not find the post
// still on record and carry the deleted body across it.
function forgetListedChatPosts(dbObj) {
    if (unlistedChatPosts.size === 0) return;
    for (const [key, post] of unlistedChatPosts) {
        if (isChatListed(dbObj, post.chaId, post.chatId)) unlistedChatPosts.delete(key);
    }
}

function carryUnlistedChatPosts(previous, dbObj) {
    if (unlistedChatPosts.size === 0) return;
    const now = Date.now();
    // A deactivated character's chats are carryPendingActivations' business.
    const archived = new Set(archivedStubsOf(dbObj).map((s) => s.chaId));
    for (const [key, post] of unlistedChatPosts) {
        if (now - post.at > UNLISTED_CHAT_POST_TTL_MS || isChatListed(dbObj, post.chaId, post.chatId)) {
            unlistedChatPosts.delete(key);
            continue;
        }
        const body = previous?.get(post.chaId)?.get(post.chatId);
        if (!body || archived.has(post.chaId)) continue;
        if (!fullChatStore.has(post.chaId)) fullChatStore.set(post.chaId, new Map());
        fullChatStore.get(post.chaId).set(post.chatId, body);
    }
}

// An activated character's chats are registered here before the client's save
// puts the character back into `characters`. A store rebuild in between (any
// persist) would drop them: the save that returns the character is then
// refused as "returned from the archive without activation", and chat bodies
// posted meanwhile are lost. Keep them while the character is still off the
// list and its archive stub is the version that was activated; forget the
// activation once it is listed or the stub is gone or replaced.
function carryPendingActivations(previous, dbObj) {
    if (pendingActivations.size === 0) return;
    const listed = new Set((Array.isArray(dbObj?.characters) ? dbObj.characters : []).map((c) => c?.chaId).filter(Boolean));
    const stubAt = new Map(archivedStubsOf(dbObj).map((s) => [s.chaId, s.archivedAt]));
    for (const [chaId, archivedAt] of pendingActivations) {
        if (listed.has(chaId) || stubAt.get(chaId) !== archivedAt) {
            pendingActivations.delete(chaId);
            continue;
        }
        const chats = previous?.get(chaId);
        if (chats) fullChatStore.set(chaId, chats);
    }
}

/**
 * initChatStore for a database just decoded from disk. A reactivated
 * character can sit on disk with bodiless `_stub` chats whose bodies only its
 * archive rows hold; restore them before anything reads the store, or a chat
 * opened before the next save loads empty and the edit that follows replaces
 * the history for good. A failure here only logs: the app must still load,
 * and the persist path refuses on its own when a row is unreadable.
 * Returns the database the store was built from.
 */
async function initChatStoreFromDisk(dbObj) {
    let db = dbObj;
    if (findUnmergedArchivedChats(dbObj).length > 0) {
        try {
            db = await restoreArchivedChatsForDisk(dbObj, 'load');
        } catch (error) {
            logger.warn(`[Archive] load: could not restore chats from archive rows: ${error?.message || error}`);
        }
    }
    initChatStore(db);
    return db;
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
 * Browser runtime view: chat bodies and large asset-reference arrays are kept
 * server-side. The on-disk database remains legacy-compatible until the
 * explicit slim-database cutover is implemented and verified.
 */
function stripDatabaseForClient(dbObj, { reconcileManifests = false } = {}) {
    const chatStripped = stripChatsFromDb(dbObj);
    return stripAssetManifests(chatStripped, assetManifestStore, {
        activate: reconcileManifests ? 'reconcile' : true,
    }).db;
}

/** Rebuild the exact legacy shape before any database.bin disk write. */
function hydrateDatabaseForDisk(clientDb) {
    const chatsHydrated = reassembleFullDb(clientDb);
    return hydrateAssetManifests(chatsHydrated, assetManifestStore);
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
    await initChatStoreFromDisk(dbObj);
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
// Duration of the last successful debounced database write, reported with
// /api/patch responses for the client's save dashboard.
let lastDbPersistMs = null;

async function persistDbCacheWithChats(filePath, decodedKey) {
    const strippedDb = dbCache[filePath];
    if (!strippedDb) return;
    const persistStartedAt = performance.now();
    await ensureChatStore();
    let fullDb = hydrateDatabaseForDisk(strippedDb);

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
        // A character that came back from the archive without its chats
        // registered in this process (e.g. server restarted in between) still
        // has bodiless `_stub` chats after reassembly. Its payload is intact
        // in kv: fill them from there instead of writing stubs over them.
        // Refusing the whole persist instead left every save failing with no
        // way out for the user. Only an unreadable row still aborts.
        if (findUnmergedArchivedChats(fullDb).length > 0) {
            try {
                fullDb = await restoreArchivedChatsForDisk(fullDb, 'persist');
            } catch (error) {
                const err = new Error(`persist aborted: a deactivated character's archive row is unreadable — ${error?.message || error}`);
                recordPersistFailure(err, 'persistDbCacheWithChats:archive-unreadable');
                delete dbCache[filePath];
                throw err;
            }
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
        lastDbPersistMs = Math.round(performance.now() - persistStartedAt);
    }
}

function scheduleDatabasePersist(source = 'database', delay = SAVE_INTERVAL) {
    if (saveTimers[DB_HEX_KEY]) clearTimeout(saveTimers[DB_HEX_KEY]);
    const timer = setTimeout(() => {
        queueStorageOperation(async () => {
            if (saveTimers[DB_HEX_KEY] !== timer) return;
            let failed = false;
            try {
                await persistDbCacheWithChats(DB_HEX_KEY, 'database/database.bin');
                clearPersistFailure();
                try { createBackupAndRotate(); }
                catch (backupError) { logger.warn(`[${source}] Backup rotation failed:`, backupError); }
            } catch (error) {
                logger.error(`[${source}] Error saving database.bin:`, error);
                recordPersistFailure(error, source);
                failed = true;
            } finally {
                if (saveTimers[DB_HEX_KEY] === timer) delete saveTimers[DB_HEX_KEY];
            }
            if (failed) retryDatabasePersistLater(source);
        }).catch((error) => logger.error(`[${source}] Storage queue failed:`, error));
    }, delay);
    saveTimers[DB_HEX_KEY] = timer;
}

// Manifest edits need the canonical client-view cache. Reuses the shared cold
// loader so the decode/strip path stays identical to /api/read and /api/patch;
// callers must already hold the storage queue.
async function ensureDatabaseCache() {
    if (!(await loadDbCacheIfMissing())) throw new Error('Database not found');
    return dbCache[DB_HEX_KEY];
}

function locateAssetManifestOwner(database, kind, ownerId) {
    if (kind === 'module') {
        const index = (database.modules || []).findIndex((owner, i) => moduleOwnerId(owner, i) === ownerId);
        return { collectionKey: 'modules', index, descriptorKey: 'assetManifest', nested: false };
    }
    if (kind === 'character') {
        const index = (database.characters || []).findIndex((owner, i) => characterOwnerId(owner, i) === ownerId);
        return { collectionKey: 'characters', index, descriptorKey: 'additionalAssetManifest', nested: false };
    }
    if (kind === 'persona-module') {
        const index = (database.personas || []).findIndex((owner, i) => personaOwnerId(owner, i) === ownerId);
        return { collectionKey: 'personas', index, descriptorKey: 'assetManifest', nested: true };
    }
    return null;
}

function replaceCachedAssetManifestDescriptor(database, kind, ownerId, descriptor) {
    const location = locateAssetManifestOwner(database, kind, ownerId);
    if (!location || location.index < 0) {
        const error = new Error(`Asset manifest owner not found in database cache: ${kind}/${ownerId}`);
        error.code = 'MANIFEST_VALIDATION';
        throw error;
    }
    const currentList = database[location.collectionKey];
    const currentOwner = currentList[location.index];
    let nextOwner;
    if (location.nested) {
        nextOwner = {
            ...currentOwner,
            embeddedModule: {
                ...currentOwner.embeddedModule,
                [location.descriptorKey]: descriptor,
            },
        };
    } else {
        nextOwner = { ...currentOwner, [location.descriptorKey]: descriptor };
    }
    const nextList = currentList.slice();
    nextList[location.index] = nextOwner;
    return {
        nextDatabase: { ...database, [location.collectionKey]: nextList },
        collectionKey: location.collectionKey,
    };
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
    // Exception: the plugin-storage dump is a bulk transfer the client reads
    // to the end (no heartbeats), and long-term-memory plugins push it to
    // hundreds of MB of text — over a remote link gzip pays off (#93).
    if (contentType.includes('application/x-ndjson')) {
        if (url.split('?')[0] === '/api/plugin-storage/all') {
            return true;
        }
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

// PocketRisu -> Termux native Android notification
app.post('/api/termux-notify', async (req, res) => {
    if (!await checkAuth(req, res)) return;

    // A request relayed through a local reverse proxy arrives with a loopback
    // remoteAddress even when the browser is remote, so any forwarded request
    // counts as non-local.
    const addr = String(req.socket.remoteAddress || '');
    const isLoopback =
        !req.headers['x-forwarded-for'] && (
            addr === '127.0.0.1' ||
            addr === '::1' ||
            addr === '::ffff:127.0.0.1'
        );

    if (!isLoopback) {
        return res.status(403).json({ error: 'localhost only' });
    }

    const prefix = process.env.PREFIX;

    if (!prefix) {
        return res.status(503).json({
            error: 'Termux environment not available'
        });
    }

    const bin = path.join(prefix, 'bin', 'termux-notification');

    if (!existsSync(bin)) {
        return res.status(503).json({
            error: 'termux-notification not installed'
        });
    }

    const elapsedMs = Number(req.body?.elapsedMs);

    const elapsedText = Number.isFinite(elapsedMs)
        ? `${(elapsedMs / 1000).toFixed(1)}s`
        : 'time unavailable';

    const character =
        typeof req.body?.character === 'string'
            ? req.body.character.trim().slice(0, 80)
            : '';

    const title = character
        ? `PocketRisu · ${character}`
        : 'PocketRisu';

    // Reuse one notification slot so repeated responses do not stack.
    const child = spawn(bin, [
        '--id', '8472',
        '--title', title,
        '--content', `Response complete · ${elapsedText}`,
        '--priority', 'high',
        '--sound'
    ], {
        stdio: 'ignore'
    });

    let replied = false;

    child.once('error', (error) => {
        console.error('[TermuxNotify]', error);

        if (!replied) {
            replied = true;
            res.status(500).json({
                error: 'notification failed'
            });
        }
    });

    child.once('close', (code) => {
        if (!replied) {
            replied = true;
            res.status(code === 0 ? 200 : 500).json({
                ok: code === 0
            });
        }
    });
});

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

// A server restart mid-save (the update popup lets a user start a backup and
// then update) leaves `risu-backup-<ts>.bin.tmp` behind: invisible in the
// backup list, never cleaned. Sweep only stale ones — a fresh .tmp may belong
// to a save still running in another instance.
function sweepStaleBackupTmp() {
    const STALE_MS = 60 * 60 * 1000;
    try {
        for (const name of readdirSync(backupsDir)) {
            if (!/^risu-backup-\d+\.bin\.tmp$/.test(name)) continue;
            const full = path.join(backupsDir, name);
            try {
                if (Date.now() - statSync(full).mtimeMs < STALE_MS) continue;
                unlinkSync(full);
                console.log(`[Server Backup] Removed stale temp file: ${name}`);
            } catch { /* in use or already gone */ }
        }
    } catch { /* directory unreadable: nothing to sweep */ }
}
sweepStaleBackupTmp();

// Top-level app-root entry holding a custom backup directory (null when the
// directory is the default, outside the app root, or inside managed files),
// so an in-app self-update preserves it exactly like scripts/updater.cjs does.
function customBackupKeepEntry(rootDir) {
    const rel = path.relative(rootDir, path.resolve(backupsDir));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    const top = rel.split(path.sep)[0];
    if (!top || MANAGED_BACKUP_PATH_ROOTS.has(top)) return null;
    return top;
}

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
// Backup uploads are cut off once the client has sent nothing for this long
// (upload-stall.cjs).
const BACKUP_UPLOAD_STALL_MS = Number(process.env.POCKETRISU_BACKUP_UPLOAD_STALL_MS) || 2 * 60 * 1000;
const { watchUploadStall: watchUploadStallFor } = require('./upload-stall.cjs');
const watchUploadStall = (req) => watchUploadStallFor(req, BACKUP_UPLOAD_STALL_MS);
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

// Derived thumbnails live in a subfolder (inlay scans only look at files; the
// import swap replaces the whole inlay folder, cache included). A thumbnail is
// named after the exact source version it was built from, so a cache hit can
// never be stale; removing a source file removes its version's thumbnail.
const inlayThumbDir = path.join(inlayDir, '.thumbs')

function inlaySourceVersion(stat) {
    return `${Math.floor(stat.mtimeMs)}-${stat.size}`;
}

function getInlayThumbPath(id, version) {
    if (!isSafeInlayId(id)) throw new Error(`Invalid inlay id: ${id}`);
    const p = path.join(inlayThumbDir, `${id}.${version}.webp`);
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
    const stat = await fs.stat(filePath).catch(() => null);
    if (stat) await fs.unlink(getInlayThumbPath(id, inlaySourceVersion(stat))).catch(() => {});
    await fs.unlink(filePath).catch(() => {});
}

function deleteInlayRawFileSync(id) {
    const filePath = resolveInlayFilePathSync(id);
    if (!filePath) return;
    try {
        unlinkSync(getInlayThumbPath(id, inlaySourceVersion(statSync(filePath))));
    } catch {
        // ignore
    }
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

// Backup GETs are also opened as plain browser downloads (<a download>), which
// carry the session cookie (HttpOnly, SameSite=Strict) but no risu-auth header.
async function checkBackupDownloadAuth(req, res) {
    const token = parseSessionCookie(req)
    if (token && (sessions.get(token) ?? 0) > Date.now()) return true
    return checkAuth(req, res)
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
// same protection extends across devices. Lock rules live in session-lock.cjs:
// page loads REGISTER but never steal the lock (an OS-restored phone tab must
// not kick a PC mid-session); ownership moves on the first WRITE from a
// freshly-booted session, and only stale sessions get 423.
const { createSessionLock } = require('./session-lock.cjs');
const sessionLock = createSessionLock();
const SESSION_WRITE_MAX_MS = process.env.POCKETRISU_SESSION_WRITE_MAX_MS
    ? Number(process.env.POCKETRISU_SESSION_WRITE_MAX_MS)
    : 5 * 60 * 1000;
// Below the client's 30 s request timeout, so the page gets an answer.
const SESSION_IDLE_WAIT_MS = 10 * 1000;

// Waits until no accepted write is under way, then runs onIdle in that same
// synchronous step: another request can start a write between a waiter's
// wake-up and the code after its await. Returns false without running
// onIdle if the wait takes longer than SESSION_IDLE_WAIT_MS.
async function whenSessionWritesIdle(onIdle) {
    const deadline = Date.now() + SESSION_IDLE_WAIT_MS;
    while (!sessionLock.isIdle()) {
        const left = deadline - Date.now();
        if (left <= 0 || !await sessionLock.whenIdle(left)) return false;
    }
    onIdle();
    return true;
}

function checkActiveSession(req, res, { allowDuringAccountImport = false, changesData = true, replacesData = false } = {}) {
    // A started RisuAI account import will replace all data: nothing may
    // write until it ends. Its own routes work from any open import screen.
    if (risuAccountImport.isBlocking()) {
        if (allowDuringAccountImport) return true
        res.status(423).json({ error: 'A RisuAI account import is in progress', code: 'ACCOUNT_IMPORT_ACTIVE' })
        return false
    }
    const clientSessionId = req.headers['x-session-id']
    // The client attaches x-user-active only when a real user gesture happened
    // recently — automatic writes (boot housekeeping, flush-on-hide) carry no
    // gesture and must never move the lock (session-lock.cjs rules).
    const userActive = req.headers['x-user-active'] === '1'
    const result = sessionLock.checkWrite(typeof clientSessionId === 'string' ? clientSessionId : '', userActive)
    if (result.tookOver) {
        console.log('[Session] Write lock taken over by a freshly-booted session')
    }
    if (result.ok) {
        // Under way until the route answers, which it does once its write is
        // applied (session-lock.cjs writeStarted). That answer comes with
        // 'prefinish' even when the client has gone; 'close' fires as soon as
        // the connection drops, while the route goes on writing. Routes that
        // leave the data as it was (a backup copy, compacting the database)
        // can run for minutes and a page booting meanwhile reads the same
        // data, so they are not counted.
        if (!changesData) return true
        sessionLock.writeStarted()
        // 'running' → 'released' (by the cap) → 'ended'
        let state = 'running'
        const end = () => {
            if (state === 'ended') return
            clearTimeout(cap)
            // Pages booted after the cap let them through read the data
            // without this write: none of them may save over it now.
            if (state === 'released') sessionLock.revokeAll()
            else sessionLock.writeEnded()
            state = 'ended'
        }
        res.once('prefinish', end)
        // A route that fails after its answer started never answers in full;
        // the error middleware ends it then.
        res.locals.endSessionWrite = end
        // A write still running after SESSION_WRITE_MAX_MS must not hold every
        // page boot back. Whatever it has put in the storage queue lands
        // first; whatever it does later is covered by end(). Backup imports
        // (replacesData) replace the data outside that queue, so a release
        // would let pages boot fresh and save right before the import
        // overwrites them: those keep counting until they end, and cut off a
        // stalled upload themselves (watchUploadStall).
        let cap = null
        if (!replacesData) {
            cap = setTimeout(() => {
                queueStorageOperation(async () => {}).then(() => {
                    if (state !== 'running') return
                    state = 'released'
                    sessionLock.writeEnded()
                })
            }, SESSION_WRITE_MAX_MS)
            cap.unref()
        }
        return true
    }
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

// Hex `file-path` headers are case-insensitive to decode but dbCache is keyed
// by the raw string, so an upper-case header would get its own cache entry
// and dodge every check that reads the canonical (lower-case) key.
function normalizeFilePathHeader(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

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

// /proxy2 inactivity bound (issue #84). The total timeout above only exists
// when the client sends risu-timeout-ms (local-network requests do; plugin
// nativeFetch and image generation do not), so a half-open upstream or a
// middlebox that swallowed the connection used to leave the relay — and the
// browser reader behind it — waiting forever. This aborts the upstream fetch
// when nothing has arrived for PROXY_IDLE_TIMEOUT_MS: armed at request start
// (covers the pre-header silence) and re-armed on every body chunk. Generous
// on purpose — thinking models stay silent for minutes before the first byte.
const PROXY_IDLE_TIMEOUT_MS = 600000;

// The client hanging up (Stop, closed tab) must cancel the upstream request.
// Once the body streams, pipeline() tears the upstream down on its own; this
// covers the wait before the first byte, which can run for minutes.
function abortUpstreamOnClientClose(res, idle) {
    res.on('close', () => {
        if (!res.writableEnded) idle.abort();
    });
}

function createIdleWatchdog(idleMs, totalSignal) {
    const controller = new AbortController();
    let timer = null;
    let firedIdle = false;
    const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => { firedIdle = true; controller.abort(); }, idleMs);
    };
    const onTotal = () => controller.abort();
    totalSignal?.addEventListener('abort', onTotal, { once: true });
    arm();
    return {
        signal: controller.signal,
        idle: () => firedIdle,
        abort: () => controller.abort(),
        touch: arm,
        // Resets the idle timer on every chunk that flows through the relay.
        transform: () => new Transform({
            transform(chunk, _enc, cb) { arm(); cb(null, chunk); }
        }),
        cleanup: () => {
            clearTimeout(timer);
            totalSignal?.removeEventListener('abort', onTotal);
        }
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
// normalizeForwardHeaders (the shared security strip-list) lives in utils.cjs.

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

// Upstream (#1484) writes cold storage backup entries as flat
// coldstorage_<uuid>.json names; older backups and the runtime KV use
// coldstorage/<uuid>. Match upstream's UUID pattern for the flat form so
// ordinary assets that merely start with "coldstorage_" are not captured.
const COLD_STORAGE_FLAT_NAME_RE = /^coldstorage_([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:\.json)?$/;

function normalizeColdStorageStorageKey(nameOrKey) {
    let key = nameOrKey;
    if (key.startsWith('coldstorage/')) {
        key = key.slice('coldstorage/'.length);
    } else {
        const flat = COLD_STORAGE_FLAT_NAME_RE.exec(key);
        if (flat) {
            key = flat[1];
        }
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

    // Upstream backups transport cold storage as coldstorage/<uuid>.json
    // (pre-#1484) or flat coldstorage_<uuid>.json (#1484 onwards).
    // Normalize back to the runtime KV key: coldstorage/<uuid>.
    if (name.startsWith('coldstorage/') || COLD_STORAGE_FLAT_NAME_RE.test(name)) {
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

// ─── Backup import guards ───────────────────────────────────────────────────

function backupImportError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

// Upstream RisuAI (web build, account sync) has encrypted database.risudat in
// its local backups since v2026.6.102 (kwaroran/RisuAI d0548267). The key is
// fetched from sv.risuai.xyz per backup and is not obtainable from here.
const BACKUP_ENCRYPTED_MESSAGE =
    'This backup was exported from the RisuAI web version (risuai.xyz), so its database is encrypted and can only be opened on risuai.xyz. ' +
    'Turn on "Save Data in Account" in RisuAI, then use "Import from RisuAI account" in Data Migration. Your existing database was not replaced.';

// decodeRisuSave has lenient fallbacks that can turn random bytes into a
// msgpack primitive instead of throwing, so the result must also be an object.
async function assertBackupDatabaseDecodable(raw) {
    let decoded;
    try {
        decoded = await decodeRisuSave(raw);
    } catch (error) {
        throw backupImportError(
            `Backup database could not be decoded (${error?.message || error}). The file may be corrupted or encrypted. Your existing database was not replaced.`,
            'BACKUP_DATABASE_UNREADABLE'
        );
    }
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
        throw backupImportError(
            'Backup database is not a RisuAI database. The file may be corrupted or encrypted. Your existing database was not replaced.',
            'BACKUP_DATABASE_UNREADABLE'
        );
    }
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
    // database.risudat is held back and written only after the whole stream
    // was read and the payload proved decodable (see below the loop).
    let pendingDatabase = null;
    // Set when the upstream encryption marker is seen. The upload is then
    // only drained: replying while the client is still sending makes the
    // browser (and Node's fetch) report a connection reset instead of
    // delivering the error event, so the rejection waits for the stream end.
    let encryptedMarker = false;
    let assetsRestored = 0;
    let bytesReceived = 0;
    let batchCount = 0;
    const seenEntryNames = new Set();
    const importedInlayIds = new Set();
    const importedSidecarIds = new Set();
    const explicitSidecarMap = new Map();
    const legacyInlayInfoMap = new Map();
    // Rows a backup replaces wholesale. They are deleted in the final
    // transaction, and only those the backup did not bring: entries are
    // committed in BATCH_SIZE batches, so a delete in the first batch survived
    // a rejection later in the stream (duplicate entry, the encryption marker
    // upstream writes after every asset, a truncated upload, an undecodable
    // database) and left the old database without its images and cold items.
    // Rows the import creates are removed again when it fails (createdKeys).
    // Incoming rows overwrite same-named old rows on the way in and stay;
    // asset names are content hashes and cold ids are UUIDs, so those carry
    // the same data.
    const REPLACED_PREFIXES = ['assets/', 'inlay/', 'inlay_thumb/', 'inlay_meta/', 'inlay_info/', 'coldstorage/', 'drafts/', 'remotes/'];
    const importedKeys = new Set();
    const createdKeys = new Set();

    const stagingDir = path.join(savePath, 'inlays_import_staging');
    const backupInlayDir = path.join(savePath, 'inlays_import_backup');
    await fs.rm(stagingDir, { recursive: true, force: true });
    await fs.rm(backupInlayDir, { recursive: true, force: true });
    await fs.mkdir(stagingDir, { recursive: true });

    // Entry ids become file names here. Ids are validated before use, and
    // this check keeps a crafted name from writing outside the staging dir
    // even if a parser misses one (e.g. "\" separators on Windows).
    const resolvedStagingDir = path.resolve(stagingDir) + path.sep;
    function assertInsideStagingDir(filePath) {
        if (!path.resolve(filePath).startsWith(resolvedStagingDir)) {
            throw new Error(`Path escapes inlay import staging directory: ${filePath}`);
        }
        return filePath;
    }
    function stagingInlayFilePath(id, ext) {
        return assertInsideStagingDir(path.join(stagingDir, `${id}.${normalizeInlayExt(ext)}`));
    }
    function stagingSidecarPath(id) {
        return assertInsideStagingDir(path.join(stagingDir, `${id}.meta.json`));
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
    // Always snapshot the live database right before it is replaced. The
    // default cooldown could skip this when an autosave snapshot landed
    // within the last few minutes, leaving no pre-import copy to restore.
    createBackupAndRotate({ force: true });

    sqliteDb.pragma('synchronous = OFF');

    sqliteDb.exec('BEGIN');

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
                if (encryptedMarker) return;
                if (seenEntryNames.has(name)) {
                    throw new Error(`Duplicate backup entry: ${name}`);
                }
                seenEntryNames.add(name);

                const inlayRaw = parseInlayBackupName(name);
                const inlaySidecar = parseInlaySidecarBackupName(name);

                if (inlayRaw) {
                    // parseInlayBackupName only rejects "/"; an id with "\"
                    // or ".." would escape the staging dir on Windows.
                    if (!isSafeInlayId(inlayRaw.id)) {
                        throw new Error(`Invalid inlay backup entry name: ${name}`);
                    }
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
                } else if (name === 'encryption.risudat') {
                    // Upstream RisuAI (web build, account sync) writes this
                    // marker when database.risudat is AES-GCM encrypted with
                    // a key only sv.risuai.xyz hands out. We cannot read it,
                    // and storing the ciphertext bricked the instance on the
                    // next boot, so nothing after this marker is stored and
                    // the import is rejected once the upload has been read.
                    let meta = null;
                    try { meta = JSON.parse(data.toString('utf-8')); } catch (_) {}
                    if (meta?.type === 'account') {
                        encryptedMarker = true;
                    }
                    // Unknown marker shape: upstream ignores it and loads the
                    // database as-is, so do the same — the decode check
                    // below the loop still guards against garbage.
                } else {
                    const storageKey = resolveBackupStorageKey(name);
                    if (storageKey === 'database/database.bin') {
                        pendingDatabase = data;
                    } else {
                        const storageValue = storageKey.startsWith('coldstorage/')
                            ? encodeColdStorageCanonicalBuffer(
                                parseColdStorageJsonBuffer(data, name, { allowPlainJson: true }).coldData
                            )
                            : data;
                        if (kvGetUpdatedAt(storageKey) === null) createdKeys.add(storageKey);
                        kvSet(storageKey, storageValue);
                        importedKeys.add(storageKey);
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

        if (encryptedMarker) {
            throw backupImportError(BACKUP_ENCRYPTED_MESSAGE, 'BACKUP_ENCRYPTED');
        }
        if (pendingTotal > 0) {
            throw new Error('Backup stream ended with incomplete entry');
        }
        if (!pendingDatabase) {
            throw new Error('Backup does not contain database.risudat');
        }
        // Prove the database decodes before it replaces the live blob. Up to
        // v1.11.2 the bytes were committed first and decoded only afterwards,
        // so an unreadable payload (encrypted upstream backup, corrupt file)
        // left /api/read failing with 500 on every boot — infinite loading
        // with no way back from the UI.
        await assertBackupDatabaseDecodable(pendingDatabase);
        kvSet('database/database.bin', pendingDatabase);
        for (const [id, info] of legacyInlayInfoMap.entries()) {
            if (importedInlayIds.has(id) && !importedSidecarIds.has(id)) {
                writeStagingSidecarSync(id, info);
            }
        }
        // Backup = full replace, same as assets/. The .bin carries plugin
        // storage inside database.risudat (export reassembles it there, never
        // as kv entries), so decodeDatabaseWithPersistentChatIds below
        // re-splits it. Cleared only in the FINAL transaction, after the
        // stream validated: entries are committed in BATCH_SIZE batches, so a
        // delete in the first batch would survive a later truncation failure
        // and leave the old database.bin with its plugin rows gone. Dropping
        // the marker with the prefix makes the re-split a first migration
        // (DB-wins), which is what a full replace means.
        kvDelPrefix(pluginStorage.PREFIX);
        // See REPLACED_PREFIXES. archive/ and archive-meta/ rows are
        // deliberately NOT wiped: the imported database is inlined and
        // references none of them, and the pre-import snapshot may still.
        // They become orphan rows for the dashboard purge. Composer drafts are
        // session/device-local and not carried in the backup, so stale ones
        // go and an old snapshot's chats don't resurrect later drafts. Stale
        // remote payloads go for the same reason as in clearExistingData
        // (save-folder import): .bin backups never carry REMOTE blocks today,
        // but keeping the two import paths consistent avoids a contamination
        // regression if that ever changes.
        for (const prefix of REPLACED_PREFIXES) {
            for (const key of kvList(prefix)) {
                if (!importedKeys.has(key)) kvDel(key);
            }
        }
        // Allow remote-block migration to re-evaluate against the new
        // database.bin — a fresh import is a clear "data changed" signal.
        kvDel(REMOTE_MIGRATION_MARKER_KEY);
        clearEntities();
        sqliteDb.exec('COMMIT');
    } catch (error) {
        try { sqliteDb.exec('ROLLBACK'); } catch (_) {}
        // Earlier batches are committed already: take back the rows they added.
        if (createdKeys.size > 0) {
            try {
                sqliteDb.transaction(() => {
                    for (const key of createdKeys) kvDel(key);
                })();
            } catch (cleanupError) {
                logger.error(`[Backup Import] Could not remove ${createdKeys.size} row(s) of the failed import:`, cleanupError);
            }
        }
        await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
        await fs.rm(backupInlayDir, { recursive: true, force: true }).catch(() => {});
        throw error;
    } finally {
        sqliteDb.pragma('synchronous = NORMAL');
    }

    // The new database is committed: drop what describes the old one now. A
    // failure in the inlay swap below throws past the rest of this function,
    // and a store left behind would be flushed back over the import.
    invalidateDbCache();

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

    // Trigger cold storage migration now so import result includes failure count.
    const dbRaw = kvGet('database/database.bin');
    let coldStorageFailed = 0;
    let pluginStorageColdFailed = 0;
    if (dbRaw) {
        const migration = {};
        const dbObj = await decodeDatabaseWithPersistentChatIds(dbRaw, {
            createBackup: false,
            migrationResult: migration,
        });
        coldStorageFailed = migration.coldStorageFailed || 0;
        pluginStorageColdFailed = migration.pluginStorageColdFailed || 0;
        await initChatStoreFromDisk(dbObj);
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
    if (pluginStorageColdFailed > 0) {
        logger.error(`[Backup Import] ${pluginStorageColdFailed} plugin storage item(s) could not be restored from cold storage`);
    }
    return { assetsRestored, bytesReceived, coldStorageFailed, pluginStorageColdFailed };
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
    // A client-configured total timeout longer than the default idle bound
    // (localNetworkTimeoutSec up to 3600s) must not be undercut by it.
    const idleMs = Math.max(PROXY_IDLE_TIMEOUT_MS, timeoutMs || 0);
    const idle = createIdleWatchdog(idleMs, timeout.signal);
    abortUpstreamOnClientClose(res, idle);
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
            signal: idle.signal
        });
        // get response body as stream
        const originalBody = originalResponse.body;
        // get response headers
        const head = new Headers(originalResponse.headers);
        head.delete('content-security-policy');
        head.delete('content-security-policy-report-only');
        head.delete('clear-site-data');
        // Targets picked by the risu-url header all share the /proxy(2) URL, so
        // no cache (browser or CDN) may store a relay response for reuse, and
        // upstream cache headers (Expires, CDN-only ones) must not override that.
        head.set('Cache-Control', 'private, no-store');
        head.delete('Expires');
        head.delete('CDN-Cache-Control');
        head.delete('Cloudflare-CDN-Cache-Control');
        head.delete('Surrogate-Control');
        head.delete('Edge-Control');
        head.delete('X-Accel-Expires');
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
        await pipeline(originalResponse.body, idle.transform(), res);


    }
    catch (err) {
        if (err?.name === 'AbortError') {
            // The client left; there is no one to send an error to.
            if (res.destroyed) return;
            if (!res.headersSent) {
                res.status(504).send({
                    error: idle.idle()
                        ? `Proxy upstream sent nothing for ${idleMs}ms`
                        : timeoutMs
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
        idle.cleanup();
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
    // A client-configured total timeout longer than the default idle bound
    // (localNetworkTimeoutSec up to 3600s) must not be undercut by it.
    const idleMs = Math.max(PROXY_IDLE_TIMEOUT_MS, timeoutMs || 0);
    const idle = createIdleWatchdog(idleMs, timeout.signal);
    abortUpstreamOnClientClose(res, idle);
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
            signal: idle.signal
        });
        // get response body as stream
        const originalBody = originalResponse.body;
        // get response headers
        const head = new Headers(originalResponse.headers);
        head.delete('content-security-policy');
        head.delete('content-security-policy-report-only');
        head.delete('clear-site-data');
        // Targets picked by the risu-url header all share the /proxy(2) URL, so
        // no cache (browser or CDN) may store a relay response for reuse, and
        // upstream cache headers (Expires, CDN-only ones) must not override that.
        head.set('Cache-Control', 'private, no-store');
        head.delete('Expires');
        head.delete('CDN-Cache-Control');
        head.delete('Cloudflare-CDN-Cache-Control');
        head.delete('Surrogate-Control');
        head.delete('Edge-Control');
        head.delete('X-Accel-Expires');
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
        await pipeline(originalResponse.body, idle.transform(), res);
    }
    catch (err) {
        if (err?.name === 'AbortError') {
            // The client left; there is no one to send an error to.
            if (res.destroyed) return;
            if (!res.headersSent) {
                res.status(504).send({
                    error: idle.idle()
                        ? `Proxy upstream sent nothing for ${idleMs}ms`
                        : timeoutMs
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
        idle.cleanup();
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

// --- Model Job endpoints (durable server-side model-preset relay) ---
// Recorder pattern: the server makes the provider request, streams the bytes
// to the client unchanged, and journals the same bytes to disk so a client
// that disconnects mid-generation can recover the response. All logic lives
// in model-jobs.cjs; registers /api/model-jobs* with /proxy2-level auth.
const { createModelJobs } = require('./model-jobs.cjs');
const modelJobs = createModelJobs({ saveDir: savePath, logger });
modelJobs.registerRoutes(app, { auth: checkProxyAuth });

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

// Reload-on-return check: side-effect-free writer-lock state for this session.
// The client calls it when the tab regains visibility/focus and reloads ONLY
// on 'stale' — before the user has done anything, so nothing is lost.
app.get('/api/session/lock-status', async (req, res) => {
    if (!await checkAuth(req, res)) return
    const id = req.headers['x-session-id']
    // During an account import every open page reloads into the import screen.
    res.json({ state: risuAccountImport.isBlocking() ? 'stale' : sessionLock.peek(typeof id === 'string' ? id : '') })
})

// "Keep using this tab" from the deactivated dialog: hands the write lock to
// the id the tab boots with after its reload (session-lock.cjs claim()).
app.post('/api/session/claim', async (req, res) => {
    if (!await checkAuth(req, res)) return
    if (risuAccountImport.isBlocking()) {
        res.status(423).json({ error: 'A RisuAI account import is in progress', code: 'ACCOUNT_IMPORT_ACTIVE' })
        return
    }
    const id = req.headers['x-session-id']
    if (typeof id !== 'string' || id === '') {
        res.status(400).json({ error: 'Missing session id' })
        return
    }
    if (!sessionLock.claim(id)) {
        res.status(409).json({ error: 'Session id already in use' })
        return
    }
    // Writes accepted before the claim may still be under way. Answer once
    // they have landed, so the reload that follows reads them instead of a
    // copy it would later save over them: it boots as the holder, so no
    // stale check would stop it. If they take too long, refuse and give the
    // lock back; the client then keeps its old id and that page stays stale.
    if (!await whenSessionWritesIdle(() => {})) {
        sessionLock.unclaim(id)
        res.status(503).json({ error: 'Earlier writes are still in progress' })
        return
    }
    await queueStorageOperation(async () => {})
    console.log('[Session] Write lock claimed by user request')
    res.json({ ok: true })
})

// ── Session cookie issuance (F-0) ──────────────────────────────────────────
// Called once after JWT auth succeeds. Issues a long-lived cookie so that
// <img src="/api/asset/..."> requests can be authenticated without JS.
app.post('/api/session', async (req, res) => {
    if (!await checkAuth(req, res)) return
    const clientSessionId = req.headers['x-session-id']
    if (typeof clientSessionId === 'string') {
        // Registers the boot; takes the lock only if nobody holds it. The
        // page reads its data after this answer, so writes still under way
        // land first; if they take too long, the boot counts as stale.
        const register = () => sessionLock.register(clientSessionId)
        if (!await whenSessionWritesIdle(register)) sessionLock.register(clientSessionId, true)
        console.log('[Session] Session boot registered')
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

// wasm-vips runs synchronously on the event loop, so builds are serialized:
// other requests get served between them, and a request queued behind a build
// of the same thumbnail finds it cached instead of building it again.
let thumbnailQueue = Promise.resolve();

async function getInlayThumbnail(id, sourcePath, version) {
    const thumbPath = getInlayThumbPath(id, version);
    const readCached = () => fs.readFile(thumbPath).catch(() => null);
    const cached = await readCached();
    if (cached) return cached;
    const build = thumbnailQueue.then(async () => {
        const fresh = await readCached();
        if (fresh) return fresh;
        const thumb = await generateThumbnail(await fs.readFile(sourcePath));
        const tmpPath = `${thumbPath}.tmp`;
        try {
            await fs.mkdir(inlayThumbDir, { recursive: true });
            await fs.writeFile(tmpPath, thumb);
            await fs.rename(tmpPath, thumbPath);
        } finally {
            await fs.rm(tmpPath, { force: true });
        }
        return thumb;
    });
    thumbnailQueue = build.catch(() => {});
    return await build;
}

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
            const filePath = await resolveInlayFilePath(id)
            if (!filePath) return res.status(404).set('Cache-Control', 'no-store').end()
            const stat = await fs.stat(filePath)
            const etag = `"thumb-${Math.floor(stat.mtimeMs)}"`
            if (req.headers['if-none-match'] === etag) {
                return res.status(304).set('Cache-Control', 'public, max-age=31536000, immutable').end()
            }
            const thumb = await getInlayThumbnail(id, filePath, inlaySourceVersion(stat))
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
    const filePath = normalizeFilePathHeader(req.headers['file-path']);
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
        if (value === null) {
            res.send();
        } else {
            // Strip chat payloads and asset manifests from database.bin — the
            // client gets stubs and descriptors only.
            if (key === 'database/database.bin') {
                try {
                    // Cold load runs under the storage queue so it cannot
                    // race a cold /api/patch (see loadDbCacheIfMissing). A
                    // warm cache is served directly without queueing, so a
                    // read can never re-activate a superseded manifest.
                    if (!dbCache[filePath]) {
                        await queueStorageOperation(() => loadDbCacheIfMissing({ createBackup: true }));
                    }
                    value = Buffer.from(encodeRisuSaveLegacy(dbCache[filePath]));
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
        logger.error('[Read] Failed to read stored data', error);
        next(error);
    }
});

// Names + sizes of every plugin-storage key, no values. Backs the client's
// synchronous keys()/length and the storage viewer. `migrated` is whether the
// DB→kv split has ever run on this instance (marker present).
app.get('/api/plugin-storage/index', async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    try {
        res.json({ entries: pluginStorage.list(), migrated: pluginStorage.isMigrated() });
    } catch (error) {
        next(error);
    }
});

// Every plugin-storage value, streamed as NDJSON lines `[key, json]` straight
// from kv so the set is never materialized as one object. Backs the V2
// preload: the V2 API is synchronous, so every key has to be in the client
// cache before a V2 plugin runs, and fetching N keys one GET at a time made
// plugin loading take minutes over a remote link (v1.11.0 report).
app.get('/api/plugin-storage/all', async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    try {
        res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
        let closed = false;
        res.once('close', () => { closed = true; });
        for (const entry of pluginStorage.entriesRaw()) {
            if (closed) return;
            const ok = res.write(JSON.stringify([entry.key, entry.text]) + '\n');
            // Wait for backpressure to clear, but stop if the client went away.
            // When compressed, the compression middleware forwards 'drain'
            // listeners to its zlib stream, so remove the listener from the
            // emitter res.on returned — res.off would leave one behind per
            // backpressure cycle.
            if (!ok) await new Promise((resolve) => {
                let drainEmitter;
                const done = () => { drainEmitter.off('drain', done); res.off('close', done); resolve(); };
                drainEmitter = res.on('drain', done);
                res.once('close', done);
            });
        }
        res.end();
    } catch (error) {
        if (res.headersSent) { res.destroy(error); return; }
        next(error);
    }
});

app.get('/api/remove', async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    if (!checkActiveSession(req, res)) return;
    const filePath = normalizeFilePathHeader(req.headers['file-path']);
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
        if (key.startsWith('assets/') || key.startsWith('remotes/')) {
            return res.status(409).send({ error: 'asset removal must go through server-side cleanup' });
        }
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
        // A DB snapshot owns a plugin-storage map row + blobs; a raw kvDel
        // would orphan them (never GC'd, never counted).
        if (isSnapshotKey(key)) {
            deleteSnapshot(key);
            return res.send({ success: true });
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

// ─── /api/request-logs — provider request log + token usage statistics ───────
// Own SQLite file (save/request-logs.db) with its own rotation policy; see
// server/node/request-logs.cjs. Registered with the same auth the /api/logs
// endpoints use.
const requestLogs = createRequestLogs({ saveDir: savePath });
requestLogs.registerRoutes(app, { auth: checkAuth, activeSession: checkActiveSession });

app.post('/api/write', async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    if (!checkActiveSession(req, res)) return;
    const filePath = normalizeFilePathHeader(req.headers['file-path']);
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
                // dbEtag is null after a restart or cache invalidation until
                // a /api/read recomputes it; a stale client's full write must
                // not slip through that window, so derive it from the current
                // client view when the writer sent a precondition.
                if (ifMatch && !dbEtag && (await loadDbCacheIfMissing())) {
                    dbEtag = computeBufferEtag(Buffer.from(encodeRisuSaveLegacy(dbCache[DB_HEX_KEY])));
                }
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
                    // eslint-disable-next-line no-var
                    var persistedEtag;
                    // eslint-disable-next-line no-var
                    var persistedHashes;
                    // eslint-disable-next-line no-var
                    var persistedView;
                    const incomingDb = await decodeRisuSave(fileContent);
                    const archiveConflict = findArchiveConflicts(dbCache[DB_HEX_KEY], incomingDb, null);
                    if (archiveConflict) {
                        logger.warn(`[Write] Rejected: ${archiveConflict}`);
                        res.status(409).send({
                            error: `Write rejected: ${archiveConflict}`,
                            code: 'ARCHIVE_GUARD_REJECTED',
                            currentEtag: dbEtag ?? undefined,
                        });
                        return;
                    }
                    await ensureChatStore();
                    let fullDb = hydrateDatabaseForDisk(incomingDb);
                    // Same archive-row restore as persistDbCacheWithChats: a
                    // full write must not land a reactivated character's
                    // bodiless stubs on disk while its rows hold the bodies.
                    if (findUnmergedArchivedChats(fullDb).length > 0) {
                        try {
                            fullDb = await restoreArchivedChatsForDisk(fullDb, '/api/write');
                        } catch (error) {
                            const err = new Error(`write aborted: a deactivated character's archive row is unreadable — ${error?.message || error}`);
                            recordPersistFailure(err, '/api/write:archive-unreadable');
                            logger.error(`[Write] ${err.message}`);
                            res.status(500).json({ error: 'Write aborted: archive row unreadable' });
                            return;
                        }
                    }

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

                    // Same boundary for lazy asset manifests (see
                    // findAssetManifestLossOwners). Compared against the
                    // stripped client view; load it from disk when the cache
                    // is cold (restart, or a writer that never called
                    // /api/read) so only a first-ever write is unguarded.
                    const manifestLosses = (await loadDbCacheIfMissing())
                        ? findAssetManifestLossOwners(dbCache[DB_HEX_KEY], incomingDb)
                        : [];
                    if (manifestLosses.length > 0) {
                        const sample = manifestLosses.slice(0, 3).map(l => `${l.kind}:${l.ownerId}`).join(', ');
                        const err = new Error(
                            `write aborted: ${manifestLosses.length} owner(s) would lose their asset manifest `
                            + `without an inline asset list. sample=[${sample}]`
                        );
                        recordPersistFailure(err, '/api/write:asset-manifest-loss');
                        logger.error(`[Write] ${err.message}`);
                        res.status(500).json({ error: 'Write aborted: asset manifest integrity check failed' });
                        return;
                    }

                    // A client that still ships a populated pluginCustomStorage
                    // (older build, or one that never reloaded after the
                    // split) is the only writer of that data — split it into
                    // kv now, DB-wins, so the blob on disk never carries
                    // plugin data. Without this the next cold decode would
                    // re-migrate it over kv values written by newer clients.
                    // A throw here rolls the kv rows back and aborts the
                    // write below, leaving disk untouched.
                    const pluginMigration = pluginStorage.migrateFromDb(fullDb, {
                        createSnapshot: () => createBackupAndRotate({ force: true }),
                    });
                    if (pluginMigration.migrated) {
                        // fullDb is a fresh decode, not the dbCache root — no
                        // hash-cache aliasing concern; dbCache is dropped below.
                        fullDb.pluginCustomStorage = {};
                        logger.info(`[PluginStorage] Split ${pluginMigration.keys} key(s) from a full database.bin write into kv`);
                    }

                    const mergedContent = Buffer.from(encodeRisuSaveLegacy(fullDb));
                    // Re-init chat store from merged result
                    initChatStore(fullDb);
                    kvSet(key, mergedContent);
                    // ETag of what the next /api/read will serve: the
                    // PERSISTED DB, stripped. Not the request bytes — the
                    // split above may have emptied pluginCustomStorage, so
                    // the client's copy and the served copy differ.
                    persistedView = normalizeJSON(stripDatabaseForClient(fullDb, { reconcileManifests: true }));
                    persistedEtag = computeDatabaseEtagFromObject(persistedView);
                    // Hashes of that same view, so the client can tell at once
                    // whether the baseline it re-seeds from its own bytes matches
                    // what the server holds — a silent difference here is what
                    // turns every later save into a full write.
                    try {
                        // keyHashes first: hash() then composes from the cached
                        // per-key values instead of walking the view again.
                        const diagnostics = databaseHashDiagnostics(persistedView);
                        persistedHashes = {
                            serverHash: databasePatchHashCache.hash(persistedView).toString(16),
                            ...diagnostics,
                        };
                    } catch {
                        persistedHashes = undefined;
                    }
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
                // Keep the cache warm with the view just persisted: it is the
                // exact object the next /api/read or /api/patch would rebuild
                // by cold-decoding the blob (stripped + normalized, and the
                // patch hash cache is already keyed on it above). Dropping it
                // cost one full decode after every full write.
                if (persistedView) {
                    dbCache[DB_HEX_KEY] = persistedView;
                } else {
                    delete dbCache[DB_HEX_KEY];
                }
                if (saveTimers[DB_HEX_KEY]) {
                    clearTimeout(saveTimers[DB_HEX_KEY]);
                    delete saveTimers[DB_HEX_KEY];
                }
                dbEtag = persistedEtag;
                createBackupAndRotate();
            }

            res.send({
                success: true,
                etag: key === 'database/database.bin' ? dbEtag : undefined,
                ...(key === 'database/database.bin' && persistedHashes ? persistedHashes : {}),
            });
        });
    } catch (error) {
        next(error);
    }
});

// NOT session-locked: flush carries no data — it only asks the server to
// fsync what it already has. It fires automatically on tab-hide from EVERY
// device, so gating it on the write lock made a phone going to background
// steal (or trip over) the lock without any user action.
app.post('/api/db/flush', sessionAuthMiddleware, async (req, res, next) => {
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
    const filePath = normalizeFilePathHeader(req.headers['file-path']);
    let patch = req.body.patch;
    const expectedHash = req.body.expectedHash;

    if (!filePath || !patch || !expectedHash) {
        res.status(400).send({ error: 'File path, patch, and expected hash required' });
        return;
    }
    if (!isHex(filePath)) {
        res.status(400).send({ error: 'Invaild Path' });
        return;
    }

    // Which step of the patch flow was running when the outer catch fired —
    // without it a bare error name (e.g. RangeError) is undiagnosable.
    let patchStage = 'load';
    // Stage timings for the client's save dashboard (see saveMetrics.ts).
    const patchStartedAt = performance.now();
    try {
        await queueStorageOperation(async () => {
            const timings = { queueMs: Math.round(performance.now() - patchStartedAt) };
            let stageAt = performance.now();
            const lap = () => {
                const now = performance.now();
                const ms = Math.round(now - stageAt);
                stageAt = now;
                return ms;
            };
            const decodedKey = Buffer.from(filePath, 'hex').toString('utf-8');

            // Load database into memory if not already cached
            // For database.bin, cache holds the STRIPPED version (stubs only)
            if (!dbCache[filePath]) {
                if (decodedKey === 'database/database.bin') {
                    if (!(await loadDbCacheIfMissing())) dbCache[filePath] = {};
                } else {
                    const fileContent = kvGet(decodedKey);
                    dbCache[filePath] = fileContent
                        ? normalizeJSON(await decodeRisuSave(fileContent))
                        : {};
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

            // Plugin-storage ops (old clients): see partitionPluginStorageOps.
            let pluginKvOps = [];
            if (decodedKey === 'database/database.bin') {
                const partition = partitionPluginStorageOps(patch);
                if (partition.rejected.length > 0) {
                    const sample = partition.rejected.slice(0, 5).map(v => `${v.op} ${v.path}`).join(', ');
                    logger.warn(`[Patch] Rejected ${partition.rejected.length} plugin-storage op(s) (client must full-write): ${sample}`);
                    let currentEtag;
                    try {
                        currentEtag = computeBufferEtag(Buffer.from(encodeRisuSaveLegacy(dbCache[filePath])));
                        dbEtag = currentEtag;
                    } catch {}
                    res.status(409).send({
                        error: 'Patch rejected: unsupported op on pluginCustomStorage',
                        code: 'PLUGIN_STORAGE_OPS_REJECTED',
                        currentEtag,
                    });
                    return;
                }
                pluginKvOps = partition.kvOps;
                patch = partition.rest;
            }

            patchStage = 'hash';
            lap();
            const serverHash = decodedKey === 'database/database.bin'
                ? databasePatchHashCache.hash(dbCache[filePath]).toString(16)
                : calculateHash(dbCache[filePath]).toString(16);
            timings.hashMs = lap();

            if (expectedHash !== serverHash) {
                logger.warn(`[Patch] Hash mismatch for ${decodedKey}: expected=${expectedHash}, server=${serverHash}`);
                let currentEtag = undefined;
                // Per-key hashes let the client name the diverged root keys and
                // characters (see RisuSavePatcher.describeHashMismatch). Only
                // computed on this rare path; hashing cost is bounded by one
                // full-document hash.
                let keyHashes = undefined;
                let characterHashes = undefined;
                let duplicateCharIds = undefined;
                if (decodedKey === 'database/database.bin') {
                    // Encode failure must not upgrade this 409 into a 500.
                    try {
                        currentEtag = computeBufferEtag(Buffer.from(encodeRisuSaveLegacy(dbCache[filePath])));
                        dbEtag = currentEtag;
                    } catch {}
                    try {
                        ({ keyHashes, characterHashes, duplicateCharIds } = databaseHashDiagnostics(dbCache[filePath]));
                    } catch {
                        keyHashes = undefined;
                        characterHashes = undefined;
                        duplicateCharIds = undefined;
                    }
                }
                res.status(409).send({
                    error: 'Hash mismatch - data out of sync',
                    code: 'HASH_MISMATCH',
                    currentEtag,
                    serverHash,
                    keyHashes,
                    characterHashes,
                    duplicateCharIds,
                });
                return;
            }

            // Ordering with the plugin kv ops (old clients): the DB patch is
            // cloned/applied/validated FIRST and the kv ops are written only
            // after it succeeded, so a patch whose DB part fails (bad op,
            // non-object root) leaves kv untouched. The kv writes are single
            // rows and not transactional with dbCache; a kv failure after the
            // DB patch landed is the remaining non-atomic window — it is
            // logged + recorded as a persist warning and the client's next
            // full write re-splits.
            const applyPluginKvOps = () => {
                if (pluginKvOps.length === 0) return;
                patchStage = 'plugin-storage';
                try {
                    for (const kvOp of pluginKvOps) {
                        if (kvOp.op === 'remove') pluginStorage.remove(kvOp.key);
                        else pluginStorage.set(kvOp.key, kvOp.value);
                    }
                } catch (kvErr) {
                    logger.error('[Patch] Plugin-storage op failed after the DB patch was applied:', kvErr);
                    recordPersistFailure(kvErr, 'patch:plugin-storage');
                    throw kvErr;
                }
            };

            // Nothing to apply: the client already matches the server. Skip the
            // clone/apply/persist work and hand back the current revision.
            // (Also the case when every op was a plugin-storage op — the DB
            // root is unchanged, so hash cache and etag stay valid.)
            if (Array.isArray(patch) && patch.length === 0) {
                applyPluginKvOps();
                if (pluginKvOps.length > 0 && decodedKey === 'database/database.bin') {
                    dbEtag = computeBufferEtag(Buffer.from(encodeRisuSaveLegacy(dbCache[filePath])));
                }
                const emptyPayload = {
                    success: true,
                    appliedOperations: pluginKvOps.length,
                    etag: decodedKey === 'database/database.bin' ? dbEtag : undefined,
                };
                const emptyWarning = currentPersistWarning();
                if (emptyWarning) emptyPayload.persistWarning = emptyWarning;
                res.send(emptyPayload);
                return;
            }

            // Apply patch to in-memory database (clone first to prevent partial
            // mutation on failure). structuredClone instead of a JSON round-trip:
            // stringifying the whole DB into one JS string hits V8's ~512MB
            // string ceiling on large databases (RangeError: Invalid string
            // length), which rejected every patch. The cache is normalized to
            // plain JSON values at load, so the clone semantics are identical.
            patchStage = 'clone';
            const snapshot = decodedKey === 'database/database.bin'
                ? clonePatchSnapshot(dbCache[filePath], patch)
                : structuredClone(dbCache[filePath]);
            patchStage = 'apply';
            let result;
            try {
                result = applyPatch(snapshot, patch, true);
            } catch (patchErr) {
                // Invalidate corrupted cache entry to force reload on next request
                delete dbCache[filePath];
                throw patchErr;
            }
            // Root-level ops (path "") replace the document instead of mutating
            // the snapshot, so the applied result must be taken from newDocument.
            const next = result.newDocument;
            // A root op may hand back a primitive/null/array; that is never a
            // valid document and must not reach the cache or disk.
            const validRoot = next !== null && typeof next === 'object'
                && (decodedKey !== 'database/database.bin' || !Array.isArray(next));
            if (!validRoot) {
                res.status(400).send({ error: 'Patch must leave the document as an object' });
                return;
            }
            // Lazy asset manifest guard (partner of the chat guard above): an
            // owner that had a descriptor must still have it or an inline
            // array, otherwise hydrate would write it to disk without its
            // assets. 409 so the client rebases; a full write with the same
            // shape is stopped at /api/write.
            if (decodedKey === 'database/database.bin') {
                const manifestLosses = findAssetManifestLossOwners(dbCache[filePath], next);
                if (manifestLosses.length > 0) {
                    const sample = manifestLosses.slice(0, 5).map(l => `${l.kind}:${l.ownerId}`).join(', ');
                    logger.warn(`[Patch] Rejected: ${manifestLosses.length} owner(s) would lose their asset manifest: ${sample}`);
                    let currentEtag;
                    try {
                        currentEtag = computeBufferEtag(Buffer.from(encodeRisuSaveLegacy(dbCache[filePath])));
                        dbEtag = currentEtag;
                    } catch {}
                    res.status(409).send({
                        error: 'Patch rejected: owner would lose its asset manifest without an inline asset list',
                        code: 'ASSET_MANIFEST_GUARD_REJECTED',
                        assetManifestGuardRejected: true,
                        currentEtag,
                    });
                    return;
                }
            }
            // Deactivated-character guard: a chaId lives either in `characters`
            // or in `nodeOnlyArchivedCharacters`, never both; and a character
            // that returns from the archive must have had its chats registered
            // by /activate in this process, otherwise persist would write
            // bodiless `_stub` chats. 409 so the client re-activates/rebases.
            if (decodedKey === 'database/database.bin') {
                const archiveConflict = findArchiveConflicts(dbCache[filePath], next, patch);
                if (archiveConflict) {
                    logger.warn(`[Patch] Rejected: ${archiveConflict}`);
                    let currentEtag;
                    try {
                        currentEtag = computeBufferEtag(Buffer.from(encodeRisuSaveLegacy(dbCache[filePath])));
                        dbEtag = currentEtag;
                    } catch {}
                    res.status(409).send({
                        error: `Patch rejected: ${archiveConflict}`,
                        code: 'ARCHIVE_GUARD_REJECTED',
                        currentEtag,
                    });
                    return;
                }
            }
            if (decodedKey === 'database/database.bin') {
                databasePatchHashCache.update(dbCache[filePath], next, patch);
            }
            dbCache[filePath] = next;
            if (decodedKey === 'database/database.bin') forgetListedChatPosts(next);
            // DB patch is in; now the kv half (see ordering note above).
            applyPluginKvOps();

            // Schedule save to KV (debounced) — merge full chats back for database.bin
            if (saveTimers[filePath]) {
                clearTimeout(saveTimers[filePath]);
            }
            saveTimers[filePath] = setTimeout(async () => {
                let failed = false;
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
                    failed = true;
                } finally {
                    delete saveTimers[filePath];
                }
                if (failed && decodedKey === 'database/database.bin') retryDatabasePersistLater('patch');
            }, SAVE_INTERVAL);

            timings.applyMs = lap();

            // Update ETag after successful patch (based on stripped version)
            patchStage = 'etag';
            if (decodedKey === 'database/database.bin') {
                dbEtag = computeBufferEtag(Buffer.from(encodeRisuSaveLegacy(dbCache[filePath])));
            }
            timings.etagMs = lap();
            timings.totalMs = Math.round(performance.now() - patchStartedAt);
            if (lastDbPersistMs !== null) timings.lastPersistMs = lastDbPersistMs;

            const responsePayload = {
                success: true,
                appliedOperations: result.length + pluginKvOps.length,
                etag: decodedKey === 'database/database.bin' ? dbEtag : undefined,
                timings,
            };
            const persistWarning = currentPersistWarning();
            if (persistWarning) {
                responsePayload.persistWarning = persistWarning;
            }
            res.send(responsePayload);
        });
    } catch (error) {
        const decodedKeyForLog = isHex(filePath) ? Buffer.from(filePath, 'hex').toString('utf-8') : filePath;
        logger.error(
            `[Patch] Error applying patch to ${decodedKeyForLog} (stage=${patchStage}, ops=${Array.isArray(patch) ? patch.length : '?'}): `
            + `${error?.name}: ${error?.message}`,
            error?.stack
        );
        res.status(500).send({
            error: 'Patch application failed: ' + (error && error.message ? error.message : error)
        });
    }
});

// ─── Asset manifest endpoints ─────────────────────────────────────────────────
// Large module/character asset-reference arrays live here instead of in the
// browser's reactive database. Binary assets remain untouched in assets/*.
app.get('/api/asset-manifests/stats', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    try {
        res.json({
            ...assetManifestStore.stats(),
            migration: assetManifestStore.listMigrationState(),
            runtime: dbCache[DB_HEX_KEY] ? assetManifestSummary(dbCache[DB_HEX_KEY]) : null,
        });
    } catch (error) { next(error); }
});

app.get('/api/asset-manifests/owner/:kind/:ownerId', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    try {
        const descriptor = assetManifestStore.getLiveDescriptor(req.params.kind, req.params.ownerId);
        if (!descriptor) return res.status(404).json({ error: 'Asset manifest owner not found' });
        res.json({ ...descriptor, ownerKind: req.params.kind, ownerId: req.params.ownerId });
    } catch (error) { next(error); }
});

app.get('/api/asset-manifests/:manifestId', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    try {
        const page = assetManifestStore.getPage(req.params.manifestId, {
            offset: req.query.offset,
            limit: req.query.limit,
            search: req.query.search,
        });
        if (!page) return res.status(404).set('Cache-Control', 'no-store').json({ error: 'Asset manifest not found' });
        // Manifest ids are content-addressed, so a page for a given id and
        // query never changes: let the browser keep it across reloads. The
        // client's in-memory manifest cache is cold on every page load, and
        // re-downloading every page over a remote link is what made chat
        // entry slow. The page JSON shape is part of the manifest format —
        // bump MANIFEST_FORMAT_VERSION (the client sends it as `v`) when
        // changing it, so stale cached pages are never read by newer code.
        // `private`: the route is auth-gated, so only the browser may keep it.
        res.set('Cache-Control', 'private, max-age=31536000, immutable');
        res.json(page);
    } catch (error) { next(error); }
});

app.post('/api/asset-manifests/resolve', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    try {
        const owners = Array.isArray(req.body?.owners) ? req.body.owners : [];
        const names = Array.isArray(req.body?.names) ? req.body.names : [];
        if (owners.length > 200 || names.length > 1000) {
            return res.status(413).json({ error: 'Too many asset manifest owners or names' });
        }
        const fuzzy = new Set();
        const resolved = assetManifestStore.resolveNames(owners, names, {
            maxDistance: req.body?.maxDistance,
            fuzzyNamesOut: fuzzy,
        });
        res.json({ resolved, fuzzy: [...fuzzy] });
    } catch (error) { next(error); }
});

app.patch('/api/asset-manifests/owner/:kind/:ownerId', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    try {
        const descriptor = await queueStorageOperation(async () => {
            const currentDb = await ensureDatabaseCache();
            // Validate that the owner exists in the canonical cache before the
            // SQLite live pointer advances. This keeps a malformed request from
            // creating a manifest revision the database cannot reference.
            const location = locateAssetManifestOwner(currentDb, req.params.kind, req.params.ownerId);
            if (!location || location.index < 0) {
                const error = new Error(`Asset manifest owner not found: ${req.params.kind}/${req.params.ownerId}`);
                error.code = 'MANIFEST_VALIDATION';
                throw error;
            }
            const nextDescriptor = assetManifestStore.applyOperations(
                req.params.kind,
                req.params.ownerId,
                req.body?.expectedManifestId,
                req.body?.operations,
            );
            const enriched = {
                ...nextDescriptor,
                ownerKind: req.params.kind,
                ownerId: req.params.ownerId,
            };
            const { nextDatabase, collectionKey } = replaceCachedAssetManifestDescriptor(
                currentDb,
                req.params.kind,
                req.params.ownerId,
                enriched,
            );
            databasePatchHashCache.update(currentDb, nextDatabase, [{
                op: 'replace',
                path: `/${collectionKey}`,
                value: nextDatabase[collectionKey],
            }]);
            dbCache[DB_HEX_KEY] = nextDatabase;
            // The client view changed, so a full write carrying the
            // pre-edit etag must conflict instead of reconciling its stale
            // inline asset list over this manifest revision.
            dbEtag = computeBufferEtag(Buffer.from(encodeRisuSaveLegacy(nextDatabase)));
            scheduleDatabasePersist('asset-manifest');
            return enriched;
        });
        res.json({ ...descriptor, ownerKind: req.params.kind, ownerId: req.params.ownerId });
    } catch (error) {
        if (error?.code === 'MANIFEST_CONFLICT') {
            return res.status(409).json({
                error: error.message,
                current: error.current ? {
                    ...error.current,
                    ownerKind: req.params.kind,
                    ownerId: req.params.ownerId,
                } : null,
            });
        }
        if (error?.code === 'MANIFEST_VALIDATION') {
            return res.status(400).json({ error: error.message });
        }
        next(error);
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
        // database.bin goes through /api/write. Written here it would skip
        // every guard and leave dbCache and the chat store describing the
        // old one, which the next flush writes back over it.
        if(entries.some((entry) => entry?.key === DB_BLOB_KEY)){
            res.status(400).send({ error: 'database/database.bin cannot be written through bulk-write' });
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

// ── Settings-only export ────────────────────────────────────────────────────
//
// Multi-instance setups are a common PocketRisu pattern, and re-entering every
// setting by hand on each new instance is the pain this removes. A settings-only
// backup is the full backup minus characters, chats and inlay images: modules,
// plugins, prompt presets, personas, lorebooks, theme and API keys all travel.
//
// Restore stays the ordinary full-replace import — the target is a fresh
// instance, so there is no merge path involved.

/**
 * Trims a decoded database object down to settings only.
 *
 * Chats live inside `characters[].chats`, so dropping characters drops chats
 * with them. `characterOrder` has to go too, or the restored instance keeps
 * folders pointing at character ids that no longer exist.
 */
function stripToSettingsOnly(dbObj) {
    return {
        ...dbObj,
        characters: [],
        characterOrder: [],
        nodeOnlyArchivedCharacters: [],
    };
}

/**
 * Works out what a settings-only export would ship.
 *
 * Shared by the export endpoint and the estimate endpoint so the number shown
 * in the confirm dialog can't drift from the file the user actually gets.
 *
 * Module assets are reported separately because they dominate the size for
 * anyone using asset-pack modules — several GB against a handful of MB for
 * everything else — and that is the one call worth putting to the user.
 * Note the marginal cost is computed as (all − withoutModules), so an asset a
 * module shares with, say, a persona icon is never billed to the module and
 * never dropped when module assets are excluded.
 */
async function buildSettingsOnlyPlan({ includeModuleAssets = true } = {}) {
    const raw = kvGet('database/database.bin');
    if (!raw) return null;

    // Plain decodeRisuSave, not decodeDatabaseWithPersistentChatIds: that
    // variant runs chat-id and cold-storage migrations and can persist. Both
    // concern data we are about to drop anyway.
    const trimmed = stripToSettingsOnly(await decodeRisuSave(raw));
    const dbValue = Buffer.from(encodeRisuSaveLegacy(trimmed, 'compression'));

    const withModules = buildUncleanableSet(trimmed);
    const withoutModules = buildUncleanableSet(trimmed, { includeModuleAssets: false });
    const keepNames = includeModuleAssets ? withModules : withoutModules;

    let baseCount = 0, baseBytes = 0, moduleCount = 0, moduleBytes = 0;
    for (const entry of kvListWithSizes('assets/')) {
        const name = path.basename(entry.key);
        if (withoutModules.has(name)) {
            baseCount++;
            baseBytes += entry.size;
        } else if (withModules.has(name)) {
            moduleCount++;
            moduleBytes += entry.size;
        }
    }

    const modulesWithAssets = (trimmed.modules ?? [])
        .filter((m) => Array.isArray(m?.assets) && m.assets.length > 0).length;

    return {
        trimmed,
        dbValue,
        keepNames,
        breakdown: {
            dbBytes: dbValue.length,
            baseAssets: { count: baseCount, bytes: baseBytes },
            moduleAssets: { count: moduleCount, bytes: moduleBytes, moduleCount: modulesWithAssets },
        },
    };
}

/**
 * database.risudat bytes for a full export: the live blob with
 * pluginCustomStorage re-embedded from plugin-storage/ kv so the .bin decodes
 * to a complete DB in upstream RisuAI and in older NodeOnly builds.
 *
 * The blob is one msgpack document (encodeRisuSaveLegacy), not block-based,
 * so there is no "replace one block" path: this decodes and re-encodes the
 * whole DB and materializes every plugin value. Memory cost is roughly the
 * decoded DB plus plugin storage twice (object + encoded buffer). Skipped
 * entirely when kv holds no plugin keys, which keeps the raw-blob fast path
 * for everyone else. Blob values win over kv on overlap — same rule as the
 * migration, since a still-populated blob means a newer write.
 */
async function buildFullExportDbValue() {
    const raw = kvGet('database/database.bin');
    if (!raw) return null;
    const hasPluginRows = pluginStorage.list().length > 0;
    // Stubs count too: a database that still points at rows which are gone
    // must fail the export below instead of shipping the raw stub list
    // (which importers would silently drop).
    const hasArchive = kvList(ARCHIVE_META_PREFIX).length > 0 || kvList(ARCHIVE_PREFIX).length > 0
        || (dbCache[DB_HEX_KEY] ? archivedStubsOf(dbCache[DB_HEX_KEY]).length > 0 : false);
    if (!hasPluginRows && !hasArchive) return raw;
    const dbObj = await decodeRisuSave(raw);
    if (hasPluginRows) {
        const fromDb = dbObj.pluginCustomStorage;
        const merged = pluginStorage.readAll();
        if (fromDb && typeof fromDb === 'object') {
            for (const key of Object.keys(fromDb)) {
                Object.defineProperty(merged, key, {
                    value: Object.getOwnPropertyDescriptor(fromDb, key).value,
                    enumerable: true, writable: true, configurable: true,
                });
            }
        }
        dbObj.pluginCustomStorage = merged;
    }
    // Deactivated characters travel inline: a .bin must be a complete legacy
    // database for upstream RisuAI and older PocketRisu builds, which know
    // nothing about the archive. Throws when a payload is missing rather than
    // shipping a backup that would import as a lost character.
    await inlineArchivedCharacters(dbObj);
    return Buffer.from(encodeRisuSaveLegacy(dbObj));
}

// Size breakdown for the settings-only confirm dialog. Kept separate from
// /api/db/stats because it has to decode and re-encode the DB, which that
// dashboard poll should not pay for on every load.
app.get('/api/backup/export/settings-estimate', async (req, res, next) => {
    if (!await checkAuth(req, res)) { return; }
    try {
        await flushPendingDb();
        const plan = await buildSettingsOnlyPlan({ includeModuleAssets: true });
        if (!plan) {
            res.status(500).json({ error: 'database.bin missing' });
            return;
        }
        res.json(plan.breakdown);
    } catch (error) {
        next(error);
    }
});

app.get('/api/backup/export', async (req, res, next) => {
    if(!await checkBackupDownloadAuth(req, res)){ return; }
    try {
        // ?target=upstream excludes NodeOnly-only inlay namespaces (inlay/,
        // inlay_sidecar/, inlay_meta/). Their entry names contain a slash,
        // which upstream RisuAI's import treats as a path under assets/ and
        // fails with ENOENT. The export becomes lossy on inlay images but
        // imports cleanly into upstream.
        const target = req.query.target === 'upstream' ? 'upstream' : 'nodeonly';
        // ?mode=settings drops characters, chats and inlay images — see
        // buildSettingsOnlyPlan above. &moduleAssets=0 additionally leaves out
        // asset-pack module images, which is where the bulk usually lives.
        const settingsOnly = req.query.mode === 'settings';
        const includeModuleAssets = req.query.moduleAssets !== '0';
        // Flush any pending patches to ensure export includes latest data
        await flushPendingDb();

        // Settings-only re-encodes a trimmed DB up front: its byte length is
        // needed for content-length, and the trimmed object drives the asset
        // filter below. Safe to hold in memory — with characters gone this is
        // orders of magnitude smaller than the live blob.
        let settingsDbValue = null;
        let settingsAssetNames = null;
        if (settingsOnly) {
            const plan = await buildSettingsOnlyPlan({ includeModuleAssets });
            if (!plan) {
                res.status(500).json({ error: 'database.bin missing' });
                return;
            }
            settingsDbValue = plan.dbValue;
            settingsAssetNames = plan.keepNames;
        }
        // Full export ships plugin storage inside database.risudat (see
        // buildFullExportDbValue) — never as plugin-storage/ kv entries, which
        // would duplicate it. Settings-only keeps the trimmed blob's empty
        // field: plugin data is chat-scoped and does not travel with settings.
        const exportDbValue = settingsOnly ? settingsDbValue : await buildFullExportDbValue();

        // Inlay images only ever attach to chat messages, so a settings-only
        // export skips those namespaces for the same reason upstream does.
        const skipInlay = settingsOnly || target === 'upstream';
        const inlayFiles = skipInlay ? [] : await listInlayFiles();
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
        const inlayMetaEntries = skipInlay ? [] : kvListWithSizes('inlay_meta/').map((entry) => ({
            kind: 'kv',
            key: entry.key,
            backupName: entry.key,
            sortKey: entry.key,
            size: entry.size,
        }));
        const namespacedEntries = [
            ...kvListWithSizes('assets/')
                // Settings-only keeps just the assets the trimmed DB still
                // points at — persona icons, theme background, notification
                // sounds, module assets. Character art falls out here, which is
                // what actually shrinks the file.
                .filter((entry) => !settingsAssetNames || settingsAssetNames.has(path.basename(entry.key)))
                .map((entry) => ({
                    kind: 'kv',
                    key: entry.key,
                    backupName: path.basename(entry.key),
                    sortKey: entry.key,
                    size: entry.size,
                })),
            // Cold storage holds character payloads only — nothing left to carry
            // once characters are stripped.
            ...(settingsOnly ? [] : listColdStorageBackupEntries()),
            ...inlayMetaEntries,
            ...inlayEntries,
            ...sidecarEntries.filter(Boolean),
        ].sort((a, b) => a.sortKey.localeCompare(b.sortKey));
        const dbSize = exportDbValue ? exportDbValue.length : 0;
        const totalBytes = namespacedEntries.reduce((sum, entry) => {
            return sum + 8 + Buffer.byteLength(entry.backupName, 'utf-8') + entry.size;
        }, 0) + (dbSize ? 8 + Buffer.byteLength('database.risudat', 'utf-8') + dbSize : 0);

        // Settings-only files get their own name — they are kept around and
        // reused across instances, so they have to be tellable apart from a full
        // backup months later.
        const filenameBase = settingsOnly ? 'risu-settings' : 'risu-backup';
        const filenameSuffix = settingsOnly ? '' : target === 'upstream' ? '-upstream' : '';
        res.setHeader('content-type', 'application/octet-stream');
        res.setHeader('content-disposition', `attachment; filename="${filenameBase}-${Date.now()}${filenameSuffix}.bin"`);
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
            const dbValue = exportDbValue;
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
    if (!checkActiveSession(req, res, { replacesData: true })) return;

    if (importInProgress) {
        res.status(409).json({ error: 'Another import is already in progress' });
        return;
    }
    importInProgress = true;

    // Disable timeouts for large backup uploads. Keep the server reference:
    // when the upload is cut off (client abort, rejection mid-stream) the
    // finally block runs after req.socket was detached, and reading
    // req.socket.server there threw and took the whole process down.
    const httpServer = req.socket.server;
    const prevRequestTimeout = httpServer?.requestTimeout;
    req.socket.setTimeout(0);
    req.socket.setKeepAlive(true);
    if (httpServer) httpServer.requestTimeout = 0;

    // NDJSON streaming keeps the response socket alive during long
    // post-upload work (WAL checkpoint, cold-storage migration). Without it
    // a reverse proxy in front of the server can hit its response timeout
    // and bounce the request back to the client as 502 Bad Gateway.
    const wantsNdjson = String(req.headers['accept'] ?? '').includes('application/x-ndjson');
    let heartbeatTimer = null;
    const stall = watchUploadStall(req);

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
                    stall.received();
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
                pluginStorageColdFailed: result.pluginStorageColdFailed,
            }) + '\n');
            res.end();
        } else {
            const result = await importBackupFromSource(req, { maxBytes: BACKUP_IMPORT_MAX_BYTES, onProgress: stall.received });
            res.json({
                ok: true,
                assetsRestored: result.assetsRestored,
                coldStorageFailed: result.coldStorageFailed,
                pluginStorageColdFailed: result.pluginStorageColdFailed,
            });
        }
    } catch (error) {
        if (wantsNdjson && res.headersSent) {
            try {
                res.write(JSON.stringify({ type: 'error', message: error?.message || 'backup import failed', code: error?.code }) + '\n');
                res.end();
            } catch (_) {}
        } else {
            next(error);
        }
    } finally {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        stall.stop();
        importInProgress = false;
        if (httpServer && prevRequestTimeout !== undefined) {
            httpServer.requestTimeout = prevRequestTimeout;
        }
    }
});

// ── RisuAI account import ───────────────────────────────────────────────────
// Downloads a risuai.xyz account (database, assets, cold storage) to a staging
// folder, then applies it through importBackupFromSource. Logic lives in
// risu-account-import.cjs; while an import is started, checkActiveSession
// refuses every data write. POCKETRISU_RISU_ACCOUNT_URL points tests at a fake
// account server and POCKETRISU_RISU_ACCOUNT_GAP_MS shortens the pause between
// account requests there.
const { createRisuAccountImport, AccountImportError } = require('./risu-account-import.cjs');
const accountRequestGapMs = Number(process.env.POCKETRISU_RISU_ACCOUNT_GAP_MS);
const risuAccountImport = createRisuAccountImport({
    baseUrl: process.env.POCKETRISU_RISU_ACCOUNT_URL || undefined,
    requestGapMs: process.env.POCKETRISU_RISU_ACCOUNT_GAP_MS && Number.isFinite(accountRequestGapMs) && accountRequestGapMs >= 0 ? accountRequestGapMs : undefined,
    stagingDir: path.join(savePath, 'account_import_staging'),
    logger,
    decodeRisuSave,
    encodeRisuSaveLegacy,
    checkDiskSpace,
    applyEntries: applyRisuAccountEntries,
});

async function applyRisuAccountEntries(entries, { totalBytes, onProgress }) {
    if (importInProgress) {
        throw new AccountImportError('Another import is already in progress', 'ACCOUNT_IMPORT_BUSY', 409);
    }
    importInProgress = true;
    try {
        // Writes accepted before the import started may still wait in the
        // storage queue; they run before the swap, not after it. New ones are
        // refused while the import blocks.
        await queueStorageOperation(async () => {});
        const disk = await checkDiskSpace(totalBytes * BACKUP_DISK_HEADROOM);
        if (!disk.ok) {
            throw new AccountImportError('Not enough free disk space to apply the import', 'ACCOUNT_DISK_FULL', 507);
        }
        try {
            return await importBackupFromSource(entries, { totalBytes, onProgress });
        } finally {
            // Every page loaded before the swap holds the old data in memory.
            // Also after a failure, which may come after the new data was
            // committed (inlay folder swap).
            sessionLock.revokeAll();
        }
    } finally {
        importInProgress = false;
    }
}

function sendAccountImportError(res, error, next) {
    if (error?.code && typeof error.status === 'number') {
        res.status(error.status).json({ error: error.message, code: error.code });
        return;
    }
    next(error);
}

app.get('/api/risu-account/config', async (req, res) => {
    if (!await checkAuth(req, res)) { return; }
    res.json(risuAccountImport.config());
});

app.get('/api/risu-account/status', async (req, res, next) => {
    if (!await checkAuth(req, res)) { return; }
    try {
        res.json(await risuAccountImport.status());
    } catch (error) {
        next(error);
    }
});

app.post('/api/risu-account/prepare', async (req, res, next) => {
    if (!await checkAuth(req, res)) { return; }
    if (!checkActiveSession(req, res, { allowDuringAccountImport: true })) return;
    try {
        // Reads the account database in the background; the client polls
        // status for the summary (or the error).
        risuAccountImport.prepare({ token: req.body?.token, id: req.body?.id });
        res.json({ ok: true });
    } catch (error) {
        sendAccountImportError(res, error, next);
    }
});

// The first call starts the import: from then on PocketRisu is blocked until
// it is applied or cancelled.
app.post('/api/risu-account/download', async (req, res, next) => {
    if (!await checkAuth(req, res)) { return; }
    if (!checkActiveSession(req, res, { allowDuringAccountImport: true })) return;
    try {
        res.json(risuAccountImport.startDownload());
    } catch (error) {
        sendAccountImportError(res, error, next);
    }
});

app.post('/api/risu-account/cancel', async (req, res, next) => {
    if (!await checkAuth(req, res)) { return; }
    if (!checkActiveSession(req, res, { allowDuringAccountImport: true })) return;
    try {
        await risuAccountImport.cancel();
        res.json({ ok: true });
    } catch (error) {
        sendAccountImportError(res, error, next);
    }
});

// Applies a download with missing items once the user accepts them (one
// without missing items applies by itself). Runs in the background.
app.post('/api/risu-account/apply', async (req, res, next) => {
    if (!await checkAuth(req, res)) { return; }
    if (!checkActiveSession(req, res, { allowDuringAccountImport: true })) return;
    try {
        res.json(risuAccountImport.startApply());
    } catch (error) {
        sendAccountImportError(res, error, next);
    }
});

// ── Server-side backup endpoints ────────────────────────────────────────────

// Save current data as a .bin backup file on the server
app.post('/api/backup/server/save', async (req, res, next) => {
    if (!await checkAuth(req, res)) { return; }
    if (!checkActiveSession(req, res, { changesData: false })) return;
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
                    // Same reassembly as /api/backup/export — plugin storage
                    // rides inside database.risudat, not as kv entries.
                    const dbValue = await buildFullExportDbValue();
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
            res.write(JSON.stringify({ type: 'done', ok: true, filename, size: stat.size, dir: backupsDir }) + '\n');
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
    if (!checkActiveSession(req, res, { replacesData: true })) return;

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
            pluginStorageColdFailed: result.pluginStorageColdFailed,
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
    if (!await checkBackupDownloadAuth(req, res)) { return; }
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

// Upstream keeps v3 pluginStorage values in cold storage: cad8595a leaves a
// key -> cold id map in pluginCustomStorage._coldplugin, and 68b5d032c
// (v2026.10.210+) a _coldpluginIndex pointer to one index item. Fold both back
// into plain keys so pluginStorage.migrateFromDb moves them into kv (see
// upstream-plugin-storage.cjs). Cold storage KV entries are never deleted.
// What cannot be restored is recorded in nodeOnlyPluginStorageRecovery,
// outside the plugin key space, so a reserved key never reaches a plugin or
// an export to upstream, where it would be read as a live pointer.
const PLUGIN_STORAGE_RECOVERY_KEY = 'nodeOnlyPluginStorageRecovery';

function readColdPluginItem(coldId) {
    try {
        const entry = readColdStorageJsonEntry(coldId, { migrateLegacy: true });
        return entry ? entry.coldData : undefined;
    } catch (err) {
        logger.error(`[ColdStorage] plugin storage item ${coldId} could not be read:`, err.message);
        throw err;
    }
}

function appendPluginStorageRecovery(dbObj, record) {
    const existing = Array.isArray(dbObj[PLUGIN_STORAGE_RECOVERY_KEY]) ? dbObj[PLUGIN_STORAGE_RECOVERY_KEY] : [];
    dbObj[PLUGIN_STORAGE_RECOVERY_KEY] = [...existing, record];
}

function logPluginStorageRestore(action, result) {
    if (result.restored > 0) {
        logger.info(`[ColdStorage] ${action} ${result.restored} plugin storage key(s) from cold storage`);
    }
    if (result.failed > 0) {
        logger.error(`[ColdStorage] ${result.failed} plugin storage item(s) could not be restored; details are kept in ${PLUGIN_STORAGE_RECOVERY_KEY}. Cold storage KV data is preserved.`);
    }
}

function restoreColdPluginStorageInDb(dbObj) {
    const storage = dbObj?.pluginCustomStorage;
    if (!upstreamPluginStorage.hasReservedKeys(storage)) return null;
    const resolved = upstreamPluginStorage.resolveUpstreamPluginStorage(storage, {
        readCold: readColdPluginItem,
        isPresent: (key) => Object.prototype.hasOwnProperty.call(storage, key),
        source: 'database',
    });
    for (const key of upstreamPluginStorage.RESERVED_KEYS) delete storage[key];
    for (const [key, value] of resolved.assign) {
        // defineProperty keeps a "__proto__" key an own property.
        Object.defineProperty(storage, key, { value, enumerable: true, writable: true, configurable: true });
    }
    if (resolved.record) appendPluginStorageRecovery(dbObj, resolved.record);
    return resolved;
}

// Builds that did not know the index layout moved upstream's reserved keys
// into kv as ordinary plugin keys (the pointer string, and _coldplugin
// breadcrumbs). Resolve them the same way, once: the values already in kv are
// live and win over the cold copies.
function recoverLeakedPluginStorageKeys(dbObj) {
    const leaked = {};
    for (const key of upstreamPluginStorage.RESERVED_KEYS) {
        let value = null;
        try {
            value = pluginStorage.get(key);
        } catch (err) {
            logger.error(`[PluginStorage] Reserved key "${key}" in kv could not be read:`, err.message);
        }
        if (value !== null && value !== undefined) leaked[key] = value;
    }
    if (Object.keys(leaked).length === 0) return null;

    createBackupAndRotate({ force: true });
    const present = new Set(pluginStorage.list().map((entry) => entry.key));
    const resolved = upstreamPluginStorage.resolveUpstreamPluginStorage(leaked, {
        readCold: readColdPluginItem,
        isPresent: (key) => present.has(key),
        source: 'leaked-kv',
    });
    sqliteDb.transaction(() => {
        for (const [key, value] of resolved.assign) pluginStorage.set(key, value);
        for (const key of Object.keys(leaked)) pluginStorage.remove(key);
    })();
    if (resolved.record) appendPluginStorageRecovery(dbObj, resolved.record);
    return resolved;
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
// ── Chat delta sync ─────────────────────────────────────────────────────────
// The client may say "I already hold the first N messages, whose prefix
// fingerprint is F" (x-chat-base-count / x-chat-base-fp). When the stored
// chat's first N messages fingerprint to the same F, only the rest crosses
// the wire: a GET returns the chat with message = messages[N:] (response
// header x-chat-delta-base: N), a POST body carries only messages[N:] and is
// spliced onto the stored prefix. Anything that does not verify falls back
// to a full transfer (GET) or a 409 the client answers with a full save
// (POST) — the delta path never guesses. See chatFingerprint.cjs.
function readChatDeltaBase(req) {
    const countHeader = req.headers['x-chat-base-count'];
    const fp = req.headers['x-chat-base-fp'];
    if (typeof countHeader !== 'string' || typeof fp !== 'string' || !fp) return null;
    const count = Number(countHeader);
    if (!Number.isInteger(count) || count < 1) return null;
    return { count, fp };
}

function chatPrefixMatches(chat, base) {
    const messages = Array.isArray(chat?.message) ? chat.message : null;
    if (!messages || base.count > messages.length) return false;
    return prefixFingerprint(messageFingerprints(messages.slice(0, base.count)), base.count) === base.fp;
}

function sendChatContent(req, res, chat) {
    // The body depends on the base headers, so a cached response must never
    // be reused for a request with different ones.
    res.setHeader('Vary', 'x-chat-base-count, x-chat-base-fp');
    res.setHeader('Content-Type', 'application/octet-stream');
    const base = readChatDeltaBase(req);
    if (base && chatPrefixMatches(chat, base)) {
        res.setHeader('x-chat-delta-base', String(base.count));
        return res.send(Buffer.from(encodeRisuSaveLegacy({ ...chat, message: chat.message.slice(base.count) })));
    }
    return res.send(Buffer.from(encodeRisuSaveLegacy(chat)));
}

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
                return sendChatContent(req, res, chat);
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
        sendChatContent(req, res, chat);
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

            // Delta save: the body holds only the messages after a prefix the
            // client says the server already has. Splice it onto the stored
            // chat only when that prefix verifies; otherwise ask for a full
            // save (the client retries with the whole chat — never an error
            // the user sees, never a partial write).
            const deltaBase = readChatDeltaBase(req);
            if (deltaBase) {
                const stored = fullChatStore.get(chaId)?.get(expectedChatId);
                if (!stored || !restoreColdStorageChat(stored) || !Array.isArray(chatData.message) || !chatPrefixMatches(stored, deltaBase)) {
                    return res.status(409).json({ error: 'Chat delta base does not match', code: 'CHAT_DELTA_BASE_MISMATCH' });
                }
                chatData.message = stored.message.slice(0, deltaBase.count).concat(chatData.message);
            }

            // Update fullChatStore
            if (!fullChatStore.has(chaId)) {
                fullChatStore.set(chaId, new Map());
            }
            fullChatStore.get(chaId).set(expectedChatId, chatData);
            recordChatPost(chaId, expectedChatId);

            // Schedule debounced persist (reuses existing timer mechanism)
            if (saveTimers[DB_HEX_KEY]) {
                clearTimeout(saveTimers[DB_HEX_KEY]);
            }
            saveTimers[DB_HEX_KEY] = setTimeout(async () => {
                let failed = false;
                const cold = !dbCache[DB_HEX_KEY];
                try {
                    // If dbCache has stripped DB, persist with merged chats
                    if (dbCache[DB_HEX_KEY]) {
                        await persistDbCacheWithChats(DB_HEX_KEY, 'database/database.bin');
                    } else {
                        // No stripped cache — load, merge, save
                        const raw = kvGet('database/database.bin');
                        if (raw) {
                            const dbObj = normalizeJSON(await decodeRisuSave(raw));
                            const fullDb = hydrateDatabaseForDisk(stripDatabaseForClient(dbObj, { reconcileManifests: true }));
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
                    failed = true;
                } finally {
                    delete saveTimers[DB_HEX_KEY];
                }
                if (failed && cold) retryColdPersistLater('chat-content');
                else if (failed) retryDatabasePersistLater('chat-content');
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
    // Cold-storage rows belong to the previous user's chats. The .bin import path
    // (importBackupFromSource) already clears these; the save-folder path did not,
    // leaving orphans that no dashboard or Optimize pass ever reclaims.
    kvDelPrefix('coldstorage/');
    // archive/ and archive-meta/ rows are deliberately NOT wiped: the imported
    // database is inlined and references none of them, and the pre-import
    // snapshot may still. They become orphan rows for the dashboard purge.
    // Plugin storage is a full replace too: the incoming save folder either
    // carries its own plugin-storage/ rows (INSERT OR REPLACE lands them
    // after this delete, inside the same transaction) or has the data inside
    // its database.bin, which the next cold decode re-splits. Runs inside the
    // importer's transaction, so a failed import rolls this back with the DB.
    kvDelPrefix(pluginStorage.PREFIX);
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
    if (!checkActiveSession(req, res, { replacesData: true })) return;
    if (importInProgress) {
        res.status(409).json({ error: 'Another import is already in progress' });
        return;
    }
    importInProgress = true;

    req.socket.setTimeout(0);
    req.socket.setKeepAlive(true);
    // Same as /api/backup/import: req.socket can be detached by the finally block.
    const httpServer = req.socket.server;
    const prevRequestTimeout = httpServer?.requestTimeout;
    if (httpServer) httpServer.requestTimeout = 0;
    const stall = watchUploadStall(req);

    try {
        const chunks = [];
        let totalSize = 0;
        for await (const chunk of req) {
            stall.received();
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
        stall.stop();
        importInProgress = false;
        if (httpServer && prevRequestTimeout !== undefined) {
            httpServer.requestTimeout = prevRequestTimeout;
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

// ── Character archive (user-facing: deactivate / activate) ─────────────────
// A deactivated character leaves `characters` for the small stub list
// `nodeOnlyArchivedCharacters`. Its full body — chats inline, asset arrays
// inline (manifest hydrated) — lives in kv `archive/<chaId>/<archivedAt>`
// (chunk-routed, see db.cjs) with a sidecar index
// `archive-meta/<chaId>/<archivedAt>` holding the asset references for the
// orphan sweep and sizes for the dashboard.
//
// Invariants:
// - Pointers never leave the server: every .bin export re-inlines archived
//   characters (inlineArchivedCharacters), so upstream RisuAI and older
//   PocketRisu builds only ever see a complete legacy database.
// - Rows are immutable and never deleted automatically. Each deactivation
//   writes a new `<archivedAt>` row and the stub names its own row, so a
//   restored database.bin snapshot resolves to the exact body it was taken
//   with — never to a newer deactivation, never to nothing. Rows no longer
//   referenced by the live database are "orphan" and reclaimed only by the
//   dashboard's explicit purge (same policy as assets/*). Backup import does
//   not touch them either: the imported database is inlined and references
//   no rows, and the pre-import snapshot may still.
// - The endpoints below only write/read rows. Moving the character between
//   `characters` and the stub list is done by the client through the normal
//   /api/patch path, so dbCache, hashes and etag stay in one flow.
const ARCHIVE_PREFIX = 'archive/';
const ARCHIVE_META_PREFIX = 'archive-meta/';
const ARCHIVE_FORMAT_VERSION = 1;

function isArchivableChaId(chaId) {
    return typeof chaId === 'string' && chaId.length > 0 && chaId.length <= 256
        && !chaId.includes('/') && chaId !== '§temp' && chaId !== '§playground';
}
function isValidArchivedAt(v) {
    return Number.isInteger(v) && v > 0;
}
function archiveRowId(chaId, archivedAt) { return `${chaId}/${archivedAt}`; }
function archiveKey(chaId, archivedAt) { return ARCHIVE_PREFIX + archiveRowId(chaId, archivedAt); }
function archiveMetaKey(chaId, archivedAt) { return ARCHIVE_META_PREFIX + archiveRowId(chaId, archivedAt); }

// `<prefix><chaId>/<archivedAt>` → { chaId, archivedAt } or null.
function parseArchiveRowKey(key, prefix) {
    if (typeof key !== 'string' || !key.startsWith(prefix)) return null;
    const rowId = key.slice(prefix.length);
    const slash = rowId.lastIndexOf('/');
    if (slash <= 0) return null;
    const chaId = rowId.slice(0, slash);
    const archivedAt = Number(rowId.slice(slash + 1));
    if (!isArchivableChaId(chaId) || !isValidArchivedAt(archivedAt)) return null;
    return { chaId, archivedAt, rowId };
}

function archivedStubsOf(dbObj) {
    const list = dbObj?.nodeOnlyArchivedCharacters;
    return Array.isArray(list)
        ? list.filter((s) => s && typeof s.chaId === 'string' && isValidArchivedAt(s.archivedAt))
        : [];
}

function hasArchivePayload(chaId, archivedAt) {
    return (kvSize(archiveKey(chaId, archivedAt)) || 0) > 0;
}
function listArchivePayloadKeysFor(chaId) {
    return kvList(ARCHIVE_PREFIX + chaId + '/');
}
function hasAnyArchivePayload(chaId) {
    return listArchivePayloadKeysFor(chaId).length > 0;
}

// Parsed archive-meta row, or null when absent. Throws on a malformed row.
function readArchiveMeta(chaId, archivedAt) {
    const raw = kvGet(archiveMetaKey(chaId, archivedAt));
    if (!raw) return null;
    const meta = JSON.parse(Buffer.from(raw).toString('utf-8'));
    if (!meta || typeof meta !== 'object' || meta.chaId !== chaId || meta.archivedAt !== archivedAt || !Array.isArray(meta.assetRefs)) {
        throw new Error(`archive index malformed: ${archiveRowId(chaId, archivedAt)}`);
    }
    return meta;
}

function listArchiveMetas() {
    const out = [];
    for (const key of kvList(ARCHIVE_META_PREFIX)) {
        const parsed = parseArchiveRowKey(key, ARCHIVE_META_PREFIX);
        if (!parsed) throw new Error(`archive index key malformed: ${key}`);
        const meta = readArchiveMeta(parsed.chaId, parsed.archivedAt);
        if (meta) out.push(meta);
    }
    return out;
}

// Decoded payload row, or null when absent. Throws when the row exists but is
// not a payload for this character/version.
async function decodeArchivePayload(chaId, archivedAt) {
    const raw = kvGet(archiveKey(chaId, archivedAt));
    if (!raw) return null;
    const payload = normalizeJSON(await decodeRisuSave(raw));
    const character = payload?.character;
    if (!character || typeof character !== 'object' || character.chaId !== chaId
        || payload.archivedAt !== archivedAt || !Array.isArray(character.chats)) {
        throw new Error(`archive payload malformed: ${archiveRowId(chaId, archivedAt)}`);
    }
    return { payload, bytes: raw.length };
}

function buildArchivedCharacterStub(character, { archivedAt, bytes }) {
    const chats = Array.isArray(character.chats) ? character.chats : [];
    const stub = {
        chaId: character.chaId,
        name: typeof character.name === 'string' ? character.name : '',
        image: typeof character.image === 'string' ? character.image : '',
        tags: Array.isArray(character.tags) ? character.tags.filter((t) => typeof t === 'string') : [],
        lastInteraction: typeof character.lastInteraction === 'number' ? character.lastInteraction : 0,
        archivedAt,
        bytes,
        chatCount: chats.length,
        chatIds: chats.map((c) => c?.id).filter((id) => typeof id === 'string'),
    };
    if (typeof character.nickname === 'string') stub.nickname = character.nickname;
    if (typeof character.creation_date === 'number') stub.creation_date = character.creation_date;
    return stub;
}

function referencedArchiveRowIds(dbObj) {
    return new Set(archivedStubsOf(dbObj).map((s) => archiveRowId(s.chaId, s.archivedAt)));
}

// Asset references of every archive row, added to `uncleanable`. Mirrors
// addLiveManifestRefs: an unreadable index row throws, and a stub the
// database still points at whose payload or index is gone throws too — a
// partial view must never turn into a purge. Orphan rows (no stub) still
// count: they are kept until explicitly purged, so their assets are kept.
function addArchivedCharacterRefs(uncleanable, dbObj) {
    const referenced = referencedArchiveRowIds(dbObj);
    const indexed = new Set();
    for (const meta of listArchiveMetas()) {
        const rowId = archiveRowId(meta.chaId, meta.archivedAt);
        indexed.add(rowId);
        if (referenced.has(rowId) && !hasArchivePayload(meta.chaId, meta.archivedAt)) {
            throw new Error(`deactivated character payload missing: ${meta.name || rowId}`);
        }
        for (const ref of meta.assetRefs) {
            const bn = statsBasename(ref);
            if (bn) uncleanable.add(bn);
        }
    }
    for (const rowId of referenced) {
        if (!indexed.has(rowId)) throw new Error(`deactivated character index missing: ${rowId}`);
    }
}

// Archive rows the live database no longer points at (re-activated, deleted,
// or replaced by a backup import). Sizes are logical (chunk-aware).
// A row just written is referenced by no stub until the client's save lands
// (a bulk run keeps rows in that state for a whole chunk). Rows this young are
// never orphans, so a purge in that window cannot delete them.
const ARCHIVE_ORPHAN_GRACE_MS = process.env.POCKETRISU_ARCHIVE_ORPHAN_GRACE_MS
    ? Number(process.env.POCKETRISU_ARCHIVE_ORPHAN_GRACE_MS)
    : 10 * 60 * 1000; // override for tests that purge rows they just wrote

function listOrphanArchiveRows(dbObj) {
    const referenced = referencedArchiveRowIds(dbObj);
    const payloads = [];
    const metas = [];
    let bytes = 0;
    const youngestOrphan = Date.now() - ARCHIVE_ORPHAN_GRACE_MS;
    for (const key of kvList(ARCHIVE_PREFIX)) {
        const parsed = parseArchiveRowKey(key, ARCHIVE_PREFIX);
        if (parsed && (referenced.has(parsed.rowId) || parsed.archivedAt > youngestOrphan)) continue;
        const size = kvSize(key) || 0;
        payloads.push({ key, size });
        bytes += size;
    }
    for (const key of kvList(ARCHIVE_META_PREFIX)) {
        const parsed = parseArchiveRowKey(key, ARCHIVE_META_PREFIX);
        if (parsed && (referenced.has(parsed.rowId) || parsed.archivedAt > youngestOrphan)) continue;
        metas.push(key);
    }
    return { payloads, metas, bytes };
}

function purgeOrphanArchiveRows(dbObj) {
    const orphan = listOrphanArchiveRows(dbObj);
    sqliteDb.transaction(() => {
        // kvDel routes through the chunk store so chunked payloads drop their
        // manifests too; the index rows are plain kv.
        for (const it of orphan.payloads) kvDel(it.key);
        for (const key of orphan.metas) kvDel(key);
    })();
    return { deleted: orphan.payloads.length, metas: orphan.metas.length, bytes: orphan.bytes };
}

// A chat the server holds no body for: a `_stub` with nothing in fullChatStore.
// Bodies are never re-hydrated once lost, so this state is permanent.
function isBodilessChat(chat) {
    return !!chat && (chat._stub === true || !Array.isArray(chat.message));
}

// What a bodiless chat already shows the user: its metadata over no messages.
function emptyChatFrom(chat) {
    const { _stub, ...meta } = chat;
    return { note: '', localLore: [], ...meta, message: [] };
}

// Full legacy-shaped character for one dbCache entry: chats merged from
// fullChatStore, asset arrays hydrated from the manifest store. A bodiless chat
// has nothing to archive; it is refused (its name reported) unless the caller
// accepts storing it as the empty chat it already is.
async function hydrateCharacterForArchive(character, { acceptLostChats = false } = {}) {
    await ensureChatStore();
    let full = hydrateDatabaseForDisk({ characters: [character] }).characters[0];
    // A character reactivated earlier may still have its bodies only in its
    // archive rows.
    if (full.chats?.some((c) => c && c._stub === true)) {
        full = (await restoreUnmergedArchivedChats({ characters: [full] })).db.characters[0];
    }
    const chats = Array.isArray(full.chats) ? full.chats : [];
    const lost = chats.filter(isBodilessChat);
    if (lost.length > 0 && !acceptLostChats) {
        const err = new Error(`${lost.length} chat(s) of "${character.name}" have no body on the server`);
        err.code = 'ARCHIVE_CHATS_UNAVAILABLE';
        err.chats = lost.map((c) => (typeof c.name === 'string' ? c.name : ''));
        throw err;
    }
    return normalizeJSON(lost.length > 0
        ? { ...full, chats: chats.map((c) => (isBodilessChat(c) ? emptyChatFrom(c) : c)) }
        : full);
}

// Re-inline deactivated characters into a decoded database (export path).
// Mutates and returns dbObj. Throws when any referenced row is missing.
async function inlineArchivedCharacters(dbObj) {
    const stubs = archivedStubsOf(dbObj);
    if (stubs.length > 0) {
        if (!Array.isArray(dbObj.characters)) dbObj.characters = [];
        const present = new Set(dbObj.characters.map((c) => c?.chaId).filter(Boolean));
        const missing = [];
        for (const stub of stubs) {
            if (present.has(stub.chaId)) continue;
            let decoded = null;
            try { decoded = await decodeArchivePayload(stub.chaId, stub.archivedAt); } catch { decoded = null; }
            if (!decoded) {
                missing.push(stub.name || stub.chaId);
                continue;
            }
            const inlined = decoded.payload.character;
            // A trashed stub travels as upstream's trash marker so any importer
            // (upstream RisuAI, older PocketRisu) files it under its own trash.
            if (isValidArchivedAt(stub.trashedAt)) inlined.trashTime = stub.trashedAt;
            else delete inlined.trashTime;
            dbObj.characters.push(inlined);
            present.add(stub.chaId);
        }
        if (missing.length > 0) {
            const err = new Error(`Deactivated character data missing: ${missing.join(', ')}`);
            err.code = 'ARCHIVE_PAYLOAD_MISSING';
            throw err;
        }
    }
    if ('nodeOnlyArchivedCharacters' in dbObj) delete dbObj.nodeOnlyArchivedCharacters;
    return dbObj;
}

function patchTouchesCharacterLists(patch) {
    if (!Array.isArray(patch)) return true;
    return patch.some((op) => typeof op?.path === 'string'
        && (op.path === '' || op.path.startsWith('/characters') || op.path.startsWith('/nodeOnlyArchivedCharacters')));
}

// Returns a human-readable conflict, or null. `prev` may be undefined (cold
// write). `patch` null means "assume the lists were touched".
function findArchiveConflicts(prev, next, patch) {
    if (!next || typeof next !== 'object') return null;
    if (!patchTouchesCharacterLists(patch)) return null;
    const archived = new Set(archivedStubsOf(next).map((s) => s.chaId));
    const nextChars = Array.isArray(next.characters) ? next.characters : [];
    if (archived.size > 0) {
        for (const c of nextChars) {
            if (c?.chaId && archived.has(c.chaId)) return `character ${c.chaId} is both active and deactivated`;
        }
    }
    const prevIds = new Set((Array.isArray(prev?.characters) ? prev.characters : []).map((c) => c?.chaId).filter(Boolean));
    for (const c of nextChars) {
        if (!c?.chaId || prevIds.has(c.chaId)) continue;
        if (!hasAnyArchivePayload(c.chaId)) continue;
        const hasStubChat = Array.isArray(c.chats) && c.chats.some((ch) => ch && ch._stub === true);
        if (hasStubChat && !(fullChatStore && fullChatStore.has(c.chaId))) {
            return `character ${c.chaId} returned from the archive without activation`;
        }
    }
    return null;
}

// Characters in a reassembled (disk-shaped) database that still carry `_stub`
// chats AND have an archive row — the activation-without-chats case.
function findUnmergedArchivedChats(fullDb) {
    const out = [];
    for (const c of Array.isArray(fullDb?.characters) ? fullDb.characters : []) {
        if (!c?.chaId || !Array.isArray(c.chats)) continue;
        if (!c.chats.some((ch) => ch && ch._stub === true)) continue;
        if (hasAnyArchivePayload(c.chaId)) out.push(c.chaId);
    }
    return out;
}

// Fill the bodiless `_stub` chats of live characters that have archive rows
// from those rows, matched by chat id, newest row first. Such a character
// came back from the archive without its chats registered in this process
// (a restart in between, a store rebuild, or a full write from a client).
// Only chats the server holds no body for are filled, so nothing newer can be
// overwritten. A chat no row holds has no body anywhere and stays a stub —
// refusing to persist over it would block every save of the whole database
// and recover nothing. Throws when a row cannot be read (fail closed).
// Returns a new database object; `fullDb`'s branches are never mutated.
async function restoreUnmergedArchivedChats(fullDb) {
    // Only a stub with no message array lacks its body. A legacy hybrid
    // (`_stub: true` and a real message array) carries the body itself and
    // may be newer than any row; initChatStore just drops its flag.
    const lacksBody = (ch) => !!ch && ch._stub === true && !Array.isArray(ch.message);
    const result = { db: fullDb, restored: [], unresolved: [] };
    const characters = Array.isArray(fullDb?.characters) ? fullDb.characters : null;
    if (!characters) return result;
    let nextCharacters = null;
    for (let i = 0; i < characters.length; i++) {
        const c = characters[i];
        if (!c?.chaId || !Array.isArray(c.chats) || !c.chats.some(lacksBody)) continue;
        const rows = listArchivePayloadKeysFor(c.chaId)
            .map((key) => parseArchiveRowKey(key, ARCHIVE_PREFIX))
            .filter((row) => row && row.chaId === c.chaId)
            .sort((a, b) => b.archivedAt - a.archivedAt);
        if (rows.length === 0) continue;
        const wanted = new Set(c.chats.filter((ch) => lacksBody(ch) && ch.id).map((ch) => ch.id));
        const found = new Map();
        for (const row of rows) {
            if (found.size === wanted.size) break;
            const decoded = await decodeArchivePayload(c.chaId, row.archivedAt);
            for (const chat of decoded?.payload.character.chats || []) {
                if (chat?.id && wanted.has(chat.id) && !found.has(chat.id) && Array.isArray(chat.message)) {
                    found.set(chat.id, chat);
                }
            }
        }
        const chats = c.chats.map((ch) => {
            if (!lacksBody(ch)) return ch;
            const body = ch.id ? found.get(ch.id) : undefined;
            if (!body) {
                result.unresolved.push(`${c.chaId}/${ch.id || '?'}`);
                return ch;
            }
            result.restored.push(`${c.chaId}/${ch.id}`);
            return mergeChatStubWithFullChat(ch, body);
        });
        if (found.size > 0) {
            nextCharacters ??= characters.slice();
            nextCharacters[i] = { ...c, chats };
        }
    }
    if (nextCharacters) result.db = { ...fullDb, characters: nextCharacters };
    return result;
}

// Chats already reported as missing from the rows: every later persist sees
// them again, so each is logged once per process.
const reportedUnresolvedArchiveChats = new Set();

// persistDbCacheWithChats / /api/write: restore what the archive rows hold
// and log what they do not. Throws only when a row is unreadable.
async function restoreArchivedChatsForDisk(fullDb, source) {
    const r = await restoreUnmergedArchivedChats(fullDb);
    if (r.restored.length > 0) {
        logger.info(`[Archive] ${source}: restored ${r.restored.length} chat body(s) from archive rows. sample=[${r.restored.slice(0, 3).join(', ')}]`);
    }
    const fresh = r.unresolved.filter((key) => !reportedUnresolvedArchiveChats.has(key));
    if (fresh.length > 0) {
        for (const key of fresh) reportedUnresolvedArchiveChats.add(key);
        logger.warn(`[Archive] ${source}: ${fresh.length} chat(s) of reactivated characters have no body on the server or in their archive rows; kept as-is. sample=[${fresh.slice(0, 3).join(', ')}]`);
    }
    return r.db;
}

function jsonLength(value) {
    try { return JSON.stringify(value).length; } catch { return 0; }
}

// `{{inlay::id}}` / `{{inlayed::id}}` / `{{inlayeddata::id}}` references in
// chat messages. Mirrors INLAY_REF_REGEX in src/ts/process/files/inlays.ts.
const INLAY_REF_RE = /\{\{(?:inlay|inlayed|inlayeddata)::(.+?)\}\}/g;

function addInlayRefCounts(refCounts, chats) {
    let messages = 0;
    for (const chat of Array.isArray(chats) ? chats : []) {
        if (!Array.isArray(chat?.message)) continue;
        for (const msg of chat.message) {
            if (typeof msg?.data !== 'string') continue;
            messages++;
            INLAY_REF_RE.lastIndex = 0;
            let m;
            while ((m = INLAY_REF_RE.exec(msg.data)) !== null) {
                refCounts[m[1]] = (refCounts[m[1]] ?? 0) + 1;
            }
        }
    }
    return messages;
}

// Which inlay images are still referenced by a chat message. The client
// cannot answer this itself: lazy-loaded chats are placeholders with no
// messages in the browser, and deactivated characters' chats live only in
// their archive rows (their counts come from archive-meta, orphan rows
// included — kept rows keep their images). Fails closed: an unreadable index
// makes the whole request fail rather than under-count.
app.get('/api/inlays/references', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    try {
        const result = await queueStorageOperation(async () => {
            await ensureChatStore();
            // Null-prototype map: an id such as "constructor" must still count.
            const refCounts = Object.create(null);
            let totalMessages = 0;
            let chats = 0;
            for (const charChats of fullChatStore.values()) {
                const list = Array.from(charChats.values());
                chats += list.length;
                totalMessages += addInlayRefCounts(refCounts, list);
            }
            let archived = 0;
            for (const meta of listArchiveMetas()) {
                archived++;
                const refs = meta.inlayRefs;
                // Fail closed: an index row without inlay counts cannot vouch
                // for its chats, and skipping it would under-count.
                if (!refs || typeof refs !== 'object') {
                    throw new Error(`archive index lacks inlay references: ${archiveRowId(meta.chaId, meta.archivedAt)}`);
                }
                for (const [id, count] of Object.entries(refs)) {
                    if (typeof count === 'number' && count > 0) refCounts[id] = (refCounts[id] ?? 0) + count;
                }
            }
            return { scannedAt: Date.now(), totalMessages, refCounts, sources: { chats, archived } };
        });
        res.json(result);
    } catch (err) {
        logger.warn(`[Inlay] reference scan failed: ${err?.message || err}`);
        res.status(500).json({ error: `Inlay reference scan failed: ${err?.message || err}` });
    }
});

// Write the archive row (and index row) for one live character of `db`,
// verified by reading it back. The database itself is left alone: the client
// moves the character to its stub list and saves. Caller holds the storage
// queue and has flushed pending persists. Resolves to { ok: true, stub } or
// { ok: false, status, code, error, chats? }.
async function writeArchiveRow(db, chaId, { acceptLostChats = false } = {}) {
    const character = (Array.isArray(db.characters) ? db.characters : []).find((c) => c?.chaId === chaId);
    if (!character) {
        return { ok: false, status: 404, error: 'Character not found', code: 'ARCHIVE_CHARACTER_NOT_FOUND' };
    }
    if (archivedStubsOf(db).some((s) => s.chaId === chaId)) {
        return { ok: false, status: 409, error: 'Character is already deactivated', code: 'ARCHIVE_ALREADY' };
    }
    let full;
    try {
        full = await hydrateCharacterForArchive(character, { acceptLostChats });
    } catch (err) {
        if (err?.code === 'ARCHIVE_CHATS_UNAVAILABLE') {
            return { ok: false, status: 409, error: err.message, code: err.code, chats: err.chats };
        }
        throw err;
    }
    // The trash marker lives on the stub (`trashedAt`), never in the row:
    // a legacy-trashed character migrating into the archive must come
    // back clean when activated.
    delete full.trashTime;
    // New row per deactivation; never overwrite an existing version.
    let archivedAt = Date.now();
    while (kvSize(archiveKey(chaId, archivedAt)) || kvGet(archiveMetaKey(chaId, archivedAt))) archivedAt++;
    const payload = { v: ARCHIVE_FORMAT_VERSION, chaId, archivedAt, character: full };
    const encoded = Buffer.from(encodeRisuSaveLegacy(payload));
    kvSet(archiveKey(chaId, archivedAt), encoded);
    // Read back before anything depends on it: the next step (the client
    // dropping the character from `characters`) is only safe if this
    // row decodes to exactly what we hydrated.
    try {
        const verified = await decodeArchivePayload(chaId, archivedAt);
        if (!verified || calculateHash(verified.payload.character) !== calculateHash(full)) {
            throw new Error('read-back does not match');
        }
    } catch (err) {
        kvDel(archiveKey(chaId, archivedAt));
        logger.error(`[Archive] verification failed for ${chaId}:`, err?.message || err);
        return { ok: false, status: 500, error: `Archive verification failed: ${err?.message || err}`, code: 'ARCHIVE_VERIFY_FAILED' };
    }
    const { chats: fullChats, ...card } = full;
    const meta = {
        v: ARCHIVE_FORMAT_VERSION,
        chaId,
        archivedAt,
        name: typeof full.name === 'string' ? full.name : '',
        image: typeof full.image === 'string' ? full.image : '',
        bytes: encoded.length,
        chatCount: Array.isArray(fullChats) ? fullChats.length : 0,
        chatIds: (Array.isArray(fullChats) ? fullChats : []).map((c) => c?.id).filter((id) => typeof id === 'string'),
        cardBytes: jsonLength(card),
        chatBytes: jsonLength(fullChats),
        // Same walker as the live sweep, so the two can never disagree
        // about which fields hold asset references.
        assetRefs: Array.from(buildUncleanableSet({ characters: [full] })),
        // Inlay references of the archived chats, for /api/inlays/references.
        inlayRefs: (() => { const counts = Object.create(null); addInlayRefCounts(counts, fullChats); return counts; })(),
    };
    kvSet(archiveMetaKey(chaId, archivedAt), Buffer.from(JSON.stringify(meta), 'utf-8'));
    logger.info(`[Archive] deactivated ${chaId}@${archivedAt} (${encoded.length} bytes, ${meta.chatCount} chats, ${meta.assetRefs.length} asset refs)`);
    return { ok: true, stub: buildArchivedCharacterStub(full, { archivedAt, bytes: encoded.length }) };
}

app.post('/api/characters/:chaId/archive', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    const chaId = req.params.chaId;
    if (!isArchivableChaId(chaId)) {
        return res.status(400).json({ error: 'Invalid character id', code: 'ARCHIVE_BAD_ID' });
    }
    try {
        await queueStorageOperation(async () => {
            await flushPendingDb();
            if (!(await loadDbCacheIfMissing())) {
                return res.status(404).json({ error: 'No database', code: 'ARCHIVE_NO_DB' });
            }
            const result = await writeArchiveRow(dbCache[DB_HEX_KEY], chaId, {
                acceptLostChats: req.body?.acceptLostChats === true,
            });
            if (!result.ok) {
                const { ok: _ok, status, ...body } = result;
                return res.status(status).json(body);
            }
            res.json({ ok: true, stub: result.stub });
        });
    } catch (err) { next(err); }
});

// Many characters in one request (bulk trash / deactivate from the character
// manager): pending persists are flushed once for the whole request instead
// of once per character — each flush rewrites all of database.bin — and each
// character gets its own result. The client applies the successes to its
// database and saves after every request, as for a single archive.
const ARCHIVE_BATCH_MAX = 100;
app.post('/api/characters/archive-batch', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    const chaIds = req.body?.chaIds;
    if (!Array.isArray(chaIds) || chaIds.length === 0 || chaIds.length > ARCHIVE_BATCH_MAX
        || chaIds.some((id) => typeof id !== 'string') || new Set(chaIds).size !== chaIds.length) {
        return res.status(400).json({ error: `chaIds must be 1-${ARCHIVE_BATCH_MAX} distinct character ids`, code: 'ARCHIVE_BAD_BATCH' });
    }
    const acceptLostChats = req.body?.acceptLostChats === true;
    try {
        await queueStorageOperation(async () => {
            await flushPendingDb();
            if (!(await loadDbCacheIfMissing())) {
                return res.status(404).json({ error: 'No database', code: 'ARCHIVE_NO_DB' });
            }
            const db = dbCache[DB_HEX_KEY];
            const results = [];
            for (const chaId of chaIds) {
                if (!isArchivableChaId(chaId)) {
                    results.push({ chaId, ok: false, error: 'Invalid character id', code: 'ARCHIVE_BAD_ID' });
                    continue;
                }
                try {
                    const { status: _status, ...result } = await writeArchiveRow(db, chaId, { acceptLostChats });
                    results.push({ chaId, ...result });
                } catch (error) {
                    // One unreadable character must not cost the others their
                    // results: a row it may have left stays unreferenced (and
                    // young rows are never purged), the character stays active.
                    logger.error(`[Archive] batch: ${chaId} failed:`, error?.message || error);
                    results.push({ chaId, ok: false, code: 'ARCHIVE_FAILED', error: String(error?.message || error) });
                }
            }
            res.json({ ok: true, results });
        });
    } catch (err) { next(err); }
});

app.post('/api/characters/:chaId/activate', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    const chaId = req.params.chaId;
    if (!isArchivableChaId(chaId)) {
        return res.status(400).json({ error: 'Invalid character id', code: 'ARCHIVE_BAD_ID' });
    }
    try {
        await queueStorageOperation(async () => {
            await flushPendingDb();
            if (!(await loadDbCacheIfMissing())) {
                return res.status(404).json({ error: 'No database', code: 'ARCHIVE_NO_DB' });
            }
            const db = dbCache[DB_HEX_KEY];
            if ((Array.isArray(db.characters) ? db.characters : []).some((c) => c?.chaId === chaId)) {
                return res.status(409).json({ error: 'Character is already active', code: 'ARCHIVE_ALREADY_ACTIVE' });
            }
            // Which version: the client's stub (its view of the database) or,
            // failing that, the stub in our own view.
            const requested = req.body && typeof req.body === 'object' ? req.body.archivedAt : undefined;
            const stub = archivedStubsOf(db).find((s) => s.chaId === chaId);
            const archivedAt = isValidArchivedAt(requested) ? requested : stub?.archivedAt;
            if (!isValidArchivedAt(archivedAt)) {
                return res.status(404).json({ error: 'Character is not deactivated', code: 'ARCHIVE_PAYLOAD_MISSING' });
            }
            let decoded;
            try {
                decoded = await decodeArchivePayload(chaId, archivedAt);
            } catch (err) {
                logger.error(`[Archive] payload unreadable for ${chaId}@${archivedAt}:`, err?.message || err);
                return res.status(400).json({ error: err?.message || 'Archive payload unreadable', code: 'ARCHIVE_PAYLOAD_INVALID' });
            }
            if (!decoded) {
                return res.status(404).json({ error: 'Deactivated character data is missing', code: 'ARCHIVE_PAYLOAD_MISSING' });
            }
            const full = decoded.payload.character;
            assignMissingChatIds({ characters: [full] });
            // The browser keeps every chaId and chat id unique across the
            // database and renames a returning chat whose id another chat took
            // meanwhile — away from its body. Rename here instead, where the
            // body moves with it (the row itself is left unchanged).
            const liveIds = new Set();
            for (const c of Array.isArray(db.characters) ? db.characters : []) {
                if (c?.chaId) liveIds.add(c.chaId);
                for (const ch of Array.isArray(c?.chats) ? c.chats : []) if (ch?.id) liveIds.add(ch.id);
            }
            const ownIds = new Set([chaId]);
            for (const chat of full.chats) {
                if (!chat || typeof chat !== 'object') continue;
                if (!chat.id || liveIds.has(chat.id) || ownIds.has(chat.id)) {
                    const next = nodeCrypto.randomUUID();
                    logger.warn(`[Archive] activate ${chaId}: chat id ${chat.id || '(none)'} is taken; renamed to ${next}`);
                    chat.id = next;
                }
                ownIds.add(chat.id);
            }
            await ensureChatStore();
            const charChats = new Map();
            for (const chat of full.chats) {
                if (!chat || chat._stub === true || !Array.isArray(chat.message)) continue;
                charChats.set(chat.id, chat);
            }
            fullChatStore.set(chaId, charChats);
            pendingActivations.set(chaId, archivedAt);
            // Client view: chats as stubs, asset array as a manifest descriptor.
            // `reconcile` reuses the live manifest when the content is unchanged.
            const clientView = stripDatabaseForClient({ characters: [full] }, { reconcileManifests: true }).characters[0];
            logger.info(`[Archive] activated ${chaId}@${archivedAt} (${charChats.size} chats registered); row retained`);
            res.json({ ok: true, character: normalizeJSON(clientView) });
        });
    } catch (err) { next(err); }
});

// Every deactivated character as a full legacy-shaped object — for the
// client-assembled partial backup, which must carry them like the server
// export does. Missing rows fail the whole request (same rule as export).
app.get('/api/characters/archived/inline', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    try {
        const result = await queueStorageOperation(async () => {
            await flushPendingDb();
            if (!(await loadDbCacheIfMissing())) return { characters: [] };
            const shell = { characters: [], nodeOnlyArchivedCharacters: archivedStubsOf(dbCache[DB_HEX_KEY]) };
            await inlineArchivedCharacters(shell);
            return { characters: shell.characters };
        });
        res.setHeader('Content-Type', 'application/octet-stream');
        res.send(Buffer.from(encodeRisuSaveLegacy(result)));
    } catch (err) {
        if (err?.code === 'ARCHIVE_PAYLOAD_MISSING') {
            return res.status(409).json({ error: err.message, code: err.code });
        }
        next(err);
    }
});

// Explicit reclaim of archive rows the live database no longer references.
// Refuses when the database cannot be loaded — without it every row would
// look orphaned.
app.post('/api/db/archive/purge-orphans', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    try {
        const result = await queueStorageOperation(async () => {
            await flushPendingDb();
            if (!(await loadDbCacheIfMissing())) return { error: 'Database unavailable — refusing to purge' };
            const db = dbCache[DB_HEX_KEY];
            if (!db || !Array.isArray(db.characters)) return { error: 'Database decode failed — refusing to purge' };
            return { ok: true, ...purgeOrphanArchiveRows(db) };
        });
        if (result.error) return res.status(400).json(result);
        logger.info(`[Archive] purged ${result.deleted} orphan row(s), ${result.metas} index row(s), ${result.bytes} bytes`);
        res.json(result);
    } catch (err) { next(err); }
});

// Permanent deletion of a deactivated (trashed) character: every archive row
// and index row of the chaId. The client drops the stub from its database
// itself; a chaId that is still active is refused so a stale trash view can
// never delete rows a live character may be re-deactivated against.
app.delete('/api/characters/:chaId/archive', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    const chaId = req.params.chaId;
    if (!isArchivableChaId(chaId)) {
        return res.status(400).json({ error: 'Invalid character id', code: 'ARCHIVE_BAD_ID' });
    }
    try {
        const result = await queueStorageOperation(async () => {
            await flushPendingDb();
            if (!(await loadDbCacheIfMissing())) return { status: 404, error: 'No database', code: 'ARCHIVE_NO_DB' };
            const db = dbCache[DB_HEX_KEY];
            if ((Array.isArray(db.characters) ? db.characters : []).some((c) => c?.chaId === chaId)) {
                return { status: 409, error: 'Character is active', code: 'ARCHIVE_ALREADY_ACTIVE' };
            }
            const payloadKeys = listArchivePayloadKeysFor(chaId);
            const metaKeys = kvList(ARCHIVE_META_PREFIX + chaId + '/');
            let bytes = 0;
            for (const key of payloadKeys) bytes += kvSize(key) || 0;
            sqliteDb.transaction(() => {
                for (const key of payloadKeys) kvDel(key);
                for (const key of metaKeys) kvDel(key);
            })();
            return { ok: true, deleted: payloadKeys.length, metas: metaKeys.length, bytes };
        });
        if (result.error) return res.status(result.status).json({ error: result.error, code: result.code });
        logger.info(`[Archive] deleted ${chaId}: ${result.deleted} row(s), ${result.metas} index row(s), ${result.bytes} bytes`);
        res.json(result);
    } catch (err) { next(err); }
});

// ── Storage dashboard endpoints ──────────────────────────────────────────────

const DB_BLOB_KEY = 'database/database.bin';
const DB_BACKUP_PREFIX = 'database/dbbackup-';
// createBackupAndRotate names snapshots `${DB_BACKUP_PREFIX}${digits}.bin`;
// the digits double as the plugin-storage snapshot id.
const DB_BACKUP_KEY_RE = /^database\/dbbackup-(\d+)\.bin$/;
const ASSET_PREFIXES = ['assets/', 'remotes/', 'inlay/', 'inlay_thumb/', 'inlay_meta/', 'inlay_info/', 'coldstorage/', 'archive/', 'archive-meta/'];
const AUTO_SWEEP_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

function statsBasename(s) {
    if (!s) return '';
    return String(s).replace(/\\/g, '/').split('/').pop();
}

// Pull "assets/..." path references out of an arbitrary value. Non-string
// values are serialized first so references nested inside plugin-stored JSON
// (objects, arrays) are found too. Mirrors globalApi's extractAssetRefs.
function extractAssetRefsFromText(value) {
    let text;
    if (typeof value === 'string') text = value;
    else {
        try { text = JSON.stringify(value) ?? ''; } catch { return []; }
    }
    return Array.from(text.matchAll(/assets[/\\][\w-]+\.\w+/g), (m) => m[0]);
}

// V3 plugin persistent storage lives in kv (cache/plugin-storage/*.json), not
// in the DB blob, and may hold saveAsset paths. Returns basenames so callers
// can union it with buildUncleanableSet before deciding what is orphaned.
function collectPluginStorageAssetRefs() {
    const set = new Set();
    // plugin-storage/ is the former db.pluginCustomStorage; the DB blob's
    // field is now always empty, so it must be scanned here instead.
    for (const key of [...kvList('cache/plugin-storage/'), ...kvList(pluginStorage.PREFIX)]) {
        try {
            const raw = kvGet(key);
            if (!raw) continue;
            const text = Buffer.isBuffer(raw) ? raw.toString('utf-8') : String(raw);
            for (const ref of extractAssetRefsFromText(text)) {
                const bn = statsBasename(ref);
                if (bn) set.add(bn);
            }
        } catch { /* unreadable entry — skip */ }
    }
    return set;
}

// The persisted blob is currently hydrated for upstream compatibility, but
// manifests are authoritative for the lazy client view and will remain so
// after a future slim-database cutover. Union the manifests of the owners
// `dbObj` still has, so a partial/stripped object (the warm dbCache always is)
// can never make referenced assets look orphaned. Live rows are never deleted
// when an owner goes away, so unioning every live row kept a deleted module's
// or character's assets referenced forever; an owner whose array is empty
// references nothing either. Per owner both the descriptor it carries and its
// current live pointer count (a stale descriptor must not under-count).
// Deactivated characters are covered by addArchivedCharacterRefs. Throws when
// a manifest fails to verify — callers must then refuse to purge / report the
// count as unavailable.
function addLiveManifestRefs(uncleanable, dbObj) {
    const manifestIds = new Set();
    const addOwner = (kind, ownerId, descriptor, inlineItems) => {
        const hasDescriptor = !!descriptor && typeof descriptor.id === 'string';
        if (!hasDescriptor && !(Array.isArray(inlineItems) && inlineItems.length > 0)) return;
        if (hasDescriptor) manifestIds.add(descriptor.id);
        const live = assetManifestStore.getLiveDescriptor(kind, ownerId);
        if (live) manifestIds.add(live.id);
    };
    (Array.isArray(dbObj?.modules) ? dbObj.modules : []).forEach((module, index) => {
        if (!module) return;
        addOwner('module', module.assetManifest?.ownerId || moduleOwnerId(module, index), module.assetManifest, module.assets);
    });
    (Array.isArray(dbObj?.characters) ? dbObj.characters : []).forEach((character, index) => {
        if (!character) return;
        addOwner('character', character.additionalAssetManifest?.ownerId || characterOwnerId(character, index),
            character.additionalAssetManifest, character.additionalAssets);
    });
    (Array.isArray(dbObj?.personas) ? dbObj.personas : []).forEach((persona, index) => {
        const embedded = persona?.embeddedModule;
        if (!embedded) return;
        addOwner('persona-module', embedded.assetManifest?.ownerId || personaOwnerId(persona, index),
            embedded.assetManifest, embedded.assets);
    });
    for (const id of manifestIds) {
        const verified = assetManifestStore.verifyManifest(id);
        if (!verified.ok) {
            throw new Error(`Asset manifest verification failed: ${id} (${verified.error})`);
        }
        for (const item of assetManifestStore.loadItems(id) || []) {
            const basename = statsBasename(item?.[1]);
            if (basename) uncleanable.add(basename);
        }
    }
}

// Every asset reference reachable from the DB. Mirrors
// src/ts/globalApi.svelte.ts:getUncleanables, plus the settings-level image-gen
// references that walker misses (NAIImgConfig, wavespeedImage).
//
// Two consumers: dashboard orphan stats, and picking which assets a
// settings-only backup carries. A miss here silently drops an asset from the
// seed backup, so err toward including a field.
//
// Deliberately absent: botPresets[].image and modules[].backgroundEmbedding.
// The former is an inline data URI (canvas.toDataURL), the latter is HTML —
// neither is a stored asset, so both ride along inside database.bin.
//
// `includeModuleAssets: false` omits modules[].assets (and the same array on a
// persona's embedded module). Asset-pack modules routinely carry thousands of
// images — several GB is normal — so a settings-only export offers to leave
// them behind. Module *icons* are not gated: they are tiny and part of the
// module's identity in the list UI.
function buildUncleanableSet(dbObj, { includeModuleAssets = true } = {}) {
    const set = new Set();
    const add = (v) => {
        const bn = statsBasename(v);
        if (bn) set.add(bn);
    };
    if (!dbObj) return set;
    add(dbObj.customBackground);
    add(dbObj.userIcon);
    // Notification sounds. Bundled-preset values (e.g. "bell") are not asset
    // paths and just add a basename that matches no stored asset.
    add(dbObj.messageSound);
    add(dbObj.translateSound);
    if (Array.isArray(dbObj.customSounds)) for (const s of dbObj.customSounds) add(s?.path);
    // Image-gen reference images hang off settings, not off a character.
    add(dbObj.NAIImgConfig?.character_image);
    add(dbObj.NAIImgConfig?.image);
    add(dbObj.wavespeedImage?.reference_image);
    if (Array.isArray(dbObj.characters)) {
        for (const cha of dbObj.characters) {
            if (!cha) continue;
            add(cha.image);
            if (Array.isArray(cha.emotionImages)) for (const em of cha.emotionImages) add(em?.[1]);
            if (Array.isArray(cha.additionalAssets)) for (const em of cha.additionalAssets) add(em?.[1]);
            if (cha.vits?.files) for (const k of Object.keys(cha.vits.files)) add(cha.vits.files[k]);
            if (Array.isArray(cha.ccAssets)) for (const a of cha.ccAssets) add(a?.uri);
            // GPT-SoVITS reference audio — assetId holds the full "assets/..." path.
            add(cha.gptSoVitsConfig?.ref_audio_data?.assetId);
        }
    }
    if (Array.isArray(dbObj.modules)) {
        for (const m of dbObj.modules) {
            if (includeModuleAssets && Array.isArray(m?.assets)) for (const a of m.assets) add(a?.[1]);
            add(m?.icon);
        }
    }
    if (Array.isArray(dbObj.personas)) {
        for (const p of dbObj.personas) {
            add(p?.icon);
            // Legacy `image` alongside `icon` on card-imported personas. Unread
            // by current code but still a live reference — see getUncleanables.
            add(p?.image);
            const embedded = p?.embeddedModule;
            if (includeModuleAssets && Array.isArray(embedded?.assets)) for (const a of embedded.assets) add(a?.[1]);
            add(embedded?.icon);
        }
    }
    if (Array.isArray(dbObj.characterOrder)) {
        for (const item of dbObj.characterOrder) {
            if (item && typeof item === 'object' && 'imgFile' in item) add(item.imgFile);
        }
    }
    // Plugins can persist asset paths (from risuai.saveAsset) anywhere inside
    // their storage — as plain strings or nested in JSON values — so scan the
    // serialized text for "assets/..." references instead of assuming a structure.
    if (dbObj.pluginCustomStorage && typeof dbObj.pluginCustomStorage === 'object') {
        for (const value of Object.values(dbObj.pluginCustomStorage)) {
            for (const ref of extractAssetRefsFromText(value)) add(ref);
        }
    }
    return set;
}

function decodeRemoteMetaLastUsed(raw) {
    try {
        if (!raw) return null;
        const text = Buffer.isBuffer(raw) ? raw.toString('utf-8') : String(raw);
        const parsed = JSON.parse(text);
        const lastUsed = Number(parsed?.lastUsed);
        return Number.isFinite(lastUsed) ? lastUsed : null;
    } catch {
        return null;
    }
}

// A new install keeps the client's boot placeholder `{}` on disk until the
// first change is saved, so the database has no character list yet. That is
// not a bad decode, but it is only safe to treat as "nothing to do" while no
// row the sweep could delete exists: with any present, a missing character
// list still means we cannot tell what is referenced, so the sweep refuses.
function isNewSaveWithNothingToSweep(dbObj, { includeAssets, includeRemotes, assets }) {
    if (!dbObj || typeof dbObj !== 'object' || Array.isArray(dbObj) || 'characters' in dbObj) return false;
    if (includeAssets && assets.length > 0) return false;
    if (includeRemotes && kvList('remotes/').length > 0) return false;
    return true;
}

const EMPTY_ASSET_SWEEP = Object.freeze({ ok: true, deleted: 0, assetsDeleted: 0, remotesDeleted: 0, bytes: 0, scanned: 0 });

async function computeAssetSweep({ includeAssets, assetGraceMs = 0, includeRemotes = false, checkpointLabel = 'AssetSweep' } = {}) {
    let dbObj;
    // updated_at is stored after the value BLOB, so reading it walks the whole
    // value's overflow pages — for every asset that took minutes on a large
    // library (#102). Only unreferenced candidates need it; it is read below.
    const assets = includeAssets ? kvListWithSizes('assets/') : [];
    const uncleanable = new Set();
    if (includeAssets) {
        await flushPendingDb();
        const raw = kvGet(DB_BLOB_KEY);
        if (!raw) return { error: 'No database blob' };
        dbObj = await decodeRisuSave(raw);
        if (isNewSaveWithNothingToSweep(dbObj, { includeAssets, includeRemotes, assets })) return { ...EMPTY_ASSET_SWEEP };
        if (!dbObj || !Array.isArray(dbObj.characters)) return { error: 'Database decode failed' };

        for (const bn of buildUncleanableSet(dbObj)) uncleanable.add(bn);
        try {
            addLiveManifestRefs(uncleanable, dbObj);
        } catch (error) {
            return { error: `Manifest reference scan failed — refusing to purge: ${error?.message || error}` };
        }
        try {
            addArchivedCharacterRefs(uncleanable, dbObj);
        } catch (error) {
            return { error: `Deactivated-character reference scan failed — refusing to purge: ${error?.message || error}` };
        }

        // A walker that returns nothing while assets exist means the decode
        // produced a shape we do not understand — every asset would look orphaned.
        // Refuse rather than delete the library. Checked before plugin-storage refs
        // are unioned in so those can't mask a bad walk.
        if (uncleanable.size === 0 && assets.length > 0) {
            return { error: 'Reference scan produced no references — refusing to purge' };
        }
        for (const bn of collectPluginStorageAssetRefs()) uncleanable.add(bn);
    } else {
        // Remote-only sweep (the boot auto-sweep with asset cleanup off): it
        // needs only the live and deactivated chaIds. The stripped dbCache
        // holds both and is at least as fresh as disk, so skip the flush,
        // the full blob decode and every asset reference scan — on a large
        // save those ran inside the storage queue and held up saves at boot.
        if (!(await loadDbCacheIfMissing())) return { error: 'No database blob' };
        dbObj = dbCache[DB_HEX_KEY];
        if (isNewSaveWithNothingToSweep(dbObj, { includeAssets, includeRemotes, assets })) return { ...EMPTY_ASSET_SWEEP };
        if (!dbObj || !Array.isArray(dbObj.characters)) return { error: 'Database decode failed' };
    }

    const now = Date.now();
    const assetVictims = includeAssets
        ? assets.filter((it) => {
            if (uncleanable.has(statsBasename(it.key))) return false;
            if (assetGraceMs > 0 && now - Number(kvGetUpdatedAt(it.key) || 0) <= assetGraceMs) return false;
            return true;
        })
        : [];

    const remoteVictims = [];
    const remoteMetaCreates = [];
    let remotesScanned = 0;
    if (includeRemotes) {
        const characterIds = new Set(dbObj.characters.map((v) => v?.chaId).filter(Boolean));
        // A deactivated character still owns its remote cache.
        for (const stub of archivedStubsOf(dbObj)) characterIds.add(stub.chaId);
        const remoteRows = kvListWithSizes('remotes/');
        const remoteByKey = new Map(remoteRows.map((it) => [it.key, it]));
        for (const it of remoteRows) {
            if (it.key.endsWith('.meta')) continue;
            remotesScanned++;
            const base = statsBasename(it.key);
            if (!base.endsWith('.local.bin')) continue;
            const chaId = base.slice(0, -'.local.bin'.length);
            if (characterIds.has(chaId)) continue;

            const metaKey = `${it.key}.meta`;
            const meta = remoteByKey.get(metaKey);
            if (!meta) {
                remoteMetaCreates.push(metaKey);
                continue;
            }
            const lastUsed = decodeRemoteMetaLastUsed(kvGet(metaKey));
            const newestUse = Math.max(Number(kvGetUpdatedAt(it.key) || 0), lastUsed ?? 0);
            if (now - newestUse > AUTO_SWEEP_GRACE_MS) {
                remoteVictims.push(it);
                remoteVictims.push(meta);
            }
        }

        for (const it of remoteRows) {
            if (!it.key.endsWith('.meta')) continue;
            const remoteKey = it.key.slice(0, -'.meta'.length);
            if (!remoteByKey.has(remoteKey)) {
                remoteVictims.push(it);
            }
        }
    }

    const victims = [...assetVictims, ...remoteVictims];
    sqliteDb.transaction(() => {
        for (const key of remoteMetaCreates) {
            kvSet(key, Buffer.from(JSON.stringify({ lastUsed: now })));
        }
        for (const it of victims) kvDel(it.key);
    })();

    const deleted = victims.length;
    const bytes = victims.reduce((sum, it) => sum + it.size, 0);
    if (deleted > 0) {
        try { checkpointWal('TRUNCATE'); } catch (e) { logger.warn(`[${checkpointLabel}] checkpoint failed:`, e?.message || e); }
    }

    return {
        ok: true,
        deleted: assetVictims.length,
        assetsDeleted: assetVictims.length,
        remotesDeleted: remoteVictims.length,
        bytes,
        scanned: assets.length + remotesScanned,
    };
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
    // Plugin storage is re-embedded into database.risudat on export.
    for (const it of pluginStorage.list()) total += it.size;
    for (const it of kvListWithSizes('assets/')) total += it.size;
    for (const it of kvListWithSizes('inlay_meta/')) total += it.size;
    for (const e of listColdStorageBackupEntries()) total += e.size;
    // Deactivated characters are inlined into database.risudat on export.
    // Counting every archive row (orphans included) over-estimates, which is
    // the safe direction for a free-space preflight.
    for (const k of kvList(ARCHIVE_PREFIX)) total += kvSize(k) || 0;
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
        const pluginSize = snapshotPluginSizer();
        for (const k of backupKeys) {
            const sz = (kvSize(k) || 0) + (isSnapshotKey(k) ? pluginSize(k).bytes : 0);
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
            if (p === ARCHIVE_PREFIX) {
                // Chunk-routed rows hold only a marker in kv; report logical size.
                const keys = kvList(p);
                let total = 0;
                for (const k of keys) total += kvSize(k) || 0;
                prefixes[p] = { totalSize: total, count: keys.length };
                continue;
            }
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
        let trashed = { count: 0, available: false };
        let orphan = { count: 0, totalSize: 0, available: false };
        let archiveOrphan = { count: 0, totalSize: 0, available: false };
        const stripped = dbCache[DB_HEX_KEY];
        if (stripped && Array.isArray(stripped.characters)) {
            try {
                const rows = listOrphanArchiveRows(stripped);
                archiveOrphan = { count: rows.payloads.length, totalSize: rows.bytes, available: true };
            } catch (error) {
                logger.warn(`[Stats] archive orphan scan skipped: ${error?.message || error}`);
            }
        }
        if (stripped?.characters) {
            for (const c of stripped.characters) {
                if (c?.trashTime) trashed.count++;
            }
            for (const stub of archivedStubsOf(stripped)) {
                if (isValidArchivedAt(stub.trashedAt)) trashed.count++;
            }
            trashed.available = true;
        }
        // `characters` must be an array: a decode failure parks `{}` in dbCache,
        // and walking that yields an empty reference set — which would report
        // every stored asset as an orphan.
        // dbCache holds the stripped (manifest-descriptor) shape, so the
        // walker alone misses every lazy character/module asset — union the
        // live manifests exactly like the purge path does, or the dashboard
        // reports the whole library as orphaned while purge deletes nothing.
        if (stripped && Array.isArray(stripped.characters)) {
            try {
                const uncleanable = buildUncleanableSet(stripped);
                addLiveManifestRefs(uncleanable, stripped);
                addArchivedCharacterRefs(uncleanable, stripped);
                for (const bn of collectPluginStorageAssetRefs()) uncleanable.add(bn);
                for (const it of kvListWithSizes('assets/')) {
                    if (!uncleanable.has(statsBasename(it.key))) {
                        orphan.count++;
                        orphan.totalSize += it.size;
                    }
                }
                orphan.available = true;
            } catch (error) {
                logger.warn(`[Stats] orphan scan skipped: ${error?.message || error}`);
                orphan = { count: 0, totalSize: 0, available: false };
            }
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
            archiveOrphan,
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

        // Deactivated characters are not in dbObj.characters; list them from
        // their stubs so the dashboard shows where the bytes went and can
        // offer to re-activate. Sizes come from the archive-meta index.
        for (const stub of archivedStubsOf(dbObj)) {
            let meta = null;
            try { meta = readArchiveMeta(stub.chaId, stub.archivedAt); } catch { meta = null; }
            const refs = meta ? meta.assetRefs : [stub.image];
            let imgBytes = remoteSize.get(stub.chaId) || 0;
            for (const ref of refs) {
                const bn = statsBasename(ref);
                if (!bn || claimed.has(bn)) continue;
                const sz = assetSize.get(bn);
                if (sz != null) {
                    imgBytes += sz;
                    claimed.add(bn);
                }
            }
            const cardBytes = meta?.cardBytes ?? 0;
            const chatBytes = meta?.chatBytes ?? 0;
            characters.push({
                chaId: stub.chaId,
                name: stub.name || '',
                image: stub.image || '',
                trashed: isValidArchivedAt(stub.trashedAt),
                archived: true,
                archiveMissing: !meta || !hasArchivePayload(stub.chaId, stub.archivedAt),
                cardBytes,
                imgBytes,
                chatBytes,
                totalBytes: cardBytes + imgBytes + chatBytes,
            });
        }

        // Same fail-closed rule as /api/db/stats: an unreadable reference
        // source must not make the whole library look orphaned.
        let orphan = { count: 0, totalSize: 0, available: false };
        try {
            const uncleanable = buildUncleanableSet(dbObj);
            addLiveManifestRefs(uncleanable, dbObj);
            addArchivedCharacterRefs(uncleanable, dbObj);
            for (const bn of collectPluginStorageAssetRefs()) uncleanable.add(bn);
            let orphanCount = 0, orphanTotal = 0;
            for (const it of kvListWithSizes('assets/')) {
                if (!uncleanable.has(statsBasename(it.key))) {
                    orphanCount++;
                    orphanTotal += it.size;
                }
            }
            orphan = { count: orphanCount, totalSize: orphanTotal, available: true };
        } catch (error) {
            logger.warn(`[Stats] per-character orphan scan skipped: ${error?.message || error}`);
        }

        characters.sort((a, b) => b.totalBytes - a.totalBytes);
        res.json({
            characters,
            orphan,
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

// Delete every assets/* row no reference in the database points at. The count
// shown by /api/db/stats comes from the in-memory stripped cache; this pass
// recomputes from the persisted blob instead, so the deletion is decided by the
// same bytes a backup would carry rather than by cache state.
app.post('/api/db/assets/purge-orphans', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    try {
        const result = await queueStorageOperation(async () => {
            const sweep = await computeAssetSweep({ includeAssets: true, checkpointLabel: 'PurgeOrphans' });
            if (sweep.error) return sweep;
            return { ok: true, deleted: sweep.deleted, bytes: sweep.bytes, scanned: sweep.scanned };
        });
        if (result.error) return res.status(400).json(result);
        logger.info(`[PurgeOrphans] removed ${result.deleted}/${result.scanned} assets (${result.bytes} bytes)`);
        res.json(result);
    } catch (err) { next(err); }
});

app.post('/api/db/assets/auto-sweep', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    try {
        const includeAssets = req.body?.assets === true;
        const result = await queueStorageOperation(async () => {
            return computeAssetSweep({
                includeAssets,
                assetGraceMs: AUTO_SWEEP_GRACE_MS,
                includeRemotes: true,
                checkpointLabel: 'AutoSweep',
            });
        });
        if (result.error) return res.status(400).json(result);
        logger.info(`[AutoSweep] removed assets=${result.assetsDeleted}, remotes=${result.remotesDeleted}, scanned=${result.scanned}, bytes=${result.bytes}`);
        res.json(result);
    } catch (err) { next(err); }
});

app.post('/api/db/optimize', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res, { changesData: false })) return;
    try {
        const saveDir = path.join(process.cwd(), 'save');
        const dbFilePath = path.join(saveDir, 'risuai.db');
        const preDbSize = statSafe(dbFilePath)?.size ?? 0;

        // VACUUM peaks at ~2x the DB size on disk: the transient copy it builds
        // (routed to the save dir via SQLITE_TMPDIR) plus the WAL inflating to
        // roughly the full DB while the copy is written back.
        const { free } = await diskFreeStat(saveDir);
        if (preDbSize > 0 && free != null && free < preDbSize * 2.2) {
            return res.status(400).json({
                error: 'Insufficient disk space for VACUUM',
                required: Math.ceil(preDbSize * 2.2),
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
            // VACUUM copies the entire DB into a transient database that honors
            // temp_store. With the session-wide temp_store=MEMORY that copy
            // lands in RAM and OOM-kills the process on multi-GB DBs, so spill
            // it to disk (SQLITE_TMPDIR = save dir) for the duration.
            sqliteDb.pragma('temp_store = FILE');
            try {
                sqliteDb.exec('VACUUM');
            } finally {
                sqliteDb.pragma('temp_store = MEMORY');
            }
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
    if (!checkActiveSession(req, res, { changesData: false })) return;
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
        const pluginSize = snapshotPluginSizer();
        const out = listSnapshotKeys().map((key) => {
            const tsRaw = parseInt(key.slice(DB_BACKUP_PREFIX.length, -4), 10);
            const ts = Number.isFinite(tsRaw) ? tsRaw * 100 : null;
            // Logical size — the full data this snapshot represents (the whole DB),
            // not its marginal on-disk cost. Users expect "this backup = my 53 MB
            // DB"; the dedup win is shown once, as the section's savings figure.
            // (kvSize reassembles via the manifest; the marker's 13 bytes are not
            // what a user wants to see for a full backup.) Trimming still sizes by
            // snapshotFootprint in db.cjs, so this display change can't over-trim.
            return { key, size: (kvSize(key) || 0) + pluginSize(key).bytes, timestamp: ts };
        }).sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
        res.json({ snapshots: out });
    } catch (err) { next(err); }
});

app.delete('/api/db/snapshots', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    try {
        const key = typeof req.query?.key === 'string' ? req.query.key : '';
        // Exact snapshot shape only — never let this endpoint touch other kv
        // keys, nor derive a plugin snapshot id from a malformed name.
        if (!isSnapshotKey(key)) {
            return res.status(400).json({ error: 'Invalid snapshot key' });
        }
        deleteSnapshot(key);
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
        if (!isSnapshotKey(key)) {
            return res.status(400).json({ error: 'Invalid snapshot key' });
        }
        const blob = kvGet(key);
        if (!blob) {
            return res.status(404).json({ error: 'Snapshot not found' });
        }
        let snapshotMissing = false;
        await queueStorageOperation(async () => {
            restoringSnapshotKey = key;
            try {
                // Drain any pending debounced persist first — same pattern as
                // /api/db/optimize. Without this, an in-flight save could land
                // after kvCopyValue and overwrite the restored snapshot.
                await flushPendingDb();
            } finally {
                restoringSnapshotKey = null;
            }
            // A delete may have run while this waited in the queue. Copying a
            // missing snapshot is a silent no-op that would still wipe the
            // live plugin storage below, so stop here instead.
            if (kvSize(key) === null) {
                snapshotMissing = true;
                return;
            }
            // Blob and plugin rows come back together: the live plugin set is
            // replaced by exactly the snapshot's (empty for a pre-split
            // snapshot, whose data the decode below re-splits from the blob).
            sqliteDb.transaction(() => {
                kvCopyValue(key, DB_BLOB_KEY);
                pluginStorage.restoreFrom(snapshotPluginId(key));
            })();
            // The flush above may have left one snapshot over the limits
            // while the restored one was protected.
            trimSnapshotsToLimits();
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
                    await initChatStoreFromDisk(dbObj);
                    // Migration may have rewritten database.bin — etag must
                    // reflect the post-migration bytes the next /api/read sends.
                    const finalRaw = kvGet(DB_BLOB_KEY);
                    if (finalRaw) dbEtag = computeBufferEtag(Buffer.from(finalRaw));
                }
            } catch (e) {
                logger.warn('[Snapshot restore] post-restore decode failed:', e?.message || e);
            }
        });
        if (snapshotMissing) {
            return res.status(404).json({ error: 'Snapshot not found' });
        }
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

// ── Supporters proxy (Patreon list via update worker) ───────────────────────
const SUPPORTERS_URL = UPDATE_CHECK_URL.replace(/\/check$/, '/supporters');
const SUPPORTER_NAME_URL = UPDATE_CHECK_URL.replace(/\/check$/, '/patreon/name');
let supportersCache = { at: 0, data: null };
app.get('/api/supporters', async (req, res) => {
    if (UPDATE_CHECK_DISABLED) { res.json({ disabled: true, supporters: [], tiers: [] }); return; }
    if (supportersCache.data && Date.now() - supportersCache.at < 60_000) { res.json(supportersCache.data); return; }
    try {
        const r = await fetch(SUPPORTERS_URL);
        if (!r.ok) { res.status(r.status).json({ error: 'upstream error' }); return; }
        const data = await r.json();
        data.nameUrl = SUPPORTER_NAME_URL;
        supportersCache = { at: Date.now(), data };
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

        // Restore from a previous interrupted update only when its in-progress
        // marker is still there. A leftover backup/ alone is not proof of an
        // interrupted update: on Windows the running launcher exe keeps
        // backup/PocketRisu.exe locked, so the restart script's rmdir leaves
        // the folder behind after a SUCCESSFUL update — restoring from it
        // would roll the app back to the previous version.
        const prevBackup = path.join(updateTmp, 'backup');
        const inProgressMarker = path.join(updateTmp, 'in-progress');
        if (existsSync(inProgressMarker) && existsSync(prevBackup)) {
            console.log('[Update] Restoring files from previous interrupted update...');
            await restoreBackup(prevBackup, appDir);
        }
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
        const keep = new Set(['save', 'backups', '.installed-version', '.installed-manifest', '.update-tmp', 'scripts', '.env', '.npmrc', '.portable']);
        if (isWin) keep.add('bin');
        const customBackupKeep = customBackupKeepEntry(appDir);
        if (customBackupKeep && !keep.has(customBackupKeep)) {
            console.log(`[Self-Update] Preserving custom backup directory: ${customBackupKeep}/`);
            keep.add(customBackupKeep);
        }

        // Managed set — only entries the app shipped (new package contents ∪
        // previously recorded manifest) may be removed. Anything else in the
        // app root is a user file and must survive the update untouched.
        const manifestPath = path.join(appDir, '.installed-manifest');
        let oldManifest = [];
        let hasOldManifest = false;
        try {
            oldManifest = (await fs.readFile(manifestPath, 'utf-8'))
                .split('\n').map(s => s.trim()).filter(Boolean);
            hasOldManifest = true;
        } catch { /* pre-manifest install */ }
        const newEntries = await fs.readdir(sourceDir);
        const managed = new Set([...newEntries, ...oldManifest]);

        // A user file whose name collides with an entry the new release
        // introduces would be overwritten in Phase 2 — evacuate it to backups/
        // instead of losing it. Only decidable when a previous manifest exists.
        const isConflict = (e) => hasOldManifest
            && !oldManifest.includes(e) && newEntries.includes(e);
        const conflictDir = path.join(appDir, 'backups', `update-conflict-v${targetVersion}`);
        // A retried update may have evacuated the same name before — never overwrite
        const conflictDest = (e) => {
            let dest = path.join(conflictDir, e);
            for (let n = 1; existsSync(dest); n++) dest = path.join(conflictDir, `${e}.${n}`);
            return dest;
        };

        // Phase 1: move old files to backup — rollback immediately on any failure
        const backupDir = path.join(updateTmp, 'backup');
        await fs.mkdir(backupDir, { recursive: true });
        // Marks "app files are mid-replacement": present from the first move
        // until the new files are verified in place. Only then does a leftover
        // backup/ mean an interrupted update (see the restore check above).
        await fs.writeFile(inProgressMarker, `v${targetVersion}`);

        const preserved = [];
        const oldEntries = await fs.readdir(appDir);
        for (const e of oldEntries) {
            if (keep.has(e)) continue;
            if (!managed.has(e)) { preserved.push(e); continue; }
            try {
                if (isConflict(e)) {
                    console.log(`[Update] User file "${e}" collides with a new app file — moving it to backups/update-conflict-v${targetVersion}/`);
                    await fs.mkdir(conflictDir, { recursive: true });
                    await moveAcrossVolumes(path.join(appDir, e), conflictDest(e));
                    continue;
                }
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
        if (preserved.length) {
            console.log(`[Update] Preserving user files: ${preserved.join(', ')}`);
        }

        // Phase 2: move new files from extracted to app root
        const skipMove = new Set(['save', 'scripts']);
        if (isWin) skipMove.add('bin');
        const moved = [];
        try {
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

        // Record what this release shipped, so the next update knows which
        // entries are app-managed and leaves everything else alone.
        await fs.writeFile(manifestPath, newEntries.join('\n') + '\n').catch(() => {});

        // App files are complete and verified: a leftover backup/ from here on
        // must never be restored over them.
        await fs.rm(inProgressMarker, { force: true }).catch(() => {});

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
                //
                // cmd.exe parses .bat files in the OEM code page (e.g. CP949 on Korean
                // Windows), not UTF-8, so any non-ASCII path (Korean user name, "바탕 화면")
                // written literally into the script would be mangled and every command
                // would fail. Keep the script pure ASCII and pass paths through environment
                // variables, which reach cmd.exe as UTF-16 via CreateProcessW.
                const batScript = path.join(os.tmpdir(), `risu-restart-${Date.now()}.bat`);
                const utmp = path.join(appDir, '.update-tmp');
                const batLines = [
                    '@echo off',
                    // Wait ~3s for the Node process to exit before touching
                    // bin/. Not `timeout`: with stdio ignored, stdin is NUL
                    // and timeout exits at once ("input redirection is not
                    // supported"); ping does not read stdin.
                    'ping -n 4 127.0.0.1 >nul',
                    // Apply staged bin/: backup current → copy new → on failure restore backup
                    'if exist "%RISU_UTMP%\\new-bin\\" (',
                    '  if exist "%RISU_APP_DIR%\\bin\\" (',
                    '    xcopy /E /I /Y "%RISU_APP_DIR%\\bin\\*" "%RISU_UTMP%\\old-bin\\" >nul',
                    '  )',
                    '  xcopy /E /I /Y "%RISU_UTMP%\\new-bin\\*" "%RISU_APP_DIR%\\bin\\" >nul',
                    '  if errorlevel 1 (',
                    '    echo [Update] bin/ copy failed, restoring backup...',
                    '    if exist "%RISU_UTMP%\\old-bin\\" (',
                    '      xcopy /E /I /Y "%RISU_UTMP%\\old-bin\\*" "%RISU_APP_DIR%\\bin\\" >nul',
                    '    )',
                    '    echo [Update] bin/ restored. Staged files kept for retry.',
                    '    goto start',
                    '  )',
                    ')',
                    // Finalize version marker only after successful bin/ copy
                    'if exist "%RISU_UTMP%\\latest-version" (',
                    '  copy /Y "%RISU_UTMP%\\latest-version" "%RISU_APP_DIR%\\.installed-version" >nul',
                    ')',
                    // Cleanup .update-tmp (includes old-bin backup)
                    'rmdir /s /q "%RISU_UTMP%" 2>nul',
                    ':start',
                    // Start server with correct working directory
                    'cd /d "%RISU_APP_DIR%"',
                    'start "" "%RISU_APP_DIR%\\bin\\node.exe" "%RISU_APP_DIR%\\server\\node\\server.cjs"',
                    'exit /b 0',
                ];
                writeFileSync(batScript, batLines.join('\r\n'), 'ascii');
                spawn('cmd.exe', ['/c', batScript], {
                    detached: true,
                    stdio: 'ignore',
                    env: Object.assign({}, process.env, { RISU_APP_DIR: appDir, RISU_UTMP: utmp }),
                }).unref();
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
// A counted write whose route failed is over, even when no answer goes out
// (checkActiveSession).
app.use((err, req, res, next) => {
    res.locals.endSessionWrite?.();
    next(err);
});
app.use(expressErrorMiddleware);
app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    // Body parsers reject an oversized body with type 'entity.too.large'; keep
    // its 413 so the client can show the size message instead of a generic one.
    const status = err?.type === 'entity.too.large' ? 413 : 500;
    res.status(status).json({ error: err?.message || 'internal server error' });
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

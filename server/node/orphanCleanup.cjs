'use strict'

// 7-day grace for assets and remotes.
const GRACE_MS = 1000 * 60 * 60 * 24 * 7;

/**
 * Finds assets and remotes eligible under the current cleanup rules.
 *
 * Uses the server-validated current DB reference set (buildUncleanableSet from
 * server.cjs). This view avoids granting deletion authority to a single
 * client reference set, but it is not a claim about every historical or
 * concurrently changing DB generation.
 *
 * Rules:
 *  - assets/*: orphan if basename not in the uncleanable set and its existing
 *    updated_at timestamp is older than the grace period. Missing/invalid
 *    timestamps are preserved conservatively.
 *  - remotes/*: orphan if the character no longer exists AND the 7-day grace
 *    (based on the .meta lastUsed timestamp) has elapsed. No .meta → grace
 *    not started → skip (will be picked up on a later pass).
 *  - .meta entries are always skipped.
 *
 * Returns a list of { key, size, prefix, reason } entries. Does NOT delete —
 * the caller (the /api/cleanup/orphan-assets endpoint) decides whether to
 * dry-run (return the list) or confirm (kvDel each key).
 */
function findOrphans(dbObj, assetEntries, remoteEntries, uncleanable, now) {
    if (now === undefined) now = Date.now();
    const characterIds = new Set(
        Array.isArray(dbObj && dbObj.characters)
            ? dbObj.characters.map(function (c) { return c && c.chaId; }).filter(Boolean)
            : []
    );
    const orphans = [];

    for (let i = 0; i < assetEntries.length; i++) {
        var it = assetEntries[i];
        if (!it || !it.key || it.key.endsWith('.meta')) continue;
        var bn = basename(it.key);
        if (typeof it.updatedAt !== 'number' || !Number.isFinite(it.updatedAt)
            || now - it.updatedAt <= GRACE_MS) continue;
        if (!uncleanable.has(bn)) {
            orphans.push({ key: it.key, size: it.size || 0, prefix: 'assets', reason: 'unreferenced' });
        }
    }

    for (let i = 0; i < remoteEntries.length; i++) {
        var it = remoteEntries[i];
        if (!it || !it.key || it.key.endsWith('.meta')) continue;
        var bn = basename(it.key);
        var name = bn.endsWith('.local.bin') ? bn.slice(0, -10) : bn;
        if (characterIds.has(name)) continue;
        var meta = it.meta ? parseMeta(it.meta) : null;
        if (!meta) continue; // no meta or corrupt meta → grace not established, skip
        var lastUsed = meta.lastUsed || 0;
        if (now - lastUsed > GRACE_MS) {
            orphans.push({ key: it.key, size: it.size || 0, prefix: 'remotes', reason: 'stale' });
        }
    }

    return orphans;
}

function basename(s) {
    return String(s).replace(/\\/g, '/').split('/').pop();
}

function parseMeta(buf) {
    try {
        if (Buffer.isBuffer(buf)) return JSON.parse(buf.toString('utf-8'));
        if (buf instanceof Uint8Array) return JSON.parse(new TextDecoder().decode(buf));
        return JSON.parse(String(buf));
    } catch {
        return null;
    }
}

// Plugin-owned settings may store asset paths in arbitrary nested structures,
// and new core fields can appear without being added to the manual walker.
// Preserve every DB string that is an assets/* path as a conservative safety
// net. Only basenames are needed by the existing cleanup logic.
function collectAssetBasenames(value, target, seen) {
    if (!target) target = new Set();
    if (!seen) seen = new WeakSet();
    if (typeof value === 'string') {
        if (value.startsWith('assets/')) {
            var bn = basename(value);
            if (bn) target.add(bn);
        }
        return target;
    }
    if (!value || typeof value !== 'object' || seen.has(value)) return target;
    seen.add(value);
    if (Array.isArray(value)) {
        for (var i = 0; i < value.length; i++) collectAssetBasenames(value[i], target, seen);
    } else {
        for (var key of Object.keys(value)) collectAssetBasenames(value[key], target, seen);
    }
    return target;
}

module.exports = { findOrphans, collectAssetBasenames, GRACE_MS };

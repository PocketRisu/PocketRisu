'use strict'

const DEFAULT_SCAN_TTL_MS = 10 * 60 * 1000;

class CleanupScanError extends Error {
    constructor(reason) {
        super('Cleanup scan is no longer valid');
        this.name = 'CleanupScanError';
        this.code = 'CLEANUP_SCAN_INVALID';
        this.reason = reason;
    }
}

function createCleanupScanStore(options) {
    options = options || {};
    const now = options.now || Date.now;
    const randomUUID = options.randomUUID;
    const ttlMs = options.ttlMs || DEFAULT_SCAN_TTL_MS;
    let pending = null;

    function issue(sessionId, candidateKeys) {
        const issuedAt = now();
        pending = {
            scanId: randomUUID(),
            sessionId,
            expiresAt: issuedAt + ttlMs,
            candidateKeys: new Set(candidateKeys),
        };
        return { scanId: pending.scanId, expiresAt: pending.expiresAt };
    }

    function consume(scanId, sessionId) {
        const scan = pending;
        if (!scan || scan.scanId !== scanId) {
            throw new CleanupScanError('missing-or-replaced');
        }
        if (scan.expiresAt <= now()) {
            pending = null;
            throw new CleanupScanError('expired');
        }
        if (scan.sessionId !== sessionId) {
            throw new CleanupScanError('session-mismatch');
        }
        // One-shot even if revalidation or deletion later fails.
        pending = null;
        return scan;
    }

    return { issue, consume };
}

function intersectCandidates(originalKeys, currentEntries) {
    const currentByKey = new Map(currentEntries.map((entry) => [entry.key, entry]));
    const eligible = [];
    for (const key of originalKeys) {
        const entry = currentByKey.get(key);
        if (entry) eligible.push(entry);
    }
    return eligible;
}

function deleteKeysAtomically(db, deleteKey, keys) {
    const run = db.transaction((items) => {
        for (const key of items) deleteKey(key);
    });
    run(keys);
}

module.exports = {
    CleanupScanError,
    DEFAULT_SCAN_TTL_MS,
    createCleanupScanStore,
    intersectCandidates,
    deleteKeysAtomically,
};

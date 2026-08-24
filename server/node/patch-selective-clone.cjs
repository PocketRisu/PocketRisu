'use strict';

function decodePointerSegment(segment) {
    return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

function collectPatchTopLevelKeys(patch) {
    const keys = new Set();
    let touchesRoot = false;

    for (const op of Array.isArray(patch) ? patch : []) {
        for (const field of ['path', 'from']) {
            const pointer = op?.[field];
            if (typeof pointer !== 'string') continue;
            if (pointer === '') {
                touchesRoot = true;
                continue;
            }
            if (!pointer.startsWith('/')) {
                touchesRoot = true;
                continue;
            }
            const nextSlash = pointer.indexOf('/', 1);
            const rawSegment = nextSlash === -1
                ? pointer.slice(1)
                : pointer.slice(1, nextSlash);
            keys.add(decodePointerSegment(rawSegment));
        }
    }

    return { keys, touchesRoot };
}

function collectPluginStorageChildKeys(patch) {
    const keys = new Set();
    let touchesStorageRoot = false;
    let referencesStorage = false;

    for (const op of Array.isArray(patch) ? patch : []) {
        for (const field of ['path', 'from']) {
            const pointer = op?.[field];
            if (typeof pointer !== 'string' || !pointer.startsWith('/') || pointer === '') continue;
            const firstSlash = pointer.indexOf('/', 1);
            const rawTop = firstSlash === -1 ? pointer.slice(1) : pointer.slice(1, firstSlash);
            if (decodePointerSegment(rawTop) !== 'pluginCustomStorage') continue;
            referencesStorage = true;
            if (firstSlash === -1) {
                touchesStorageRoot = true;
                continue;
            }
            const childEnd = pointer.indexOf('/', firstSlash + 1);
            const rawChild = childEnd === -1
                ? pointer.slice(firstSlash + 1)
                : pointer.slice(firstSlash + 1, childEnd);
            keys.add(decodePointerSegment(rawChild));
        }
    }
    return { keys, touchesStorageRoot, referencesStorage };
}

function isPlainPatchRoot(database) {
    return database !== null && typeof database === 'object' && !Array.isArray(database);
}

function clonePluginStorageForPatch(storage, patch) {
    if (!isPlainPatchRoot(storage)) return structuredClone(storage);
    const { keys, touchesStorageRoot, referencesStorage } = collectPluginStorageChildKeys(patch);
    if (touchesStorageRoot || !referencesStorage) return structuredClone(storage);
    const snapshot = { ...storage };
    for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(storage, key)) {
            Object.defineProperty(snapshot, key, {
                value: structuredClone(storage[key]),
                enumerable: true, configurable: true, writable: true,
            });
        }
    }
    return snapshot;
}

function clonePatchSnapshot(database, patch) {
    if (!isPlainPatchRoot(database)) {
        return structuredClone(database);
    }

    const { keys, touchesRoot } = collectPatchTopLevelKeys(patch);
    if (touchesRoot) {
        return structuredClone(database);
    }

    // The root itself must be independent so top-level add/remove/replace ops
    // cannot mutate the live cache. Untouched nested branches stay shared;
    // every top-level branch that a patch can mutate is cloned below.
    const snapshot = { ...database };
    for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(database, key)) {
            const value = key === 'pluginCustomStorage'
                ? clonePluginStorageForPatch(database[key], patch)
                : structuredClone(database[key]);
            Object.defineProperty(snapshot, key, {
                value,
                enumerable: true,
                configurable: true,
                writable: true,
            });
        }
    }
    return snapshot;
}

module.exports = {
    clonePatchSnapshot,
    clonePluginStorageForPatch,
    collectPatchTopLevelKeys,
    collectPluginStorageChildKeys,
};

'use strict';

const PRIME_MULTIPLIER = 31;
const SEED_OBJECT = 17;

function decodePointerSegment(segment) {
    return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

function collectTouchedTopLevelKeys(patch) {
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

function createPatchHashCache(calculateHash) {
    if (typeof calculateHash !== 'function') {
        throw new TypeError('calculateHash must be a function');
    }

    const states = new WeakMap();

    function isObjectRoot(value) {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    function buildPluginStorageState(storage) {
        if (!isObjectRoot(storage)) {
            return { childHashes: null, fullHash: calculateHash(storage) };
        }

        const childHashes = new Map();
        for (const key in storage) {
            childHashes.set(key, calculateHash(storage[key]));
        }
        return { childHashes, fullHash: null };
    }

    function composePluginStorageHash(storage, state) {
        if (!isObjectRoot(storage) || state.childHashes === null) {
            return state.fullHash ?? calculateHash(storage);
        }

        let objectHash = SEED_OBJECT;
        for (const key in storage) {
            let childHash = state.childHashes.get(key);
            if (childHash === undefined && !state.childHashes.has(key)) {
                childHash = calculateHash(storage[key]);
                state.childHashes.set(key, childHash);
            }
            objectHash += Math.imul(calculateHash(key), PRIME_MULTIPLIER) + childHash;
        }
        return objectHash >>> 0;
    }

    function updatePluginStorageState(previousStorage, nextStorage, patch, previousState) {
        const { keys, touchesStorageRoot, referencesStorage } = collectPluginStorageChildKeys(patch);
        if (
            touchesStorageRoot
            || !referencesStorage
            || !isObjectRoot(previousStorage)
            || !isObjectRoot(nextStorage)
            || !previousState
            || previousState.childHashes === null
        ) {
            return buildPluginStorageState(nextStorage);
        }

        const childHashes = new Map(previousState.childHashes);
        for (const key of keys) {
            if (Object.prototype.hasOwnProperty.call(nextStorage, key)) {
                childHashes.set(key, calculateHash(nextStorage[key]));
            } else {
                childHashes.delete(key);
            }
        }
        return { childHashes, fullHash: null };
    }

    function buildState(database) {
        if (!isObjectRoot(database)) {
            return {
                valueHashes: null,
                fullHash: calculateHash(database),
                pluginStorageState: null,
            };
        }

        const valueHashes = new Map();
        let pluginStorageState = null;
        for (const key in database) {
            if (key === 'pluginCustomStorage') {
                pluginStorageState = buildPluginStorageState(database[key]);
                valueHashes.set(key, composePluginStorageHash(database[key], pluginStorageState));
            } else {
                valueHashes.set(key, calculateHash(database[key]));
            }
        }
        return { valueHashes, fullHash: null, pluginStorageState };
    }

    function getState(database) {
        if (!isObjectRoot(database)) return buildState(database);
        let state = states.get(database);
        if (!state) {
            state = buildState(database);
            states.set(database, state);
        }
        return state;
    }

    function compose(database, state) {
        if (!isObjectRoot(database) || state.valueHashes === null) {
            return state.fullHash ?? calculateHash(database);
        }

        let rootHash = SEED_OBJECT;
        for (const key in database) {
            let valueHash = state.valueHashes.get(key);
            if (valueHash === undefined && !state.valueHashes.has(key)) {
                if (key === 'pluginCustomStorage') {
                    state.pluginStorageState = buildPluginStorageState(database[key]);
                    valueHash = composePluginStorageHash(database[key], state.pluginStorageState);
                } else {
                    valueHash = calculateHash(database[key]);
                }
                state.valueHashes.set(key, valueHash);
            }
            rootHash += Math.imul(calculateHash(key), PRIME_MULTIPLIER) + valueHash;
        }
        return rootHash >>> 0;
    }

    function hash(database) {
        return compose(database, getState(database));
    }

    function update(previousDatabase, nextDatabase, patch) {
        if (!isObjectRoot(nextDatabase)) {
            return calculateHash(nextDatabase);
        }

        const previousState = isObjectRoot(previousDatabase)
            ? getState(previousDatabase)
            : null;
        const { keys, touchesRoot } = collectTouchedTopLevelKeys(patch);

        let nextState;
        if (touchesRoot || !previousState || previousState.valueHashes === null) {
            nextState = buildState(nextDatabase);
        } else {
            const valueHashes = new Map(previousState.valueHashes);
            let pluginStorageState = previousState.pluginStorageState;

            for (const key of keys) {
                if (Object.prototype.hasOwnProperty.call(nextDatabase, key)) {
                    if (key === 'pluginCustomStorage') {
                        pluginStorageState = updatePluginStorageState(
                            previousDatabase?.pluginCustomStorage,
                            nextDatabase.pluginCustomStorage,
                            patch,
                            previousState.pluginStorageState,
                        );
                        valueHashes.set(
                            key,
                            composePluginStorageHash(nextDatabase.pluginCustomStorage, pluginStorageState),
                        );
                    } else {
                        valueHashes.set(key, calculateHash(nextDatabase[key]));
                    }
                } else {
                    valueHashes.delete(key);
                    if (key === 'pluginCustomStorage') pluginStorageState = null;
                }
            }
            nextState = { valueHashes, fullHash: null, pluginStorageState };
        }

        states.set(nextDatabase, nextState);
        return compose(nextDatabase, nextState);
    }

    return { hash, update };
}

module.exports = {
    createPatchHashCache,
    collectTouchedTopLevelKeys,
    collectPluginStorageChildKeys,
};

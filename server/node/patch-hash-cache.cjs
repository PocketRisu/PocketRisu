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

function createPatchHashCache(calculateHash) {
    if (typeof calculateHash !== 'function') {
        throw new TypeError('calculateHash must be a function');
    }

    const states = new WeakMap();

    function isObjectRoot(database) {
        return database !== null && typeof database === 'object' && !Array.isArray(database);
    }

    function buildState(database) {
        if (!isObjectRoot(database)) {
            return { valueHashes: null, fullHash: calculateHash(database) };
        }

        const valueHashes = new Map();
        for (const key in database) {
            valueHashes.set(key, calculateHash(database[key]));
        }
        return { valueHashes, fullHash: null };
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
                valueHash = calculateHash(database[key]);
                state.valueHashes.set(key, valueHash);
            }
            rootHash += Math.imul(calculateHash(key), PRIME_MULTIPLIER) + valueHash;
        }
        return rootHash >>> 0;
    }

    function hash(database) {
        return compose(database, getState(database));
    }

    // Per-root-key hashes in the same form the client keeps in its
    // hashBlocks, so a 409 can name the keys that diverged instead of only
    // reporting that the whole document did. Fills any missing entries.
    function keyHashes(database) {
        const out = {};
        if (!isObjectRoot(database)) return out;
        const state = getState(database);
        for (const key in database) {
            let valueHash = state.valueHashes.get(key);
            if (valueHash === undefined && !state.valueHashes.has(key)) {
                valueHash = calculateHash(database[key]);
                state.valueHashes.set(key, valueHash);
            }
            out[key] = valueHash;
        }
        return out;
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
            for (const key of keys) {
                if (Object.prototype.hasOwnProperty.call(nextDatabase, key)) {
                    valueHashes.set(key, calculateHash(nextDatabase[key]));
                } else {
                    valueHashes.delete(key);
                }
            }
            nextState = { valueHashes, fullHash: null };
        }

        states.set(nextDatabase, nextState);
        return compose(nextDatabase, nextState);
    }

    return { hash, update, keyHashes };
}

module.exports = {
    createPatchHashCache,
    collectTouchedTopLevelKeys,
    decodePointerSegment,
};

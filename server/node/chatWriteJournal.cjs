'use strict';

const DEFAULT_PREFIX = 'internal/chat-write/v1/';

function pairKey(chaId, chatId) {
    return JSON.stringify([chaId, chatId]);
}

function storageKey(prefix, chaId, chatId) {
    return `${prefix}${Buffer.from(pairKey(chaId, chatId), 'utf8').toString('base64url')}`;
}

function hasChatMetadata(database, chaId, chatId) {
    if (!Array.isArray(database?.characters)) return false;
    const character = database.characters.find((entry) => entry?.chaId === chaId);
    return Array.isArray(character?.chats)
        && character.chats.some((chat) => chat?.id === chatId);
}

/**
 * A small durable write-ahead journal for chat payloads.
 *
 * Chat content is saved before its database.bin stub. The journal makes the
 * server's success response durable without prematurely changing the stripped
 * database (which would invalidate the client's patch hash). Records for a new
 * chat remain until a database persist contains its stub; records for an
 * existing chat can be cleared after the next database persist, including when
 * that persist intentionally deletes the chat.
 */
function createChatWriteJournal({
    kvGet,
    kvSet,
    kvDel,
    kvList,
    encode,
    decode,
    prefix = DEFAULT_PREFIX,
    onInvalid = () => {},
}) {
    const records = new Map();
    let loadPromise = null;
    let loaded = false;

    function isValidRecord(record) {
        return record
            && record.version === 1
            && typeof record.chaId === 'string'
            && record.chaId.length > 0
            && typeof record.chatId === 'string'
            && record.chatId.length > 0
            && record.chat
            && typeof record.chat === 'object'
            && record.chat.id === record.chatId
            && Array.isArray(record.chat.message)
            && typeof record.awaitingMetadata === 'boolean';
    }

    async function ensureLoaded() {
        if (loaded) return;
        if (loadPromise) return loadPromise;
        loadPromise = (async () => {
            for (const key of kvList(prefix)) {
                try {
                    const value = kvGet(key);
                    if (!value) continue;
                    const record = await decode(value);
                    if (!isValidRecord(record)) {
                        onInvalid(key, new Error('invalid chat write journal record'));
                        continue;
                    }
                    records.set(pairKey(record.chaId, record.chatId), {
                        ...record,
                        storageKey: key,
                    });
                } catch (error) {
                    onInvalid(key, error);
                }
            }
            loaded = true;
        })();
        try {
            await loadPromise;
        } finally {
            loadPromise = null;
        }
    }

    async function stage(chaId, chatId, chat, { awaitingMetadata }) {
        await ensureLoaded();
        const key = pairKey(chaId, chatId);
        const previous = records.get(key);
        const record = {
            version: 1,
            chaId,
            chatId,
            chat,
            // Once a payload is waiting for its first stub, later updates must
            // keep waiting until that stub is durably committed.
            awaitingMetadata: previous?.awaitingMetadata === true || awaitingMetadata === true,
            updatedAt: Date.now(),
        };
        if (!isValidRecord(record)) {
            throw new Error('Refusing to journal an invalid chat payload');
        }
        const keyOnDisk = storageKey(prefix, chaId, chatId);
        // Persist before publishing to memory or acknowledging the request.
        kvSet(keyOnDisk, Buffer.from(encode(record)));
        records.set(key, { ...record, storageKey: keyOnDisk });
    }

    async function restoreInto(chatStore) {
        await ensureLoaded();
        for (const record of records.values()) {
            if (!chatStore.has(record.chaId)) {
                chatStore.set(record.chaId, new Map());
            }
            // Journal content is newer than database.bin (or byte-identical if
            // the process died after the DB commit but before journal cleanup).
            chatStore.get(record.chaId).set(record.chatId, record.chat);
        }
    }

    async function clearAfterDatabasePersist(strippedDatabase) {
        await ensureLoaded();
        for (const [key, record] of [...records.entries()]) {
            const metadataCommitted = hasChatMetadata(
                strippedDatabase,
                record.chaId,
                record.chatId,
            );
            if (record.awaitingMetadata && !metadataCommitted) continue;
            try {
                kvDel(record.storageKey);
                records.delete(key);
            } catch (error) {
                // Keeping a byte-identical journal record is safe. It will be
                // replayed on restart and cleanup can succeed on a later flush.
                onInvalid(record.storageKey, error);
            }
        }
    }

    async function isAwaitingMetadata(chaId, chatId) {
        await ensureLoaded();
        return records.get(pairKey(chaId, chatId))?.awaitingMetadata === true;
    }

    function resetMemory() {
        records.clear();
        loaded = false;
        loadPromise = null;
    }

    return {
        prefix,
        ensureLoaded,
        stage,
        restoreInto,
        clearAfterDatabasePersist,
        isAwaitingMetadata,
        resetMemory,
        size: () => records.size,
    };
}

module.exports = {
    DEFAULT_PREFIX,
    createChatWriteJournal,
    hasChatMetadata,
};

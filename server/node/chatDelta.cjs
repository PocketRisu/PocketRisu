'use strict';

const crypto = require('crypto');
const { applyPatch } = require('fast-json-patch');
const { encodeRisuSaveLegacy, normalizeJSON } = require('./utils.cjs');

const MAX_CHAT_PATCH_OPERATIONS = 10_000;
const BLOCKED_POINTER_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const ALLOWED_OPERATIONS = new Set(['add', 'replace', 'remove']);
const CHAT_STUB_FIELDS = new Set(['id', 'name', '_stub', 'lastDate', 'folderId', 'modules']);

function chatRevision(chat) {
    return crypto
        .createHash('sha256')
        .update(Buffer.from(encodeRisuSaveLegacy(chat)))
        .digest('hex');
}

function evaluateChatRevisionPrecondition(chat, baseRevision) {
    const currentRevision = chat ? chatRevision(chat) : null;
    return {
        currentRevision,
        matches: !baseRevision || currentRevision === baseRevision,
    };
}

function evaluateFullChatWritePrecondition(chat, { baseRevision = '', createOnly = false } = {}) {
    const currentRevision = chat ? chatRevision(chat) : null;
    if (createOnly) {
        return {
            currentRevision,
            matches: !chat,
            status: chat ? 412 : null,
            error: chat ? 'Chat already exists' : null,
        };
    }
    if (chat && !baseRevision) {
        return {
            currentRevision,
            matches: false,
            status: 428,
            error: 'A base revision is required to replace an existing chat',
        };
    }
    const matches = !baseRevision ? !chat : currentRevision === baseRevision;
    return {
        currentRevision,
        matches,
        status: matches ? null : 409,
        error: matches ? null : 'Chat revision mismatch',
    };
}

function validatePointer(path) {
    if (typeof path !== 'string' || !path.startsWith('/')) {
        throw new Error('Chat patch paths must be non-root JSON pointers');
    }
    if (/~(?:[^01]|$)/.test(path)) {
        throw new Error('Chat patch contains an invalid JSON pointer escape');
    }
    const segments = path.slice(1).split('/').map((segment) =>
        segment.replace(/~1/g, '/').replace(/~0/g, '~')
    );
    if (segments.some((segment) => BLOCKED_POINTER_SEGMENTS.has(segment))) {
        throw new Error('Chat patch contains a blocked object path');
    }
}

function validateChatPatch(patch) {
    if (!Array.isArray(patch)) throw new Error('Chat patch must be an array');
    if (patch.length > MAX_CHAT_PATCH_OPERATIONS) {
        throw new Error(`Chat patch exceeds ${MAX_CHAT_PATCH_OPERATIONS} operations`);
    }
    for (const operation of patch) {
        if (!operation || typeof operation !== 'object' || !ALLOWED_OPERATIONS.has(operation.op)) {
            throw new Error('Chat patch contains an unsupported operation');
        }
        validatePointer(operation.path);
    }
}

function applyChatDelta(chat, patch, expectedChatId) {
    validateChatPatch(patch);
    const snapshot = normalizeJSON(JSON.parse(JSON.stringify(chat)));
    const result = applyPatch(snapshot, patch, true, true, true).newDocument;

    if (!result || typeof result !== 'object' || !Array.isArray(result.message)) {
        throw new Error('Chat patch produced an invalid chat');
    }
    if (expectedChatId && result.id !== expectedChatId) {
        throw new Error('Chat patch cannot change the chat ID');
    }
    return result;
}

/**
 * A brand-new client may persist the encoder's empty object before runtime
 * defaults create `characters`. Supply only that missing top-level default;
 * explicitly malformed values (null, object, string, etc.) remain untouched so
 * validateStrippedDatabase rejects them instead of silently repairing data.
 */
function canonicalizeStrippedDatabase(database) {
    if (!database || typeof database !== 'object' || Array.isArray(database)) {
        return database;
    }
    if (!Object.prototype.hasOwnProperty.call(database, 'characters')) {
        return { ...database, characters: [] };
    }
    return database;
}

/**
 * Validate the canonical stubs-only database before replacing dbCache.
 *
 * `hasFullChat` is intentionally supplied by the server so this helper stays
 * pure and testable. Chat identity is scoped to a character because the
 * runtime store is Map<chaId, Map<chatId, Chat>>.
 */
function validateStrippedDatabase(database, hasFullChat) {
    if (!database || typeof database !== 'object' || !Array.isArray(database.characters)) {
        throw new Error('Database characters must be an array');
    }
    if (typeof hasFullChat !== 'function') {
        throw new Error('Full-chat lookup is required');
    }

    const characterIds = new Set();
    for (let characterIndex = 0; characterIndex < database.characters.length; characterIndex++) {
        const character = database.characters[characterIndex];
        const chaId = character?.chaId;
        if (typeof chaId !== 'string' || chaId.trim().length === 0) {
            throw new Error(`Character ${characterIndex} has an empty chaId`);
        }
        if (characterIds.has(chaId)) {
            throw new Error(`Duplicate chaId: ${chaId}`);
        }
        characterIds.add(chaId);

        if (!Array.isArray(character.chats)) {
            throw new Error(`Character ${chaId} chats must be an array`);
        }
        const chatIds = new Set();
        for (let chatIndex = 0; chatIndex < character.chats.length; chatIndex++) {
            const chat = character.chats[chatIndex];
            const chatId = chat?.id;
            if (!chat || typeof chat !== 'object' || Array.isArray(chat)) {
                throw new Error(`Character ${chaId} chat ${chatIndex} is invalid`);
            }
            if (typeof chatId !== 'string' || chatId.trim().length === 0) {
                throw new Error(`Character ${chaId} chat ${chatIndex} has an empty id`);
            }
            if (chatIds.has(chatId)) {
                throw new Error(`Character ${chaId} has duplicate chat id: ${chatId}`);
            }
            chatIds.add(chatId);

            if (chat._stub !== true || Array.isArray(chat.message)) {
                throw new Error(`Character ${chaId} chat ${chatId} is not a canonical stub`);
            }
            const unexpectedFields = Object.keys(chat).filter((field) => !CHAT_STUB_FIELDS.has(field));
            if (unexpectedFields.length > 0) {
                throw new Error(
                    `Character ${chaId} chat ${chatId} contains non-stub fields: ${unexpectedFields.join(', ')}`
                );
            }
            if (!hasFullChat(chaId, chatId)) {
                throw new Error(`Character ${chaId} chat ${chatId} has no full-chat payload`);
            }
        }
    }
    return true;
}

module.exports = {
    MAX_CHAT_PATCH_OPERATIONS,
    chatRevision,
    evaluateChatRevisionPrecondition,
    evaluateFullChatWritePrecondition,
    validateChatPatch,
    applyChatDelta,
    canonicalizeStrippedDatabase,
    validateStrippedDatabase,
};

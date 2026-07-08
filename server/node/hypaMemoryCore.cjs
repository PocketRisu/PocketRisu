'use strict';

/**
 * Server-side HypaV3 memory pipeline.
 *
 * Executes the network-bound part of the HypaMemory step inside a backend
 * chat job, so the whole generation — summarization, embedding, memory
 * assembly, then the main completion — runs on the server from the moment
 * the user hits send. The client (src/ts/process/memory/hypav3Backend.ts)
 * precomputes everything that needs client-only context: which chats to
 * summarize (ready-to-send request descriptors via the normal adapter
 * preview path), token counts of existing summaries, query texts/weights,
 * budgets, and the embedding endpoint. This module runs the requests and
 * mirrors the selection algorithm of src/ts/process/memory/hypav3.ts
 * (important → recent → similar → random). Keep the two in sync.
 *
 * Token counts for NEW summaries (text unknown to the client) are computed
 * here — with @dqbd/tiktoken (cl100k_base) when loadable, else a conservative
 * character-based estimate. Both slightly overestimate vs exotic client
 * tokenizers at worst, which only under-fills the memory budget.
 */

const nodeCrypto = require('crypto');
const { logger } = require('./logs.cjs');
const { kvGet, kvSet } = require('./db.cjs');

const EMBED_BATCH_SIZE = 50;
const EMBED_CACHE_PREFIX = 'hypa_embed_cache/';
const SUMMARY_SEPARATOR = '\n\n';

// ─── Tokenizer ───────────────────────────────────────────────────────────────
let tiktokenEncoder = null;
let tiktokenTried = false;

function countTextTokens(text) {
    if (!tiktokenTried) {
        tiktokenTried = true;
        try {
            const { get_encoding } = require('@dqbd/tiktoken');
            tiktokenEncoder = get_encoding('cl100k_base');
        } catch (err) {
            logger.warn('[HypaMemory] tiktoken unavailable, using estimator:', err?.message || err);
        }
    }
    if (tiktokenEncoder) {
        try {
            return tiktokenEncoder.encode(text).length;
        } catch { /* fall through to estimator */ }
    }
    // Conservative estimate (~3 chars/token) so budget fitting never overflows.
    return Math.ceil(text.length / 3);
}

// Mirrors ChatTokenizer.tokenizeChat for a plain system message.
function countSummaryTokens(text, chatAdditionalTokens) {
    return countTextTokens(text + SUMMARY_SEPARATOR) + (chatAdditionalTokens || 0);
}

// ─── Small ports of hypav3.ts helpers (keep in sync) ─────────────────────────
function splitBySeparator(text, separator) {
    try {
        const regexMatch = separator ? separator.match(/^\/(.+)\/([gimuy]*)$/) : null;
        if (regexMatch) {
            const [, pattern, flags] = regexMatch;
            return text.split(new RegExp(pattern, flags));
        }
        return text.split(new RegExp(separator || '\\n\\n'));
    } catch {
        return text.split('\n\n');
    }
}

function wrapWithXml(tag, content) {
    return `<${tag}>\n${content}\n</${tag}>`;
}

function cosineSimilarity(a, b) {
    let dot = 0;
    let magA = 0;
    let magB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom === 0 ? 0 : dot / denom;
}

// Weighted score fusion across per-query ranked lists (hypav3.ts simpleCC).
function simpleCC(scoredLists, weights) {
    const scores = new Map();
    for (let listIndex = 0; listIndex < scoredLists.length; listIndex++) {
        const list = scoredLists[listIndex];
        const weight = weights[listIndex];
        for (const [item, score] of list) {
            scores.set(item, (scores.get(item) || 0) + score * weight);
        }
    }
    return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([item]) => item);
}

// Chunk ranking → parent summary ranking (hypav3.ts childToParentRRF).
function childToParentRRF(rankedChildren, parentFunc, k = 60) {
    const scores = new Map();
    for (let childIndex = 0; childIndex < rankedChildren.length; childIndex++) {
        const parent = parentFunc(rankedChildren[childIndex]);
        const rrfTerm = 1 / (k + childIndex + 1);
        scores.set(parent, (scores.get(parent) || 0) + rrfTerm);
    }
    return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([parent]) => parent);
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
async function postJson(url, headers, body, signal) {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal,
    });
    const text = await response.text();
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`Non-JSON response: ${text.slice(0, 300)}`);
    }
}

// Mirrors hypav3.ts summarize(): OpenAI-compatible completion → cleaned text.
async function runSummarizationTask(task, signal) {
    const json = await postJson(task.url, task.headers, task.body, signal);
    const choice = json.choices?.[0];
    let text = choice?.message?.content ?? choice?.text ?? '';
    if (typeof text !== 'string' || text.trim().length === 0) {
        throw new Error('Empty summary returned');
    }
    text = text.replace(/<Thoughts>[\s\S]*?<\/Thoughts>/g, '').trim();
    text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    if (text.length === 0) {
        throw new Error('Empty summary after removing thoughts content');
    }
    return text;
}

async function runWithConcurrency(tasks, limit, runTask) {
    const results = new Array(tasks.length);
    let nextIndex = 0;
    let firstError = null;
    const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, async () => {
        while (nextIndex < tasks.length && !firstError) {
            const index = nextIndex++;
            try {
                results[index] = await runTask(tasks[index], index);
            } catch (err) {
                firstError = firstError || err;
            }
        }
    });
    await Promise.all(workers);
    if (firstError) throw firstError;
    return results;
}

// ─── Embeddings (with persistent cache) ──────────────────────────────────────
function embedCacheKey(embedding, content) {
    const hash = nodeCrypto.createHash('sha256')
        .update(`${embedding.model || ''}\0${embedding.url}\0${content}`)
        .digest('hex');
    return EMBED_CACHE_PREFIX + hash;
}

function readCachedVector(key) {
    try {
        const raw = kvGet(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw.toString('utf-8'));
        return Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function writeCachedVector(key, vector) {
    try {
        kvSet(key, Buffer.from(JSON.stringify(Array.from(vector))));
    } catch (err) {
        logger.warn('[HypaMemory] Failed to persist embedding cache:', err?.message || err);
    }
}

/**
 * Embeds texts through the OpenAI-compatible embeddings endpoint the client
 * resolved (url/key/model), with a SQLite-backed cache. Returns vectors in
 * input order.
 */
async function embedTexts(embedding, texts, signal) {
    const vectors = new Array(texts.length);
    const toEmbed = [];

    for (let i = 0; i < texts.length; i++) {
        const cached = readCachedVector(embedCacheKey(embedding, texts[i]));
        if (cached) {
            vectors[i] = cached;
        } else {
            toEmbed.push(i);
        }
    }

    for (let start = 0; start < toEmbed.length; start += EMBED_BATCH_SIZE) {
        const batchIndices = toEmbed.slice(start, start + EMBED_BATCH_SIZE);
        const body = {
            input: batchIndices.map((i) => texts[i]),
            ...(embedding.model ? { model: embedding.model } : {}),
        };
        const headers = embedding.key ? { Authorization: `Bearer ${embedding.key}` } : {};
        const json = await postJson(embedding.url, headers, body, signal);
        const data = json?.data;
        if (!Array.isArray(data) || data.length !== batchIndices.length) {
            throw new Error(`Embedding response mismatch: expected ${batchIndices.length} vectors`);
        }
        for (let j = 0; j < batchIndices.length; j++) {
            const vector = data[j]?.embedding;
            if (!Array.isArray(vector)) {
                throw new Error('No embeddings found in the response.');
            }
            vectors[batchIndices[j]] = vector;
            writeCachedVector(embedCacheKey(embedding, texts[batchIndices[j]]), vector);
        }
    }

    return vectors;
}

// ─── Selection (mirrors hypav3.ts important → recent → similar → random) ─────
async function selectSummaries(memory, allSummaries, signal, onProgress) {
    const { budgets, embedding, chunkSeparator, chatAdditionalTokens } = memory;
    let availableMemoryTokens = budgets.availableMemoryTokens;
    const recentMemoryRatio = budgets.recentMemoryRatio;
    const similarMemoryRatio = budgets.similarMemoryRatio;
    const randomMemoryRatio = 1 - recentMemoryRatio - similarMemoryRatio;

    const tokensOf = (summary) => {
        if (typeof summary.tokens === 'number') return summary.tokens;
        summary.tokens = countSummaryTokens(summary.text, chatAdditionalTokens);
        return summary.tokens;
    };

    const selected = [];
    const selectedSet = new Set();
    const pick = (bucket, summary) => {
        selected.push(summary);
        selectedSet.add(summary);
        bucket.push(summary);
    };

    // Important
    const importantPicks = [];
    for (const summary of allSummaries) {
        if (!summary.isImportant) continue;
        const summaryTokens = tokensOf(summary);
        if (summaryTokens > availableMemoryTokens) break;
        pick(importantPicks, summary);
        availableMemoryTokens -= summaryTokens;
    }

    // Recent
    const reservedRecent = Math.floor(availableMemoryTokens * recentMemoryRatio);
    let consumedRecent = 0;
    const recentPicks = [];
    if (recentMemoryRatio > 0) {
        const unused = allSummaries.filter((s) => !selectedSet.has(s));
        for (let i = unused.length - 1; i >= 0; i--) {
            const summaryTokens = tokensOf(unused[i]);
            if (summaryTokens + consumedRecent > reservedRecent) break;
            pick(recentPicks, unused[i]);
            consumedRecent += summaryTokens;
        }
    }

    // Similar
    let reservedSimilar = Math.floor(availableMemoryTokens * similarMemoryRatio);
    let consumedSimilar = 0;
    const similarPicks = [];
    if (similarMemoryRatio > 0 && Array.isArray(memory.queries) && memory.queries.length > 0) {
        if (randomMemoryRatio <= 0) {
            reservedSimilar += reservedRecent - consumedRecent;
        }

        const unused = allSummaries.filter((s) => !selectedSet.has(s));
        const chunks = [];
        for (const summary of unused) {
            const splitted = splitBySeparator(summary.text, chunkSeparator)
                .filter((e) => e.trim().length > 0);
            for (const piece of splitted) {
                chunks.push({ text: piece.trim(), summary });
            }
        }

        if (chunks.length > 0) {
            onProgress?.({ stage: 'embedding', total: chunks.length + memory.queries.length });

            const chunkVectors = await embedTexts(embedding, chunks.map((c) => c.text), signal);
            const queryVectors = await embedTexts(embedding, memory.queries.map((q) => q.content), signal);

            const scoredLists = queryVectors.map((queryVector) =>
                chunks
                    .map((chunk, i) => [chunk, cosineSimilarity(queryVector, chunkVectors[i])])
                    .sort((a, b) => b[1] - a[1])
            );
            const weights = memory.queries.map((q) => q.weight);

            const rankedChunks = simpleCC(scoredLists, weights);
            const rankedSummaries = childToParentRRF(rankedChunks, (chunk) => chunk.summary);

            for (const summary of rankedSummaries) {
                const summaryTokens = tokensOf(summary);
                if (summaryTokens + consumedSimilar > reservedSimilar) break;
                pick(similarPicks, summary);
                consumedSimilar += summaryTokens;
            }
        }
    }

    // Random
    let reservedRandom = Math.floor(availableMemoryTokens * randomMemoryRatio);
    let consumedRandom = 0;
    const randomPicks = [];
    if (randomMemoryRatio > 0) {
        reservedRandom += (reservedRecent - consumedRecent) + (reservedSimilar - consumedSimilar);
        const unused = allSummaries
            .filter((s) => !selectedSet.has(s))
            .sort(() => Math.random() - 0.5);
        for (const summary of unused) {
            const summaryTokens = tokensOf(summary);
            if (summaryTokens + consumedRandom > reservedRandom) continue;
            pick(randomPicks, summary);
            consumedRandom += summaryTokens;
        }
    }

    // Chronological order for the prompt
    selected.sort((a, b) => allSummaries.indexOf(a) - allSummaries.indexOf(b));

    return {
        selected,
        metrics: {
            lastImportantSummaries: importantPicks.map((s) => allSummaries.indexOf(s)),
            lastRecentSummaries: recentPicks.map((s) => allSummaries.indexOf(s)),
            lastSimilarSummaries: similarPicks.map((s) => allSummaries.indexOf(s)),
            lastRandomSummaries: randomPicks.map((s) => allSummaries.indexOf(s)),
        },
    };
}

// ─── Placeholder splice ──────────────────────────────────────────────────────
/**
 * Replaces the client-inserted placeholder with the final memory text across
 * the descriptor body's messages (plain string or multimodal part arrays).
 * Throws when the placeholder is not found — generating without memory would
 * silently drop context.
 */
function spliceMemoryText(body, placeholder, memoryText) {
    let replaced = false;
    const replaceIn = (value) => {
        if (typeof value === 'string' && value.includes(placeholder)) {
            replaced = true;
            return value.split(placeholder).join(memoryText);
        }
        return value;
    };

    if (!Array.isArray(body?.messages)) {
        throw new Error('Memory splice failed: body.messages is not an array');
    }
    for (const message of body.messages) {
        if (typeof message.content === 'string') {
            message.content = replaceIn(message.content);
        } else if (Array.isArray(message.content)) {
            for (const part of message.content) {
                if (part && typeof part.text === 'string') {
                    part.text = replaceIn(part.text);
                }
            }
        }
    }
    if (!replaced) {
        throw new Error('Memory splice failed: placeholder not found in messages');
    }
}

// ─── Pipeline entry ──────────────────────────────────────────────────────────
/**
 * Runs the full memory pipeline for a chat job. Returns
 * { memoryText, updatedMemory } and mutates nothing on the descriptor —
 * the caller splices via spliceMemoryText.
 */
async function runHypaMemoryPipeline(memory, { signal, onProgress } = {}) {
    if (!memory || typeof memory !== 'object') {
        throw new Error('Invalid memory descriptor');
    }

    const existing = Array.isArray(memory.existingSummaries) ? memory.existingSummaries : [];
    const allSummaries = existing.map((s) => ({
        text: s.text,
        chatMemos: Array.isArray(s.chatMemos) ? s.chatMemos : [],
        isImportant: !!s.isImportant,
        categoryId: s.categoryId,
        tags: Array.isArray(s.tags) ? s.tags : [],
        tokens: typeof s.tokens === 'number' ? s.tokens : undefined,
    }));

    // 1. New summaries
    const tasks = Array.isArray(memory.summarizationTasks) ? memory.summarizationTasks : [];
    if (tasks.length > 0) {
        onProgress?.({ stage: 'summarizing', total: tasks.length, done: 0 });
        let done = 0;
        const texts = await runWithConcurrency(
            tasks,
            memory.summarizationConcurrency || 1,
            async (task) => {
                const text = await runSummarizationTask(task, signal);
                done++;
                onProgress?.({ stage: 'summarizing', total: tasks.length, done });
                return text;
            }
        );
        for (let i = 0; i < texts.length; i++) {
            allSummaries.push({
                text: texts[i],
                chatMemos: Array.isArray(tasks[i].chatMemos) ? tasks[i].chatMemos : [],
                isImportant: false,
                categoryId: undefined,
                tags: [],
            });
        }
    }

    // 2. Optional similarity-correction query (default impl's
    //    enableSimilarityCorrection): one more summarization whose output
    //    becomes an extra weighted query.
    const queries = Array.isArray(memory.queries) ? [...memory.queries] : [];
    if (memory.correctionTask) {
        onProgress?.({ stage: 'summarizing-query' });
        const correctionText = await runSummarizationTask(memory.correctionTask, signal);
        queries.push({ content: correctionText, weight: memory.correctionWeight ?? (1 / Math.max(queries.length + 1, 1)) });
    }

    // 3. Selection + memory text
    onProgress?.({ stage: 'selecting' });
    const { selected, metrics } = await selectSummaries(
        { ...memory, queries },
        allSummaries,
        signal,
        onProgress
    );

    const memoryText = wrapWithXml(
        memory.memoryPromptTag || 'Past Events Summary',
        selected.map((s) => s.text).join(SUMMARY_SEPARATOR)
    );

    const updatedMemory = {
        ...(memory.baseData && typeof memory.baseData === 'object' ? memory.baseData : {}),
        summaries: allSummaries.map((s) => ({
            text: s.text,
            chatMemos: s.chatMemos,
            isImportant: s.isImportant,
            categoryId: s.categoryId,
            tags: s.tags,
        })),
        metrics,
    };

    return { memoryText, updatedMemory };
}

module.exports = {
    runHypaMemoryPipeline,
    spliceMemoryText,
    // exported for tests
    splitBySeparator,
    simpleCC,
    childToParentRRF,
    countSummaryTokens,
    embedTexts,
};

import { v4 as uuidv4 } from "uuid";
import { getDatabase, getCurrentChat, type Chat, type character } from "src/ts/storage/database.svelte";
import { type OpenAIChat } from "../index.svelte";
import { type ChatTokenizer } from "src/ts/tokenizer";
import { requestChatData } from "../request/request";
import { resolveChatModelBinding, resolveChatMaxResponseTokens } from "../request/modelPresetBinding";
import { getModelPresetBackendExecutionSupport } from "../../preset/backendExecutionSupport";
import { isLocalNetworkUrl } from "src/ts/network/localNetwork";
import { appendLastPath } from "src/ts/util";
import {
    getCurrentHypaV3Preset, buildSummarizationFormated, wrapWithXml,
    memoryPromptTag, summarySeparator,
    type HypaV3Result, type SerializableHypaV3Data, type SerializableSummary,
} from "./hypav3";
import type { HypaBackendPipeline, HypaBackendSummarizationTask, HypaBackendRequestTask } from "./hypaBackendTypes";

const logPrefix = "[HypaV3Backend]";

export interface HypaV3BackendPlan extends HypaV3Result {
    pipeline: HypaBackendPipeline;
}

/**
 * Plans the HypaV3 memory step for server-side execution inside a backend
 * chat job, instead of running its network calls (summarization LLM requests,
 * embeddings) in the webview.
 *
 * Everything computable without the summary texts is decided here with the
 * client's own tokenizer — batch boundaries, retained chats, token budgets,
 * query texts/weights — mirroring hypav3.ts's bookkeeping (both the default
 * and experimental implementations; keep them in sync). The prompt is then
 * built with a placeholder system message; the server (hypaMemoryCore.cjs)
 * runs the requests, assembles the memory text, and splices it in before the
 * main generation.
 *
 * Returns null whenever backend execution isn't applicable — the caller falls
 * back to the normal client-side hypaMemoryV3 path.
 */
export async function planHypaMemoryV3Backend(
    chats: OpenAIChat[],
    currentTokens: number,
    maxContextTokens: number,
    room: Chat,
    char: character,
    tokenizer: ChatTokenizer
): Promise<HypaV3BackendPlan | null> {
    try {
        return await planInner(chats, currentTokens, maxContextTokens, room, tokenizer);
    } catch (error) {
        console.error(logPrefix, "Planning failed; falling back to client-side memory:", error);
        return null;
    }
}

function resolveEmbeddingEndpoint(): { url: string; key?: string; model?: string } | null {
    const db = getDatabase();
    const model = db.hypaModel;

    if (model === "custom") {
        const rawUrl = db.hypaCustomSettings?.url?.trim();
        if (!rawUrl) return null;
        const url = rawUrl.endsWith("/embeddings") ? rawUrl : appendLastPath(rawUrl, "embeddings");
        return {
            url,
            key: db.hypaCustomSettings?.key?.trim() || undefined,
            model: db.hypaCustomSettings?.model?.trim() || undefined,
        };
    }

    const openaiModels: { [key: string]: string } = {
        ada: "text-embedding-ada-002",
        openai3small: "text-embedding-3-small",
        openai3large: "text-embedding-3-large",
    };
    if (openaiModels[model]) {
        const key = db.supaMemoryKey?.trim();
        if (!key) return null;
        return { url: "https://api.openai.com/v1/embeddings", key, model: openaiModels[model] };
    }

    // Local / contextual models can't run on the server.
    return null;
}

// Mirrors summarize()'s sub-model routing to build a ready-to-send request
// descriptor via the normal adapter preview path. Returns null when the
// resolved request isn't an OpenAI-compatible chat completion the server
// (chatJob.cjs/hypaMemoryCore.cjs) knows how to execute and parse.
async function buildSummarizationTask(oaiMessages: OpenAIChat[]): Promise<HypaBackendRequestTask | null> {
    const db = getDatabase();
    const formated = buildSummarizationFormated(oaiMessages);

    const actualModel = (db.seperateModelsForAxModels && db.seperateModels?.memory)
        ? db.seperateModels.memory
        : db.subModel;
    let subModelUrl = "";
    if (actualModel === "reverse_proxy") {
        subModelUrl = db.forceReplaceUrl ?? "";
    } else if (actualModel?.startsWith("xcustom:::")) {
        subModelUrl = db.customModels?.find((m) => m.id === actualModel)?.url ?? "";
    }

    const response = await requestChatData(
        {
            formated,
            bias: {},
            useStreaming: false,
            noMultiGen: true,
            forceLocalNetwork: isLocalNetworkUrl(subModelUrl),
            previewBody: true,
        },
        "memory"
    );

    if (response.type !== "success") return null;
    let descriptor: { url?: string; body?: any; headers?: { [key: string]: string } };
    try {
        descriptor = JSON.parse(response.result);
    } catch {
        return null;
    }
    if (
        typeof descriptor?.url !== "string" ||
        !descriptor.url.includes("/chat/completions") ||
        !Array.isArray(descriptor.body?.messages)
    ) {
        return null;
    }
    descriptor.body.stream = false;
    return { url: descriptor.url, headers: descriptor.headers ?? {}, body: descriptor.body };
}

async function planInner(
    chats: OpenAIChat[],
    currentTokens: number,
    maxContextTokens: number,
    room: Chat,
    tokenizer: ChatTokenizer
): Promise<HypaV3BackendPlan | null> {
    const db = getDatabase();
    if (!db.useBackendChatJobs || !(globalThis as any).__NODE__) return null;

    const settings = getCurrentHypaV3Preset().settings;
    // Only API summarization (sub model) can run on the server; local WebLLM
    // summarization stays in the browser.
    if (settings.summarizationModel !== "subModel") return null;
    // Consistency error is reported by the client-side path.
    if (settings.recentMemoryRatio + settings.similarMemoryRatio > 1) return null;

    const embedding = resolveEmbeddingEndpoint();
    if (!embedding) return null;

    // The main request must itself be a backend job, or the placeholder would
    // leak into a foreground request. Mirror requestChatDataBackend's gate.
    const binding = resolveChatModelBinding(getCurrentChat(), "model");
    if (binding.kind !== "modelPreset") return null;
    if (!getModelPresetBackendExecutionSupport(binding.preset).supported) return null;

    // ── Bookkeeping mirror of hypav3.ts (Main / MainExp) ─────────────────────
    currentTokens -= resolveChatMaxResponseTokens(room);

    const rawData: SerializableHypaV3Data = room.hypaV3Data
        ? JSON.parse(JSON.stringify(room.hypaV3Data))
        : { summaries: [] };
    rawData.summaries ??= [];

    // Clean orphaned summaries (cleanOrphanedSummary mirror)
    if (!settings.preserveOrphanedMemory) {
        const currentChatMemos = new Set(chats.map((chat) => chat.memo));
        rawData.summaries = rawData.summaries.filter((summary) =>
            (summary.chatMemos ?? []).every((memo) => currentChatMemos.has(memo))
        );
    }

    // Determine starting index
    let startIdx = 0;
    if (rawData.summaries.length > 0) {
        const lastSummary = rawData.summaries.at(-1);
        const lastMemo = (lastSummary.chatMemos ?? []).at(-1);
        const lastChatIndex = chats.findIndex((chat) => chat.memo === lastMemo);
        if (lastChatIndex !== -1) {
            startIdx = lastChatIndex + 1;
            for (const chat of chats.slice(0, lastChatIndex + 1)) {
                currentTokens -= await tokenizer.tokenizeChat(chat);
            }
        }
    }

    // Reserve memory tokens (branching mirrors the two implementations)
    const emptyMemoryTokens = await tokenizer.tokenizeChat({
        role: "system",
        content: wrapWithXml(memoryPromptTag, ""),
    });
    const memoryTokens = Math.floor(maxContextTokens * settings.memoryTokensRatio);
    let availableMemoryTokens: number;

    if (settings.useExperimentalImpl) {
        const shouldReserve = rawData.summaries.length > 0 || currentTokens > maxContextTokens;
        availableMemoryTokens = shouldReserve ? memoryTokens - emptyMemoryTokens : 0;
        if (shouldReserve) currentTokens += memoryTokens;
    } else {
        const shouldReserveEmpty =
            rawData.summaries.length === 0 && currentTokens + emptyMemoryTokens <= maxContextTokens;
        availableMemoryTokens = shouldReserveEmpty ? 0 : memoryTokens - emptyMemoryTokens;
        currentTokens += shouldReserveEmpty ? emptyMemoryTokens : memoryTokens;
    }

    // Collect summarization batches — token math only, so it needs no summary
    // results. Mirrors both implementations' loops.
    const summarizationMode = currentTokens > maxContextTokens;
    const targetTokens = maxContextTokens * (1 - settings.extraSummarizationRatio);
    const toSummarizeArray: OpenAIChat[][] = [];

    const shouldSkip = (chat: OpenAIChat) =>
        chat.name === "example_user" ||
        chat.name === "example_assistant" ||
        chat.memo === "NewChatExample" ||
        chat.memo === "NewChat" ||
        chat.content.trim().length === 0 ||
        (settings.doNotSummarizeUserMessage && chat.role === "user");

    while (summarizationMode) {
        if (currentTokens <= targetTokens) break;
        if (chats.length - startIdx <= settings.queryChatCount) {
            // "Cannot summarize further" — let the client path produce the
            // canonical error message.
            if (currentTokens <= maxContextTokens) break;
            return null;
        }

        const toSummarize: OpenAIChat[] = [];
        let toSummarizeTokens = 0;
        let endIdx: number;

        if (settings.useExperimentalImpl) {
            let currentIndex = startIdx;
            while (
                toSummarize.length < settings.maxChatsPerSummary &&
                currentIndex < chats.length - settings.queryChatCount
            ) {
                const chat = chats[currentIndex];
                toSummarizeTokens += await tokenizer.tokenizeChat(chat);
                if (!shouldSkip(chat)) toSummarize.push(chat);
                currentIndex++;
            }
            endIdx = currentIndex;
        } else {
            endIdx = Math.min(
                startIdx + settings.maxChatsPerSummary,
                chats.length - settings.queryChatCount
            );
            for (let i = startIdx; i < endIdx; i++) {
                const chat = chats[i];
                toSummarizeTokens += await tokenizer.tokenizeChat(chat);
                if (!shouldSkip(chat)) toSummarize.push(chat);
            }
        }

        if (currentTokens <= maxContextTokens && currentTokens - toSummarizeTokens < targetTokens) {
            break;
        }
        if (toSummarize.length > 0) {
            toSummarizeArray.push([...toSummarize]);
        }
        currentTokens -= toSummarizeTokens;
        startIdx = endIdx;
    }

    // Nothing network-bound to defer? Let the trivial client path handle it.
    const willHaveSummaries = rawData.summaries.length > 0 || toSummarizeArray.length > 0;
    const needsEmbedding = willHaveSummaries && settings.similarMemoryRatio > 0;
    if (toSummarizeArray.length === 0 && !needsEmbedding) return null;

    // ── Build request descriptors ────────────────────────────────────────────
    const summarizationTasks: HypaBackendSummarizationTask[] = [];
    for (const batch of toSummarizeArray) {
        const task = await buildSummarizationTask(batch);
        if (!task) {
            console.info(logPrefix, "Sub model request is not server-executable; using client-side memory.");
            return null;
        }
        summarizationTasks.push({ ...task, chatMemos: batch.map((chat) => chat.memo) });
    }

    // Queries for similar-memory selection (weights precomputed per impl)
    const queries: { content: string; weight: number }[] = [];
    let correctionTask: HypaBackendRequestTask | undefined;
    let correctionWeight: number | undefined;

    if (needsEmbedding) {
        const recentChats = chats
            .slice(-settings.queryChatCount)
            .filter((chat) => chat.content.trim().length > 0);

        if (settings.useExperimentalImpl) {
            const positionDenominator = (recentChats.length * (recentChats.length + 1)) / 2;
            recentChats.forEach((chat, index) => {
                const subQueries = chat.content.split("\n\n").filter((e) => e.trim().length > 0);
                const weight = (index + 1) / positionDenominator / subQueries.length;
                for (const content of subQueries) {
                    queries.push({ content, weight });
                }
            });
        } else {
            const useCorrection = settings.enableSimilarityCorrection && recentChats.length > 1;
            const totalLists = recentChats.length + (useCorrection ? 1 : 0);
            const positionDenominator = (totalLists * (totalLists + 1)) / 2;
            recentChats.forEach((chat, index) => {
                queries.push({ content: chat.content, weight: (index + 1) / positionDenominator });
            });
            if (useCorrection) {
                const task = await buildSummarizationTask(recentChats);
                if (!task) {
                    console.info(logPrefix, "Correction request is not server-executable; using client-side memory.");
                    return null;
                }
                correctionTask = task;
                correctionWeight = totalLists / positionDenominator;
            }
        }
    }

    // Existing summaries with client-exact token counts
    const existingSummaries = [] as HypaBackendPipeline["existingSummaries"];
    for (const summary of rawData.summaries) {
        existingSummaries.push({
            text: summary.text,
            chatMemos: summary.chatMemos ?? [],
            isImportant: !!summary.isImportant,
            categoryId: summary.categoryId,
            tags: summary.tags,
            tokens: await tokenizer.tokenizeChat({
                role: "system",
                content: summary.text + summarySeparator,
            }),
        });
    }

    // ChatTokenizer's per-message overhead: empty content tokenizes to exactly
    // that constant.
    const chatAdditionalTokens = await tokenizer.tokenizeChat({ role: "system", content: "" });

    const { summaries: _omit, ...baseData } = rawData;
    const placeholder = `[[hypa-backend-memory:${uuidv4()}]]`;

    const pipeline: HypaBackendPipeline = {
        placeholder,
        memoryPromptTag,
        chatAdditionalTokens,
        chunkSeparator: settings.summaryChunkSeparator,
        summarizationConcurrency: settings.useExperimentalImpl
            ? Math.max(1, settings.summarizationMaxConcurrent || 1)
            : 1,
        summarizationTasks,
        correctionTask,
        correctionWeight,
        existingSummaries,
        queries,
        budgets: {
            availableMemoryTokens,
            recentMemoryRatio: settings.recentMemoryRatio,
            similarMemoryRatio: settings.similarMemoryRatio,
        },
        embedding,
        baseData,
    };

    const newChats: OpenAIChat[] = [
        {
            role: "system",
            content: placeholder,
            memo: "supaMemory",
        },
        ...chats.slice(startIdx),
    ];

    console.log(
        logPrefix,
        "Planned server-side memory:",
        `\nSummarization batches: ${summarizationTasks.length}`,
        `\nExisting summaries: ${existingSummaries.length}`,
        `\nQueries: ${queries.length}`,
        `\nCurrent tokens: ${currentTokens}`
    );

    return {
        currentTokens,
        chats: newChats,
        // Persist the orphan-clean immediately; new summaries and metrics
        // arrive with the job result (updatedMemory).
        memory: rawData,
        pipeline,
    };
}

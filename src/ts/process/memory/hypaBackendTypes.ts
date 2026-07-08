// Shared shapes for the server-side HypaV3 memory pipeline. Dependency-free
// so request.ts / backendJob.ts / hypav3Backend.ts can all import them without
// creating module cycles. The server-side consumer of this payload is
// server/node/hypaMemoryCore.cjs — keep the two in sync.

export interface HypaBackendRequestTask {
    url: string;
    headers: { [key: string]: string };
    body: any;
}

export interface HypaBackendSummarizationTask extends HypaBackendRequestTask {
    chatMemos: string[];
}

export interface HypaBackendExistingSummary {
    text: string;
    chatMemos: string[];
    isImportant: boolean;
    categoryId?: string;
    tags?: string[];
    // Client-exact token count of `text + summarySeparator` as a system chat,
    // so the server never has to re-tokenize summaries it didn't create.
    tokens: number;
}

export interface HypaBackendPipeline {
    placeholder: string;
    memoryPromptTag: string;
    chatAdditionalTokens: number;
    chunkSeparator: string;
    summarizationConcurrency: number;
    summarizationTasks: HypaBackendSummarizationTask[];
    // Optional similarity-correction summarization (default impl's
    // enableSimilarityCorrection): its output becomes one more weighted query.
    correctionTask?: HypaBackendRequestTask;
    correctionWeight?: number;
    existingSummaries: HypaBackendExistingSummary[];
    queries: { content: string; weight: number }[];
    budgets: {
        availableMemoryTokens: number;
        recentMemoryRatio: number;
        similarMemoryRatio: number;
    };
    embedding: { url: string; key?: string; model?: string };
    // Non-summary fields of the chat's HypaV3 data (categories, modal settings)
    // that the server echoes back into updatedMemory unchanged.
    baseData: { [key: string]: any };
}

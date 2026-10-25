// @vitest-environment node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LLMTokenizer } from "./model/types";

const { database, modelTokenizers, providerOptions } = vi.hoisted(() => ({
    database: {
        aiModel: "",
        customTokenizer: "",
        currentPluginProvider: "",
        googleClaudeTokenizing: false,
        useTokenizerCaching: false,
    },
    modelTokenizers: new Map<string, number>(),
    providerOptions: new Map<string, { tokenizer: string }>(),
}));

vi.mock("./storage/database.svelte", () => ({
    getDatabase: () => database,
    getCurrentCharacter: () => null,
}));
vi.mock("./model/modellist", () => ({
    LLMTokenizer,
    getModelInfo: (id: string) => ({ id, internalID: id, tokenizer: modelTokenizers.get(id) ?? LLMTokenizer.Unknown }),
}));
vi.mock("./plugins/plugins.svelte", () => ({
    pluginV2: { providerOptions },
}));
vi.mock("./process/files/inlays", () => ({ supportsInlayImage: () => false }));
vi.mock("./parser/parser.svelte", () => ({ risuChatParser: (data: string) => data }));
vi.mock("./process/models/local", () => ({ tokenizeGGUFModel: async () => [] }));
vi.mock("./globalApi.svelte", () => ({ globalFetch: async () => ({ ok: false }) }));
vi.mock("./storage/persistentKv", () => ({
    makeHashedStorageKey: async (prefix: string, key: string) => prefix + key,
    readPersistentJson: async () => null,
    writePersistentJson: async () => {},
}));

// The UMD bundle exports nothing when Node loads it as an ES module; it
// attaches itself to globalThis.tokenizers instead, and needs a file URL
// location to find its wasm binding.
vi.mock("@mlc-ai/web-tokenizers", async (importOriginal) => {
    vi.stubGlobal("location", { href: "file:///" });
    await importOriginal();
    return (globalThis as unknown as { tokenizers: unknown }).tokenizers;
});

// Vocab files are served from public/ in the app.
vi.stubGlobal("fetch", async (url: string) => {
    const file = await readFile(path.join(process.cwd(), "public", url));
    return {
        arrayBuffer: async () => file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength),
    };
});

import { encode, encodeWithTokenizer } from "./tokenizer";

const sample = "안녕하세요, 오늘은 날씨가 정말 좋네요. 你好，世界。こんにちは。Hello, world!";
const ids = async (tokens: Promise<ArrayLike<number>>) => Array.from(await tokens);

beforeEach(() => {
    database.aiModel = "";
    database.customTokenizer = "";
    database.currentPluginProvider = "";
    database.googleClaudeTokenizing = false;
    modelTokenizers.clear();
    providerOptions.clear();
});

describe("encode tokenizer selection", () => {
    it("counts the llama3 custom tokenizer with the Llama 3 vocab", async () => {
        database.aiModel = "openrouter";
        database.customTokenizer = "llama3";

        const result = await ids(encode(sample));
        expect(result).toEqual(await ids(encodeWithTokenizer(sample, "llama3")));
        expect(result).not.toEqual(await ids(encodeWithTokenizer(sample, "llama")));
    });

    it("counts a plugin provider's llama3 tokenizer with the Llama 3 vocab", async () => {
        database.aiModel = "custom";
        database.currentPluginProvider = "provider";
        providerOptions.set("provider", { tokenizer: "llama3" });

        const result = await ids(encode(sample));
        expect(result).toEqual(await ids(encodeWithTokenizer(sample, "llama3")));
        expect(result).not.toEqual(await ids(encodeWithTokenizer(sample, "llama")));
    });

    it("counts Gemini models with the Gemma 3 vocab", async () => {
        database.aiModel = "gemini-test";
        modelTokenizers.set("gemini-test", LLMTokenizer.GoogleCloud);

        const result = await ids(encode(sample));
        expect(result).toEqual(await ids(encodeWithTokenizer(sample, "gemma")));
        expect(result).not.toEqual(await ids(encodeWithTokenizer(sample, "llama3")));
    });
});

describe("gemma tokenizer", () => {
    it("uses the Gemma 3 vocab", async () => {
        // 9259 "Hello", 1902 "▁world" in the 262k Gemma 3 vocab
        expect(await ids(encodeWithTokenizer("Hello world", "gemma"))).toEqual([9259, 1902]);
    });
});

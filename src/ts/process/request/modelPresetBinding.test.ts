import { describe, expect, test, beforeEach, vi } from 'vitest'

// Mock the database module so resolveChatModelBinding reads a controllable db.
// Only getDatabase is imported at runtime by modelPresetBinding.ts (everything
// else there is type-only), so a minimal factory keeps us off the big import graph.
let mockDb: any
vi.mock('src/ts/storage/database.svelte', () => ({
    getDatabase: () => mockDb,
}))

import {
    resolveChatModelBinding,
    resolvePresetMaxOutputTokens,
    resolveChatMaxResponseTokens,
    applyPromptPresetParams,
} from './modelPresetBinding'
import { emptyModelBinding } from 'src/ts/preset/types'

const PRESET = { id: 'p-main', name: 'Main' } as any

function bindingWith(main?: string) {
    const b = emptyModelBinding()
    if (main !== undefined) b.main = main
    return b
}

beforeEach(() => {
    mockDb = {
        modelPresets: [PRESET],
        nodeOnlyModelModeLock: 'none',
        useModelPresetByDefault: false,
        defaultModelBinding: undefined,
    }
})

describe('resolveChatModelBinding — regime gate', () => {
    test("lock 'none': an undecided existing chat stays classic", () => {
        const chat = { useModelPreset: undefined, modelBinding: undefined } as any
        expect(resolveChatModelBinding(chat, 'model')).toEqual({ kind: 'classic' })
    })

    test("lock 'none': new-chat default does NOT retroactively flip undecided chats (finding 1)", () => {
        mockDb.useModelPresetByDefault = true // user set new-chat default = preset
        const chat = { useModelPreset: undefined, modelBinding: undefined } as any
        // The default is snapshotted at creation, never read here — so an old
        // chat that never chose remains classic.
        expect(resolveChatModelBinding(chat, 'model')).toEqual({ kind: 'classic' })
    })

    test("lock 'none': a chat that explicitly chose preset resolves its own bundle", () => {
        const chat = { useModelPreset: true, modelBinding: bindingWith('p-main') } as any
        expect(resolveChatModelBinding(chat, 'model')).toEqual({ kind: 'modelPreset', preset: PRESET })
    })

    test("lock 'none': preset chat with no bundle blocks (no live default fallback — finding 2)", () => {
        mockDb.defaultModelBinding = bindingWith('p-main') // set, but must NOT leak in
        const chat = { useModelPreset: true, modelBinding: undefined } as any
        expect(resolveChatModelBinding(chat, 'model')).toEqual({ kind: 'block', reason: 'main-unset' })
    })

    test("lock 'legacy': forces classic even when the chat chose preset", () => {
        mockDb.nodeOnlyModelModeLock = 'legacy'
        const chat = { useModelPreset: true, modelBinding: bindingWith('p-main') } as any
        expect(resolveChatModelBinding(chat, 'model')).toEqual({ kind: 'classic' })
    })

    test("lock 'preset': forces preset and falls back to the global default for un-seeded chats", () => {
        mockDb.nodeOnlyModelModeLock = 'preset'
        mockDb.defaultModelBinding = bindingWith('p-main')
        const chat = { useModelPreset: false, modelBinding: undefined } as any
        expect(resolveChatModelBinding(chat, 'model')).toEqual({ kind: 'modelPreset', preset: PRESET })
    })

    test("lock 'preset': blocks when neither the chat nor the global default has a bundle", () => {
        mockDb.nodeOnlyModelModeLock = 'preset'
        const chat = { useModelPreset: false, modelBinding: undefined } as any
        expect(resolveChatModelBinding(chat, 'model')).toEqual({ kind: 'block', reason: 'main-unset' })
    })
})

function presetWith(opts: { schema?: any[]; userValues?: any; defaults?: any } = {}) {
    return {
        id: 'p-main',
        name: 'Main',
        profileSnapshot: { schema: opts.schema ?? [], defaults: opts.defaults },
        userValues: opts.userValues ?? {},
    } as any
}

describe('resolvePresetMaxOutputTokens — output cap comes from the preset, not db.maxResponse', () => {
    test('reads the userValue of the field that maps to body.max_tokens', () => {
        const preset = presetWith({
            schema: [{ key: 'max_tokens', default: 4096, mapsTo: { target: 'body', path: 'max_tokens' } }],
            userValues: { max_tokens: 8192 },
        })
        expect(resolvePresetMaxOutputTokens(preset)).toBe(8192)
    })

    test('falls back to the schema default when the user left the field unset', () => {
        const preset = presetWith({
            schema: [{ key: 'max_tokens', default: 4096, mapsTo: { target: 'body', path: 'max_tokens' } }],
        })
        expect(resolvePresetMaxOutputTokens(preset)).toBe(4096)
    })

    test('matches Gemini-native maxOutputTokens via its nested body path', () => {
        const preset = presetWith({
            schema: [{ key: 'maxOutputTokens', mapsTo: { target: 'body', path: 'generationConfig.maxOutputTokens' } }],
            userValues: { maxOutputTokens: 2048 },
        })
        expect(resolvePresetMaxOutputTokens(preset)).toBe(2048)
    })

    test('returns undefined when no output-token field is declared', () => {
        const preset = presetWith({
            schema: [{ key: 'temperature', mapsTo: { target: 'body', path: 'temperature' } }],
        })
        expect(resolvePresetMaxOutputTokens(preset)).toBeUndefined()
    })

    test('ignores a non-positive or non-numeric value (falls through to undefined)', () => {
        const preset = presetWith({
            schema: [{ key: 'max_tokens', default: 4096, mapsTo: { target: 'body', path: 'max_tokens' } }],
            userValues: { max_tokens: 0 },
        })
        expect(resolvePresetMaxOutputTokens(preset)).toBeUndefined()
    })

    test('legacy snapshot: schema has no output field but defaults carries it (Anthropic 4096)', () => {
        // An Anthropic preset snapshotted before the schema gained max_tokens —
        // the cap lives only in profileSnapshot.defaults.
        const preset = presetWith({
            schema: [{ key: 'apiKey', mapsTo: { target: 'auth', path: 'apiKey' } }],
            defaults: { max_tokens: 4096 },
        })
        expect(resolvePresetMaxOutputTokens(preset)).toBe(4096)
    })

    test('schema output field with no default/userValue falls through to defaults', () => {
        const preset = presetWith({
            schema: [{ key: 'max_tokens', mapsTo: { target: 'body', path: 'max_tokens' } }],
            defaults: { max_tokens: 8192 },
        })
        expect(resolvePresetMaxOutputTokens(preset)).toBe(8192)
    })

    test('defaults fallback resolves a nested Gemini path declared by the schema', () => {
        const preset = presetWith({
            schema: [{ key: 'maxOutputTokens', mapsTo: { target: 'body', path: 'generationConfig.maxOutputTokens' } }],
            defaults: { generationConfig: { maxOutputTokens: 2048 } },
        })
        expect(resolvePresetMaxOutputTokens(preset)).toBe(2048)
    })

    test('user-set value still wins over defaults', () => {
        const preset = presetWith({
            schema: [{ key: 'max_tokens', default: 4096, mapsTo: { target: 'body', path: 'max_tokens' } }],
            userValues: { max_tokens: 16000 },
            defaults: { max_tokens: 4096 },
        })
        expect(resolvePresetMaxOutputTokens(preset)).toBe(16000)
    })
})

describe('resolveChatMaxResponseTokens — the bug: stray legacy db.maxResponse must not leak into preset budgeting', () => {
    test('classic chat uses the global db.maxResponse', () => {
        mockDb.maxResponse = 300
        const chat = { useModelPreset: false, modelBinding: undefined } as any
        expect(resolveChatMaxResponseTokens(chat)).toBe(300)
    })

    test('preset chat uses the preset output cap, NOT the stray legacy db.maxResponse (65535)', () => {
        // db.maxResponse carries a high value imported from a shared prompt
        // preset; the budget must ignore it and reserve the preset's 8192.
        mockDb.maxResponse = 65535
        mockDb.modelPresets = [presetWith({
            schema: [{ key: 'max_tokens', default: 4096, mapsTo: { target: 'body', path: 'max_tokens' } }],
            userValues: { max_tokens: 8192 },
        })]
        const chat = { useModelPreset: true, modelBinding: bindingWith('p-main') } as any
        expect(resolveChatMaxResponseTokens(chat)).toBe(8192)
    })

    test('preset with no output-token field falls back to db.maxResponse', () => {
        mockDb.maxResponse = 500
        mockDb.modelPresets = [presetWith()]
        const chat = { useModelPreset: true, modelBinding: bindingWith('p-main') } as any
        expect(resolveChatMaxResponseTokens(chat)).toBe(500)
    })
})

describe('applyPromptPresetParams — per-chat prompt-preset sampling override', () => {
    const SAMPLING_SCHEMA = [
        { key: 'temperature', default: 0.7, mapsTo: { target: 'body', path: 'temperature' } },
        { key: 'top_p', default: 1, mapsTo: { target: 'body', path: 'top_p' } },
        { key: 'max_tokens', default: 4096, mapsTo: { target: 'body', path: 'max_tokens' } },
    ]

    beforeEach(() => {
        // Classic prompt-preset params as mirrored into db.* by setPreset
        // (temperature / penalties are stored in hundredths).
        mockDb.temperature = 80
        mockDb.top_p = 0.9
        mockDb.top_k = 40
        mockDb.frequencyPenalty = 50
        mockDb.PresensePenalty = -1000 // slider disabled
        mockDb.maxResponse = 65535
    })

    const onChat = { usePromptPresetParams: true } as any

    test('identity when the chat did not opt in', () => {
        const preset = presetWith({ schema: SAMPLING_SCHEMA })
        expect(applyPromptPresetParams(preset, { usePromptPresetParams: false } as any, 'model')).toBe(preset)
        expect(applyPromptPresetParams(preset, {} as any, 'model')).toBe(preset)
        expect(applyPromptPresetParams(preset, undefined, 'model')).toBe(preset)
    })

    test('identity for non-main modes even when opted in', () => {
        const preset = presetWith({ schema: SAMPLING_SCHEMA })
        expect(applyPromptPresetParams(preset, onChat, 'submodel')).toBe(preset)
        expect(applyPromptPresetParams(preset, onChat, 'memory')).toBe(preset)
    })

    test('injects normalized sampling values over userValues without mutating the stored preset', () => {
        const preset = presetWith({
            schema: SAMPLING_SCHEMA,
            userValues: { temperature: 0.2, apiKey: 'k' },
        })
        const out = applyPromptPresetParams(preset, onChat, 'model')
        expect(out).not.toBe(preset)
        expect(out.userValues.temperature).toBe(0.8) // 80 hundredths -> 0.8, beats the editor's 0.2
        expect(out.userValues.top_p).toBe(0.9)
        expect(out.userValues.apiKey).toBe('k') // unrelated values preserved
        expect(preset.userValues).toEqual({ temperature: 0.2, apiKey: 'k' }) // input untouched
    })

    test('schema-gated: params the profile does not declare are not injected (top_k), and output caps never are', () => {
        const preset = presetWith({ schema: SAMPLING_SCHEMA })
        const out = applyPromptPresetParams(preset, onChat, 'model')
        expect(out.userValues).not.toHaveProperty('top_k') // db.top_k=40 but schema lacks it
        expect(out.userValues).not.toHaveProperty('max_tokens') // sampling only, never the output cap
    })

    test('-1000 slider-disabled sentinel is treated as unset', () => {
        const preset = presetWith({
            schema: [
                { key: 'presence_penalty', mapsTo: { target: 'body', path: 'presence_penalty' } },
                { key: 'frequency_penalty', mapsTo: { target: 'body', path: 'frequency_penalty' } },
            ],
        })
        const out = applyPromptPresetParams(preset, onChat, 'model')
        expect(out.userValues).not.toHaveProperty('presence_penalty') // PresensePenalty = -1000
        expect(out.userValues.frequency_penalty).toBe(0.5) // 50 hundredths -> 0.5
    })

    test('wire-flavored alias keys map to the same classic values (Gemini camelCase)', () => {
        const preset = presetWith({
            schema: [
                { key: 'topP', mapsTo: { target: 'body', path: 'generationConfig.topP' } },
                { key: 'topK', mapsTo: { target: 'body', path: 'generationConfig.topK' } },
            ],
        })
        const out = applyPromptPresetParams(preset, onChat, 'model')
        expect(out.userValues.topP).toBe(0.9)
        expect(out.userValues.topK).toBe(40)
    })

    test('non-body mappings are ignored even if the key matches', () => {
        const preset = presetWith({
            schema: [{ key: 'temperature', mapsTo: { target: 'header', path: 'X-Temp' } }],
        })
        expect(applyPromptPresetParams(preset, onChat, 'model')).toBe(preset)
    })

    test('identity when nothing in the schema matches', () => {
        const preset = presetWith({
            schema: [{ key: 'apiKey', mapsTo: { target: 'auth', path: 'apiKey' } }],
        })
        expect(applyPromptPresetParams(preset, onChat, 'model')).toBe(preset)
    })
})

import { describe, expect, test, beforeEach, vi } from 'vitest'

// Mock the database module so resolveChatModelBinding reads a controllable db.
// Only getDatabase is imported at runtime by modelPresetBinding.ts (everything
// else there is type-only), so a minimal factory keeps us off the big import graph.
let mockDb: any
vi.mock('src/ts/storage/database.svelte', () => ({
    getDatabase: () => mockDb,
}))

import { resolveChatModelBinding } from './modelPresetBinding'
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

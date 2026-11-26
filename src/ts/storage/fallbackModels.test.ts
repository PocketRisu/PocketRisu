import { describe, test, expect, vi } from 'vitest'

// Same light mocks as botPresetId.test.ts: the real database.svelte runs.
vi.mock('../stores.svelte', () => {
    const state: { db: any } = { db: {} }
    const noopStore = { subscribe: () => () => {}, set: () => {}, update: () => {} }
    return {
        DBState: state,
        selectedCharID: noopStore,
        selIdState: { selId: -1 },
    }
})
vi.mock('../globalApi.svelte', () => ({
    forageStorage: { realStorage: null },
    downloadFile: () => {},
    saveAsset: () => Promise.resolve(''),
}))
vi.mock('../alert', () => ({
    notifySuccess: () => {},
    notifyWarning: vi.fn(),
    alertError: () => {},
}))
vi.mock('../../lang', () => ({
    language: { recoveredPresetName: 'Recovered Preset', recoveredPresetNotice: 'recovered' },
    changeLanguage: () => {},
}))

const { setDatabase, setPreset, normalizeFallbackModels } = await import('./database.svelte')
const { DBState } = (await import('../stores.svelte')) as any

const empty = { model: [], memory: [], emotion: [], translate: [], otherAx: [] }

describe('fallback models', () => {
    test('a database with only some slots loads instead of throwing', () => {
        // Selecting a hand-made preset left this shape; boot then threw and
        // silently loaded an older snapshot.
        expect(() => setDatabase({ fallbackModels: { model: ['gpt', ''] } } as any)).not.toThrow()
        expect(DBState.db.fallbackModels).toEqual({ ...empty, model: ['gpt'] })
    })

    test('a stored preset with only some slots is filled, a complete one is left as is', () => {
        const complete = { ...empty, model: ['x', ''] }
        setDatabase({ botPresets: [
            { name: 'partial', fallbackModels: { model: ['a', ''] } },
            { name: 'complete', fallbackModels: complete },
            { name: 'none' },
        ] } as any)
        const [partial, kept, none] = DBState.db.botPresets
        expect(partial.fallbackModels).toEqual({ ...empty, model: ['a', ''] })
        expect(kept.fallbackModels).toBe(complete)
        expect(none.fallbackModels).toBeUndefined()
    })

    test('selecting a preset with only some slots fills the rest', () => {
        const db = { NAIsettings: {}, fallbackModels: { ...empty, memory: ['old'] } } as any
        setPreset(db, { fallbackModels: { model: ['a', ''] } } as any)
        // Blanks stay on a preset switch, as before; only boot drops them.
        expect(db.fallbackModels).toEqual({ ...empty, model: ['a', ''] })
    })

    test('normalizes missing or malformed values', () => {
        expect(normalizeFallbackModels(undefined)).toEqual(empty)
        expect(normalizeFallbackModels({ model: 'gpt', memory: null })).toEqual(empty)
        expect(normalizeFallbackModels({ translate: ['x', ''] }, { dropBlank: true })).toEqual({ ...empty, translate: ['x'] })
    })
})

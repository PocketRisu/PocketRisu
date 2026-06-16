import { describe, expect, it, vi } from 'vitest'

// getPersonaPrompt() reads getDatabase() (-> DBState.db) and get(selectedCharID).
// Mock both sources so we can drive the chat's bindedPersona and the global
// personaPrompt independently. selectedCharID must be a real store so the
// module-under-test's `get(selectedCharID)` resolves.
// vi.mock factories are hoisted above imports, so the shared state they close
// over must be created with vi.hoisted().
const mocks = vi.hoisted(() => {
    const { writable } = require('svelte/store')
    return {
        selectedCharID: writable(0),
        dbRef: { db: {} as any },
        selIdState: { selId: -1 },
    }
})

vi.mock(import('./stores.svelte'), () => ({
    selectedCharID: mocks.selectedCharID,
    DBState: mocks.dbRef,
    selIdState: mocks.selIdState,
} as any))
vi.mock(import('./storage/database.svelte'), () => ({
    getDatabase: () => mocks.dbRef.db,
} as any))

import { getPersonaPrompt } from './util'

// Regression guard for the persona-prompt bind bug:
// when a chat has a bindedPersona, getPersonaPrompt() must return that
// persona's prompt — independently of the global DBState.db.personaPrompt.
// The prompt builder gates the personaPrompt block on this function's result,
// so if it fell back to the (empty) global value the block would be dropped.

function setup(opts: {
    globalPersonaPrompt: string
    bindedPersona?: string
    personas?: Array<{ id: string, personaPrompt: string }>
}) {
    mocks.selectedCharID.set(0)
    mocks.dbRef.db = {
        personaPrompt: opts.globalPersonaPrompt,
        personas: opts.personas ?? [],
        characters: [
            {
                chatPage: 0,
                chats: [
                    { bindedPersona: opts.bindedPersona ?? '' },
                ],
            },
        ],
    }
}

describe('getPersonaPrompt', () => {
    it('returns the global personaPrompt when no persona is bound', () => {
        setup({ globalPersonaPrompt: 'global prompt' })
        expect(getPersonaPrompt()).toBe('global prompt')
    })

    it('returns the bound persona prompt even when the global personaPrompt is empty', () => {
        // This is the regressing case: global empty, bound persona non-empty.
        setup({
            globalPersonaPrompt: '',
            bindedPersona: 'p1',
            personas: [{ id: 'p1', personaPrompt: 'bound prompt' }],
        })
        expect(getPersonaPrompt()).toBe('bound prompt')
    })

    it('prefers the bound persona prompt over the global one', () => {
        setup({
            globalPersonaPrompt: 'global prompt',
            bindedPersona: 'p1',
            personas: [{ id: 'p1', personaPrompt: 'bound prompt' }],
        })
        expect(getPersonaPrompt()).toBe('bound prompt')
    })

    it('falls back to the global prompt when bindedPersona id is not found', () => {
        setup({
            globalPersonaPrompt: 'global prompt',
            bindedPersona: 'missing',
            personas: [{ id: 'p1', personaPrompt: 'bound prompt' }],
        })
        expect(getPersonaPrompt()).toBe('global prompt')
    })

    it('returns empty string when global is empty and no persona is bound', () => {
        setup({ globalPersonaPrompt: '' })
        expect(getPersonaPrompt()).toBe('')
    })
})

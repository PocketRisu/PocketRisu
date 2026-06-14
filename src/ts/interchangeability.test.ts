import { describe, expect, it, vi } from 'vitest'
import './polyfill' // registers globalThis.safeStructuredClone used by the converters

// Mock the reactive stores module so its top-level $effect (moduleUpdate -> DB access)
// doesn't run during import — same pattern as modules.test.ts. The converters under
// test don't read DBState; createBlankChar only builds a plain object.
vi.mock(import('src/ts/stores.svelte'), () => ({
    DBState: { db: { characters: [], enabledModules: [], modules: [] } },
    selIdState: { selId: 0 },
} as any))

import {
    convertCharacterToModule,
    convertModuleToCharacter,
    convertCharacterToPersona,
    convertPersonaToCharacter,
} from './interchangeability'
import { createBlankChar } from './characters'

// Data-safety guard for the charx interchangeability layer (#22):
// char <-> module <-> persona conversions must not silently lose user data.

function makeChar() {
    const c = createBlankChar()
    c.name = 'Tester'
    c.desc = 'A friendly test character.'
    c.firstMessage = 'Hello there!'
    c.alternateGreetings = ['Hi!', 'Hey!']
    c.creatorNotes = 'note text'
    c.postHistoryInstructions = 'stay in character'
    c.customscript = [{ comment: 'c1', in: 'a', out: 'b', type: 'editinput' }] as any
    c.globalLore = [{
        key: 'k', secondkey: '', insertorder: 1, comment: 'real lore',
        content: 'lore body', mode: 'normal', alwaysActive: false, selective: false,
    }] as any
    c.lowLevelAccess = true
    c.image = 'asset://icon.png'
    return c
}

describe('interchangeability: character <-> module round-trip', () => {
    it('encodes character fields into a module', () => {
        const c = makeChar()
        const m = convertCharacterToModule(c)
        expect(m.name).toBe('Tester')
        expect(m.description).toBe('note text')
        expect(m.regex).toEqual(c.customscript)
        expect(m.lowLevelAccess).toBe(true)
        // desc / first message / phi encoded as @@indicator lorebook entries
        const contents = (m.lorebook ?? []).map((l) => l.content)
        expect(contents.some((x) => x.startsWith('@@indicator character_desc'))).toBe(true)
        expect(contents.some((x) => x.startsWith('@@indicator character_first_message'))).toBe(true)
        expect(contents.some((x) => x.startsWith('@@indicator phi'))).toBe(true)
        // the real (non-indicator) lore entry is preserved
        expect(contents.some((x) => x === 'lore body')).toBe(true)
    })

    it('round-trips key fields losslessly (char -> module -> char)', () => {
        const c = makeChar()
        const back = convertModuleToCharacter(convertCharacterToModule(c))
        expect(back.name).toBe(c.name)
        expect(back.desc).toBe(c.desc)
        expect(back.firstMessage).toBe(c.firstMessage)
        expect(back.alternateGreetings).toEqual(c.alternateGreetings)
        expect(back.postHistoryInstructions).toBe(c.postHistoryInstructions)
        expect(back.customscript).toEqual(c.customscript)
        expect(back.lowLevelAccess).toBe(c.lowLevelAccess)
        expect(back.image).toBe(c.image) // module icon preserves character image (#21381972)
        // the real lore entry survives; indicator entries are consumed back into fields
        expect(back.globalLore.some((l) => l.content === 'lore body')).toBe(true)
        expect(back.globalLore.some((l) => l.content.startsWith('@@indicator'))).toBe(false)
    })

    it('does not mutate the source character', () => {
        const c = makeChar()
        const loreLenBefore = c.globalLore.length
        convertCharacterToModule(c)
        // converter must clone; source lore length unchanged
        expect(c.globalLore.length).toBe(loreLenBefore)
    })

    it('does not mutate the source module (mirror direction)', () => {
        const m = convertCharacterToModule(makeChar())
        const loreLenBefore = m.lorebook.length
        const indicatorsBefore = m.lorebook.filter((l) => l.content.startsWith('@@indicator')).length
        convertModuleToCharacter(m)
        // the @@indicator consumption splices a clone, not the module's own lorebook
        expect(m.lorebook.length).toBe(loreLenBefore)
        expect(m.lorebook.filter((l) => l.content.startsWith('@@indicator')).length).toBe(indicatorsBefore)
    })
})

describe('interchangeability: character <-> persona round-trip', () => {
    it('round-trips persona core fields (char -> persona -> char)', () => {
        const c = makeChar()
        const back = convertPersonaToCharacter(convertCharacterToPersona(c))
        expect(back.name).toBe(c.name)
        expect(back.desc).toBe(c.desc)
        expect(back.creatorNotes).toBe(c.creatorNotes)
    })
})

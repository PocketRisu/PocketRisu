import { describe, it, expect } from 'vitest'
import { getTogglePinScope } from './togglePinScope'

describe('getTogglePinScope', () => {
    it('covers saved values and the unset keys the template still has', () => {
        const { pinnedKeys, uncoveredKeys } = getTogglePinScope(
            { toggle_a: '1', toggle_orphan: '1' },
            ['toggle_b', 'toggle_gone'],
            ['toggle_a', 'toggle_b', 'toggle_new'],
        )
        // toggle_gone belongs to a module that is off now: loading does not clear it.
        expect([...pinnedKeys].sort()).toEqual(['toggle_a', 'toggle_b', 'toggle_orphan'])
        // toggle_new came after the pin.
        expect(uncoveredKeys).toEqual(['toggle_new'])
    })

    it('lets a shown toggle outside the template in once it has a value', () => {
        // toggle_char is the character's own toggle: never in the template.
        const shown = { keys: ['toggle_a', 'toggle_char'], values: { toggle_a: '1' } as Record<string, string> }
        expect(getTogglePinScope({ toggle_a: '1' }, [], ['toggle_a'], shown).uncoveredKeys).toEqual([])
        shown.values.toggle_char = '1'
        expect(getTogglePinScope({ toggle_a: '1' }, [], ['toggle_a'], shown).uncoveredKeys).toEqual(['toggle_char'])
        // After the update the pin saved it, and it counts as pinned.
        const updated = getTogglePinScope({ toggle_a: '1', toggle_char: '1' }, [], ['toggle_a'], shown)
        expect(updated.uncoveredKeys).toEqual([])
        expect(updated.pinnedKeys.has('toggle_char')).toBe(true)
    })

    it('treats every unsaved toggle of an old pin (no unset keys) as uncovered', () => {
        const { pinnedKeys, uncoveredKeys } = getTogglePinScope(
            { toggle_a: '1' },
            undefined,
            ['toggle_a', 'toggle_b'],
        )
        expect([...pinnedKeys]).toEqual(['toggle_a'])
        expect(uncoveredKeys).toEqual(['toggle_b'])
    })
})

import { describe, expect, test } from 'vitest'
import { listModelCallingModules } from './moduleModelBinding'

function mod(id: string, opts: { lowLevelAccess?: boolean; effects?: string[] } = {}) {
    return {
        id,
        name: id,
        description: '',
        lowLevelAccess: opts.lowLevelAccess,
        trigger: opts.effects
            ? [{ comment: '', type: 'start', conditions: [], effect: opts.effects.map((type) => ({ type })) }]
            : undefined,
    } as any
}

describe('listModelCallingModules', () => {
    test('includes a module whose trigger runs an LLM effect', () => {
        const m = mod('a', { lowLevelAccess: true, effects: ['v2RunLLM'] })
        expect(listModelCallingModules([m])).toEqual([m])
    })

    test('includes a module with a script blob (code is not scanned)', () => {
        const m = mod('a', { lowLevelAccess: true, effects: ['triggerlua'] })
        expect(listModelCallingModules([m])).toEqual([m])
    })

    test('excludes a module without lowLevelAccess — the runtime gate makes an LLM call impossible', () => {
        expect(listModelCallingModules([mod('a', { effects: ['v2RunLLM'] })])).toEqual([])
    })

    test('excludes a module whose triggers only manipulate variables', () => {
        expect(listModelCallingModules([mod('a', { lowLevelAccess: true, effects: ['v2SetVar', 'v2Loop'] })])).toEqual([])
    })

    test('excludes sendAIprompt — it produces the normal chat reply, not a module call', () => {
        expect(listModelCallingModules([mod('a', { lowLevelAccess: true, effects: ['v2SendAIprompt'] })])).toEqual([])
    })

    test('excludes a module with no triggers at all (lorebook/regex only)', () => {
        expect(listModelCallingModules([mod('a', { lowLevelAccess: true })])).toEqual([])
    })

    test('keeps installed order and drops the rest', () => {
        const a = mod('a', { lowLevelAccess: true, effects: ['runLLM'] })
        const b = mod('b', { lowLevelAccess: true, effects: ['v2SetVar'] })
        const c = mod('c', { lowLevelAccess: true, effects: ['triggercode'] })
        expect(listModelCallingModules([a, b, c])).toEqual([a, c])
    })
})

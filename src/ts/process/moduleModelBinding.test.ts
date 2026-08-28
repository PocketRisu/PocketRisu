import { describe, expect, test } from 'vitest'
import {
    getModuleBindingPresetId,
    isLightBoardModule,
    listModelCallingModules,
    migrateModuleBindingKeys,
    resolveModuleRoutingSignature,
} from './moduleModelBinding'

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

    test('includes LightBoard extensions without direct LLM access as binding slots', () => {
        const extension = mod('illustration')
        extension.namespace = 'lb-xnai'
        expect(listModelCallingModules([extension])).toEqual([extension])
    })

    test('keeps namespace-less legacy LightBoard packages visible as binding slots', () => {
        const legacy = mod('legacy')
        legacy.name = '🔦라이트보드 NPC LIST'
        expect(isLightBoardModule(legacy)).toBe(true)
        expect(listModelCallingModules([legacy])).toEqual([legacy])
    })

    test('hides every LightBoard slot when compatibility mode is disabled', () => {
        const base = mod('base', { lowLevelAccess: true, effects: ['runLLM'] })
        base.namespace = 'lightboard'
        const extension = mod('illustration')
        extension.namespace = 'lb-xnai'
        const normal = mod('normal', { lowLevelAccess: true, effects: ['runLLM'] })

        expect(listModelCallingModules([base, extension, normal], false)).toEqual([normal])
    })

    test('keeps installed order and drops the rest', () => {
        const a = mod('a', { lowLevelAccess: true, effects: ['runLLM'] })
        const b = mod('b', { lowLevelAccess: true, effects: ['v2SetVar'] })
        const c = mod('c', { lowLevelAccess: true, effects: ['triggercode'] })
        expect(listModelCallingModules([a, b, c])).toEqual([a, c])
    })
})

describe('module binding identity', () => {
    test('prefers a namespace binding over the legacy UUID binding', () => {
        const module = mod('uuid-1', { lowLevelAccess: true })
        module.namespace = 'lb-xnai'
        expect(getModuleBindingPresetId(module, {
            'uuid-1': 'legacy-preset',
            'namespace:lb-xnai': 'stable-preset',
        })).toBe('stable-preset')
    })

    test('migrates live UUID bindings without deleting orphaned entries', () => {
        const module = mod('uuid-1', { lowLevelAccess: true })
        module.namespace = 'lb-xnai'
        const bindings = { 'uuid-1': 'preset-1', 'old-uuid': 'preset-orphan' }

        expect(migrateModuleBindingKeys([module], bindings)).toBe(true)
        expect(bindings).toEqual({
            'namespace:lb-xnai': 'preset-1',
            'old-uuid': 'preset-orphan',
        })
    })

    test('matches one exact LightBoard routing signature to a module namespace', () => {
        const owner = mod('owner', { lowLevelAccess: true })
        owner.namespace = 'lightboard'
        const illustration = mod('illustration', { lowLevelAccess: true })
        illustration.namespace = 'lb-xnai'

        expect(resolveModuleRoutingSignature(
            owner.id,
            [{ content: 'generated request\n[lb-routing/lb-xnai]' }],
            [owner, illustration],
        )).toBe('illustration')
    })

    test('rejects multiple routing signatures', () => {
        const owner = mod('owner', { lowLevelAccess: true })
        owner.namespace = 'lightboard'
        const illustration = mod('illustration', { lowLevelAccess: true })
        illustration.namespace = 'lb-xnai'

        expect(resolveModuleRoutingSignature(
            owner.id,
            [{ content: '[lb-routing/lb-xnai]\n[lb-routing/lb-news]' }],
            [owner, illustration],
        )).toBeUndefined()
    })

    test('rejects a LightBoard marker from another module owner', () => {
        const owner = mod('owner', { lowLevelAccess: true })
        owner.namespace = 'another-module'
        const illustration = mod('illustration', { lowLevelAccess: true })
        illustration.namespace = 'lb-xnai'

        expect(resolveModuleRoutingSignature(
            owner.id,
            [{ content: '[lb-routing/lb-xnai]' }],
            [owner, illustration],
        )).toBeUndefined()
    })
})

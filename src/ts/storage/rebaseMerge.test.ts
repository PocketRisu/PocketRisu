import { describe, expect, test } from 'vitest'
import { mergeServerDbWithTrackedLocalChanges, withTrackedCharacters, hasAmbiguousCharacterIds } from './rebaseMerge'

const clone = <T,>(value: T): T => structuredClone(value)
const passChats = (chats: any[]) => chats
const chr = (chaId: string, fields: Record<string, any> = {}) => ({ chaId, name: chaId.toUpperCase(), chats: [], ...fields })
const toSave = (over: Partial<{ character: string[]; chat: [string, string][]; botPreset: boolean; modules: boolean }> = {}) => ({
    character: [], chat: [], root: false, botPreset: false, modules: false, plugins: false, pluginCustomStorage: false, ...over,
})

describe('mergeServerDbWithTrackedLocalChanges', () => {
    test('root keys come from local, characters/presets/modules from the server unless tracked', () => {
        const server = { username: 'server', personaPrompt: 'server', botPresets: [{ id: 'sp' }], modules: [{ id: 'sm' }], characters: [chr('a', { desc: 'server' }), chr('b')] } as any
        const local = { username: 'local', personaPrompt: 'local', botPresets: [{ id: 'lp' }], modules: [{ id: 'lm' }], characters: [chr('a', { desc: 'local' }), chr('b')] } as any

        const { mergedDb, skippedArchivedCharIds } = mergeServerDbWithTrackedLocalChanges(server, local, toSave() as any, clone, passChats)
        expect(mergedDb.username).toBe('local')
        expect(mergedDb.botPresets).toEqual([{ id: 'sp' }])
        expect(mergedDb.modules).toEqual([{ id: 'sm' }])
        expect(mergedDb.characters[0].desc).toBe('server')
        expect(skippedArchivedCharIds).toEqual([])
        // Inputs are not mutated.
        expect(server.username).toBe('server')
        expect(local.characters[0].desc).toBe('local')
    })

    test('with a baseline, only root keys this client changed come from local; the rest keep the server value', () => {
        // Device A changed `username` on the server; this device changed
        // `personaPrompt` locally and never touched `username`.
        const baseline = { username: 'old', personaPrompt: 'old', characterOrder: ['a'], characters: [] } as any
        const server = { username: 'from-A', personaPrompt: 'old', characterOrder: ['a', 'b'], characters: [] } as any
        const local = { username: 'old', personaPrompt: 'mine', characterOrder: ['a'], characters: [] } as any
        const { mergedDb } = mergeServerDbWithTrackedLocalChanges(server, local, toSave() as any, clone, passChats, new Set(), baseline)
        expect(mergedDb.username).toBe('from-A')
        expect(mergedDb.personaPrompt).toBe('mine')
        expect(mergedDb.characterOrder).toEqual(['a', 'b'])
        // A key absent from both baseline and local keeps the server value.
        const { mergedDb: m2 } = mergeServerDbWithTrackedLocalChanges({ theme: 'srv', characters: [] } as any, { characters: [] } as any, toSave() as any, clone, passChats, new Set(), { characters: [] } as any)
        expect((m2 as any).theme).toBe('srv')
    })

    test('tracked characters overlay the server copy, are appended when new, and removed when gone locally', () => {
        const server = { characters: [chr('a', { desc: 'server' }), chr('gone')] } as any
        const local = { characters: [chr('a', { desc: 'local' }), chr('new')] } as any
        const { mergedDb } = mergeServerDbWithTrackedLocalChanges(server, local, toSave({ character: ["a", "new", "gone"] }) as any, clone, passChats)
        expect(mergedDb.characters.map((c: any) => [c.chaId, c.desc])).toEqual([['a', 'local'], ['new', undefined]])
    })

    test('tracked chats mark their character as tracked; presets and modules follow their flags', () => {
        const server = { botPresets: [{ id: 'sp' }], botPresetsId: 1, modules: [{ id: 'sm' }], characters: [chr('a', { desc: 'server' })] } as any
        const local = { botPresets: [{ id: 'lp' }], botPresetsId: 2, modules: [{ id: 'lm' }], characters: [chr('a', { desc: 'local' })] } as any
        const { mergedDb } = mergeServerDbWithTrackedLocalChanges(server, local, toSave({ chat: [['a', 'chat-1']], botPreset: true, modules: true }) as any, clone, passChats)
        expect(mergedDb.characters[0].desc).toBe('local')
        expect(mergedDb.botPresets).toEqual([{ id: 'lp' }])
        expect(mergedDb.botPresetsId).toBe(2)
        expect(mergedDb.modules).toEqual([{ id: 'lm' }])
    })

    test('a tracked character the server has deactivated is not put back and is reported', () => {
        const server = { characters: [chr('a')], nodeOnlyArchivedCharacters: [{ chaId: 'b', name: 'B' }] } as any
        const local = { characters: [chr('a'), chr('b', { desc: 'edited here' })] } as any
        const { mergedDb, skippedArchivedCharIds } = mergeServerDbWithTrackedLocalChanges(server, local, toSave({ character: ['b'], chat: [['b', 'chat-1']] }) as any, clone, passChats)
        expect(mergedDb.characters.map((c: any) => c.chaId)).toEqual(['a'])
        expect(mergedDb.nodeOnlyArchivedCharacters).toEqual([{ chaId: 'b', name: 'B' }])
        expect(skippedArchivedCharIds).toEqual(['b'])
    })

    test('an untracked local copy of a deactivated character is simply dropped, without a report', () => {
        const server = { characters: [chr('a')], nodeOnlyArchivedCharacters: [{ chaId: 'b' }] } as any
        const local = { characters: [chr('a'), chr('b')] } as any
        const { mergedDb, skippedArchivedCharIds } = mergeServerDbWithTrackedLocalChanges(server, local, toSave() as any, clone, passChats)
        expect(mergedDb.characters.map((c: any) => c.chaId)).toEqual(['a'])
        expect(skippedArchivedCharIds).toEqual([])
    })
    test("chats of server-sourced characters go through convertChats; overlaid local ones do not", () => {
        const server = { characters: [chr("a", { chats: [{ id: "s", _stub: true }] }), chr("b", { chats: [{ id: "t", _stub: true }] })] } as any
        const local = { characters: [chr("a", { chats: [{ id: "s", message: [] }] })] } as any
        const convert = (chats: any[]) => chats.map((c) => ({ ...c, _stub: undefined, _placeholder: true }))
        const { mergedDb } = mergeServerDbWithTrackedLocalChanges(server, local, toSave({ character: ["a"] }) as any, clone, convert)
        expect(mergedDb.characters[0].chats[0]).toEqual({ id: "s", message: [] })
        expect(mergedDb.characters[1].chats[0]).toMatchObject({ id: "t", _placeholder: true })
        expect(server.characters[1].chats[0]).toEqual({ id: "t", _stub: true })
    })
})

describe('withTrackedCharacters', () => {
    test('unions new chaIds into the tracked list and returns the same object when nothing is new', () => {
        const base = toSave({ character: ['a'] }) as any
        expect(withTrackedCharacters(base, [])).toBe(base)
        expect(withTrackedCharacters(base, ['a'])).toBe(base)
        const widened = withTrackedCharacters(base, ['b', 'a', 'b', ''])
        expect(widened.character).toEqual(['a', 'b'])
        expect(base.character).toEqual(['a'])
    })
})

describe('hasAmbiguousCharacterIds', () => {
    test('unique non-empty ids are fine; a missing, empty, or repeated id is ambiguous', () => {
        expect(hasAmbiguousCharacterIds([chr('a'), chr('b')])).toBe(false)
        expect(hasAmbiguousCharacterIds([])).toBe(false)
        expect(hasAmbiguousCharacterIds([chr('a'), { ...chr('x'), chaId: undefined }])).toBe(true)
        expect(hasAmbiguousCharacterIds([chr('a'), chr('')])).toBe(true)
        expect(hasAmbiguousCharacterIds([chr('a'), chr('a')])).toBe(true)
        expect(hasAmbiguousCharacterIds([chr('a'), null])).toBe(true)
    })
})

describe('mergeServerDbWithTrackedLocalChanges — deactivated-character list', () => {
    const stub = (chaId: string) => ({ chaId, name: chaId.toUpperCase(), archivedAt: 1 })

    test('a character deactivated on another device keeps its server record even though this client never saw it', () => {
        const server = { characters: [chr('a')], nodeOnlyArchivedCharacters: [stub('b')] } as any
        const local = { characters: [chr('a'), chr('b', { desc: 'edited here' })], nodeOnlyArchivedCharacters: [] } as any
        const { mergedDb, skippedArchivedCharIds } = mergeServerDbWithTrackedLocalChanges(server, local, toSave({ character: ['b'] }) as any, clone, passChats)
        expect(mergedDb.characters.map((c: any) => c.chaId)).toEqual(['a'])
        expect(mergedDb.nodeOnlyArchivedCharacters).toEqual([stub('b')])
        expect(skippedArchivedCharIds).toEqual(['b'])
    })

    test('a deactivation in flight on this client is kept: stub added, the server\'s active copy removed', () => {
        const server = { characters: [chr('a'), chr('x')], nodeOnlyArchivedCharacters: [] } as any
        const local = { characters: [chr('a')], nodeOnlyArchivedCharacters: [stub('x')] } as any
        const { mergedDb, skippedArchivedCharIds } = mergeServerDbWithTrackedLocalChanges(server, local, toSave() as any, clone, passChats)
        expect(mergedDb.characters.map((c: any) => c.chaId)).toEqual(['a'])
        expect(mergedDb.nodeOnlyArchivedCharacters).toEqual([stub('x')])
        expect(skippedArchivedCharIds).toEqual([])
    })

    test('an activation in flight on this client wins when this client last saw the character deactivated', () => {
        const server = { characters: [chr('a')], nodeOnlyArchivedCharacters: [stub('y')] } as any
        const local = { characters: [chr('a'), chr('y', { desc: 'chatting after activation' })], nodeOnlyArchivedCharacters: [] } as any
        const { mergedDb, skippedArchivedCharIds } = mergeServerDbWithTrackedLocalChanges(server, local, toSave() as any, clone, passChats, new Set(['y']))
        expect(mergedDb.characters.map((c: any) => [c.chaId, c.desc])).toEqual([['a', undefined], ['y', 'chatting after activation']])
        expect(mergedDb.nodeOnlyArchivedCharacters).toEqual([])
        expect(skippedArchivedCharIds).toEqual([])
    })

    test('the same shape without a baseline record is the deactivated-elsewhere case', () => {
        const server = { characters: [chr('a')], nodeOnlyArchivedCharacters: [stub('y')] } as any
        const local = { characters: [chr('a'), chr('y')], nodeOnlyArchivedCharacters: [] } as any
        const { mergedDb, skippedArchivedCharIds } = mergeServerDbWithTrackedLocalChanges(server, local, toSave({ character: ['y'] }) as any, clone, passChats, new Set())
        expect(mergedDb.characters.map((c: any) => c.chaId)).toEqual(['a'])
        expect(mergedDb.nodeOnlyArchivedCharacters).toEqual([stub('y')])
        expect(skippedArchivedCharIds).toEqual(['y'])
    })

    test('a stale local stub does not undo an activation made on another device', () => {
        const server = { characters: [chr('a'), chr('x', { desc: 'activated and edited elsewhere' })], nodeOnlyArchivedCharacters: [] } as any
        const local = { characters: [chr('a')], nodeOnlyArchivedCharacters: [stub('x')] } as any
        const { mergedDb, skippedArchivedCharIds } = mergeServerDbWithTrackedLocalChanges(server, local, toSave() as any, clone, passChats, new Set(['x']))
        expect(mergedDb.characters.map((c: any) => [c.chaId, c.desc])).toEqual([['a', undefined], ['x', 'activated and edited elsewhere']])
        expect(mergedDb.nodeOnlyArchivedCharacters).toEqual([])
        expect(skippedArchivedCharIds).toEqual([])
    })

    test('a character deleted elsewhere while this client still holds its stub is not resurrected', () => {
        const server = { characters: [chr('a')], nodeOnlyArchivedCharacters: [] } as any
        const local = { characters: [chr('a')], nodeOnlyArchivedCharacters: [stub('x')] } as any
        const { mergedDb } = mergeServerDbWithTrackedLocalChanges(server, local, toSave() as any, clone, passChats, new Set(['x']))
        expect(mergedDb.characters.map((c: any) => c.chaId)).toEqual(['a'])
        expect(mergedDb.nodeOnlyArchivedCharacters).toEqual([])
    })

    test('the local list never overwrites the server list wholesale', () => {
        const server = { characters: [], nodeOnlyArchivedCharacters: [stub('p'), stub('q')] } as any
        const local = { characters: [], nodeOnlyArchivedCharacters: [stub('p')] } as any
        const { mergedDb } = mergeServerDbWithTrackedLocalChanges(server, local, toSave() as any, clone, passChats)
        expect(mergedDb.nodeOnlyArchivedCharacters.map((s: any) => s.chaId)).toEqual(['p', 'q'])
        expect(server.nodeOnlyArchivedCharacters).toHaveLength(2)
    })
})

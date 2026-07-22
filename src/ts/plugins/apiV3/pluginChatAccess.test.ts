import { describe, expect, test, vi } from 'vitest'
import {
    PluginChatAccess,
    type PluginCharacterLike,
    type PluginChatLike,
    type PluginDatabaseLike,
} from './pluginChatAccess'

const fullChat = (id: string, overrides: Partial<PluginChatLike> = {}): PluginChatLike => ({
    id,
    message: [],
    note: '',
    name: id,
    localLore: [],
    ...overrides,
})

const placeholder = (id: string): PluginChatLike => ({
    ...fullChat(id),
    _placeholder: true,
})

const character = (chaId: string, chats: PluginChatLike[]): PluginCharacterLike => ({
    chaId,
    chats,
})

function createHarness(characters: PluginCharacterLike[]) {
    let database: PluginDatabaseLike = { characters }
    const hydrateChat = vi.fn(async (chats: PluginChatLike[], index: number) => {
        const hydrated = fullChat(chats[index].id!, {
            message: [{ role: 'user', data: 'hydrated' }],
        })
        chats[index] = hydrated
        return hydrated
    })
    const normalizeChat = vi.fn((chat: PluginChatLike) => ({
        note: '',
        name: '',
        localLore: [],
        ...chat,
    }))
    const markChatDirty = vi.fn()
    const markCharacterDirty = vi.fn()
    const access = new PluginChatAccess({
        getDatabase: () => database,
        hydrateChat,
        normalizeChat,
        markChatDirty,
        markCharacterDirty,
    })

    return {
        access,
        hydrateChat,
        normalizeChat,
        markChatDirty,
        markCharacterDirty,
        replaceDatabase: (next: PluginDatabaseLike) => { database = next },
    }
}

describe('PluginChatAccess hydration boundary', () => {
    test('hydrates a placeholder before returning a chat to a plugin', async () => {
        const chats = [placeholder('chat-1')]
        const harness = createHarness([character('char-1', chats)])

        const result = await harness.access.getHydratedChatAt(0, 0)

        expect(harness.hydrateChat).toHaveBeenCalledWith(chats, 0, 'char-1')
        expect(result?._placeholder).toBeUndefined()
        expect(result?.message).toEqual([{ role: 'user', data: 'hydrated' }])
    })

    test('does not expose a different chat that takes over the slot during hydration', async () => {
        const chats = [placeholder('chat-1')]
        let release!: () => void
        const gate = new Promise<void>((resolve) => { release = resolve })
        const hydrateChat = vi.fn(async () => {
            await gate
            return fullChat('chat-1')
        })
        const access = new PluginChatAccess({
            getDatabase: () => database,
            hydrateChat,
            normalizeChat: chat => chat,
            markChatDirty: vi.fn(),
            markCharacterDirty: vi.fn(),
        })
        const database: PluginDatabaseLike = {
            characters: [character('char-1', chats)],
        }

        const pending = access.getHydratedChatAt(0, 0)
        chats[0] = fullChat('chat-2')
        release()

        await expect(pending).rejects.toThrow('target changed')
    })

    test('hydrates every placeholder before returning a character or database', async () => {
        const firstChats = [placeholder('chat-1'), fullChat('chat-2')]
        const secondChats = [placeholder('chat-3')]
        const harness = createHarness([
            character('char-1', firstChats),
            character('char-2', secondChats),
        ])

        const hydratedCharacter = await harness.access.getHydratedCharacterAt(0)
        const hydratedDatabase = await harness.access.getHydratedDatabase()

        expect(hydratedCharacter?.chats?.every(chat => !chat._placeholder)).toBe(true)
        expect(hydratedDatabase.characters?.flatMap(char => char.chats ?? [])
            .every(chat => !chat._placeholder)).toBe(true)
        expect(harness.hydrateChat).toHaveBeenCalledTimes(2)
    })

    test('rejects a raw stub instead of presenting it as an empty chat', async () => {
        const harness = createHarness([character('char-1', [{
            id: 'chat-1',
            _stub: true,
        }])])

        await expect(harness.access.getHydratedCharacterAt(0))
            .rejects.toThrow('unhydrated plugin chat')
        expect(harness.hydrateChat).not.toHaveBeenCalled()
    })

    test('rejects a database snapshot if a hydrated character target is replaced', async () => {
        const first = character('char-1', [placeholder('chat-1')])
        const characters = [first]
        let release!: () => void
        const gate = new Promise<void>((resolve) => { release = resolve })
        const database: PluginDatabaseLike = { characters }
        const access = new PluginChatAccess({
            getDatabase: () => database,
            hydrateChat: async (chats, index) => {
                await gate
                const hydrated = fullChat(chats[index].id!)
                chats[index] = hydrated
                return hydrated
            },
            normalizeChat: chat => chat,
            markChatDirty: vi.fn(),
            markCharacterDirty: vi.fn(),
        })

        const pending = access.getHydratedDatabase()
        characters[0] = character('char-1', [fullChat('chat-new')])
        release()

        await expect(pending).rejects.toThrow('character target changed')
    })
})

describe('PluginChatAccess mutation boundary', () => {
    test('replaces an inactive chat by stable identity and explicitly marks it dirty', async () => {
        const chats = [fullChat('chat-1'), placeholder('chat-2')]
        const harness = createHarness([
            character('char-1', [fullChat('other')]),
            character('char-2', chats),
        ])

        await harness.access.replaceChatAt(1, 1, {
            id: 'chat-2',
            message: [{ role: 'assistant', data: 'updated' }],
        })

        expect(chats[1].id).toBe('chat-2')
        expect(chats[1].message).toEqual([{ role: 'assistant', data: 'updated' }])
        expect(chats[1]._placeholder).toBeUndefined()
        expect(harness.markChatDirty).toHaveBeenCalledWith('char-2', 'chat-2')
        expect(harness.markCharacterDirty).toHaveBeenCalledWith('char-2')
    })

    test('does not write or queue dirty state when the chat slot changes while loading', async () => {
        const chats = [placeholder('chat-1')]
        let release!: () => void
        const gate = new Promise<void>((resolve) => { release = resolve })
        const markChatDirty = vi.fn()
        const markCharacterDirty = vi.fn()
        const database: PluginDatabaseLike = {
            characters: [character('char-1', chats)],
        }
        const access = new PluginChatAccess({
            getDatabase: () => database,
            hydrateChat: async () => {
                await gate
                return fullChat('chat-1')
            },
            normalizeChat: chat => chat,
            markChatDirty,
            markCharacterDirty,
        })

        const pending = access.replaceChatAt(0, 0, fullChat('chat-1', {
            message: [{ role: 'assistant', data: 'new' }],
        }))
        chats[0] = fullChat('chat-2')
        release()

        await expect(pending).rejects.toThrow('target changed')
        expect(chats[0].id).toBe('chat-2')
        expect(markChatDirty).not.toHaveBeenCalled()
        expect(markCharacterDirty).not.toHaveBeenCalled()
    })

    test('revalidates selection before committing a current-character replacement', async () => {
        const harness = createHarness([character('char-1', [fullChat('chat-1')])])

        await expect(harness.access.replaceCharacterAt(
            0,
            character('char-1', [fullChat('chat-1')]),
            () => false,
        )).rejects.toThrow('no longer selected')

        expect(harness.markCharacterDirty).not.toHaveBeenCalled()
        expect(harness.markChatDirty).not.toHaveBeenCalled()
    })

    test('marks the character and every full replacement chat dirty', async () => {
        const harness = createHarness([character('char-1', [placeholder('chat-1')])])
        const replacement = character('char-1', [
            fullChat('chat-1'),
            fullChat('chat-2'),
        ])

        await harness.access.replaceCharacterAt(0, replacement)

        expect(harness.markCharacterDirty).toHaveBeenCalledWith('char-1')
        expect(harness.markChatDirty).toHaveBeenCalledWith('char-1', 'chat-1')
        expect(harness.markChatDirty).toHaveBeenCalledWith('char-1', 'chat-2')
    })

    test('rejects placeholder and duplicate identities in database character writes', () => {
        const harness = createHarness([])

        expect(() => harness.access.validateCharacterCollection([
            character('char-1', [placeholder('chat-1')]),
        ])).toThrow('not fully hydrated')

        expect(() => harness.access.validateCharacterCollection([
            character('char-1', [fullChat('chat-1')]),
            character('char-1', [fullChat('chat-2')]),
        ])).toThrow('duplicate character ID')
    })
})

import { describe, expect, it } from 'vitest'
import journalPackage from './chatWriteJournal.cjs'
import deltaPackage from './chatDelta.cjs'

const { createChatWriteJournal } = journalPackage as {
    createChatWriteJournal: (options: any) => {
        prefix: string
        stage: (chaId: string, chatId: string, chat: any, options: { awaitingMetadata: boolean }) => Promise<void>
        restoreInto: (store: Map<string, Map<string, any>>) => Promise<void>
        clearAfterDatabasePersist: (database: any) => Promise<void>
        isAwaitingMetadata: (chaId: string, chatId: string) => Promise<boolean>
        size: () => number
    }
}
const { validateStrippedDatabase } = deltaPackage as {
    validateStrippedDatabase: (
        database: any,
        hasFullChat: (chaId: string, chatId: string) => boolean,
    ) => boolean
}

function makeHarness(kv = new Map<string, Buffer>()) {
    const journal = createChatWriteJournal({
        kvGet: (key: string) => kv.get(key) ?? null,
        kvSet: (key: string, value: Uint8Array) => kv.set(key, Buffer.from(value)),
        kvDel: (key: string) => kv.delete(key),
        kvList: (prefix: string) => [...kv.keys()].filter(key => key.startsWith(prefix)),
        encode: (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8'),
        decode: async (value: Uint8Array) => JSON.parse(Buffer.from(value).toString('utf8')),
    })
    return { journal, kv }
}

function chat(data = 'answer') {
    return {
        id: 'chat-new',
        name: 'New chat',
        message: [{ role: 'char', data }],
        localLore: [],
    }
}

function databaseWithChats(chats: any[]) {
    return {
        characters: [{
            chaId: 'char-1',
            chats,
        }],
    }
}

describe('durable chat write journal', () => {
    it('preserves an ACKed new chat across a stub-less flush and process restart', async () => {
        const { journal, kv } = makeHarness()
        await journal.stage('char-1', 'chat-new', chat(), { awaitingMetadata: true })

        // The 5-second DB flush still has the old stripped DB. It must not
        // retire the only durable copy of the newly-created chat.
        await journal.clearAfterDatabasePersist(databaseWithChats([]))
        expect(journal.size()).toBe(1)
        expect(kv.size).toBe(1)

        // Simulate a process restart after that flush.
        const restarted = makeHarness(kv).journal
        const restoredStore = new Map<string, Map<string, any>>()
        await restarted.restoreInto(restoredStore)
        expect(restoredStore.get('char-1')?.get('chat-new')).toEqual(chat())

        // The later database patch can now add the stub: invariant validation
        // sees the replayed payload instead of rejecting it as an orphan.
        const withStub = databaseWithChats([
            { id: 'chat-new', name: 'New chat', _stub: true },
        ])
        expect(validateStrippedDatabase(
            withStub,
            (chaId, chatId) => !!restoredStore.get(chaId)?.get(chatId),
        )).toBe(true)

        await restarted.clearAfterDatabasePersist(withStub)
        expect(restarted.size()).toBe(0)
        expect(kv.size).toBe(0)
    })

    it('keeps awaiting-metadata state across repeated writes to the new chat', async () => {
        const { journal } = makeHarness()
        await journal.stage('char-1', 'chat-new', chat('first'), { awaitingMetadata: true })
        await journal.stage('char-1', 'chat-new', chat('second'), { awaitingMetadata: false })

        expect(await journal.isAwaitingMetadata('char-1', 'chat-new')).toBe(true)
        const restoredStore = new Map<string, Map<string, any>>()
        await journal.restoreInto(restoredStore)
        expect(restoredStore.get('char-1')?.get('chat-new')?.message[0].data).toBe('second')
    })

    it('clears an existing-chat write after a durable DB persist even when deletion wins', async () => {
        const { journal, kv } = makeHarness()
        await journal.stage('char-1', 'chat-new', chat('updated'), { awaitingMetadata: false })

        // A concurrent metadata save intentionally deleted this existing chat.
        // Its old journal must not resurrect it on a later ID reuse.
        await journal.clearAfterDatabasePersist(databaseWithChats([]))
        expect(journal.size()).toBe(0)
        expect(kv.size).toBe(0)
    })

    it('replays the acknowledged journal value over an older database value', async () => {
        const { journal } = makeHarness()
        await journal.stage('char-1', 'chat-new', chat('newer'), { awaitingMetadata: false })
        const store = new Map([
            ['char-1', new Map([['chat-new', chat('older')]])],
        ])

        await journal.restoreInto(store)
        expect(store.get('char-1')?.get('chat-new')?.message[0].data).toBe('newer')
    })
})

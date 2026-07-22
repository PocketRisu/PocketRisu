import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('src/lang', () => ({ language: {} }))
vi.mock('../alert', () => ({
    alertInput: vi.fn(),
    waitAlert: vi.fn(),
    notifyError: vi.fn(),
}))
vi.mock('./database.svelte', () => ({
    appVer: 'test-app',
    nodeOnlyVer: 'test-node',
    normalizeChat: (chat: any) => chat,
}))
vi.mock('./risuSave', () => ({
    encodeRisuSaveLegacy: (value: unknown) =>
        new TextEncoder().encode(JSON.stringify(value)),
    decodeRisuSave: async (bytes: Uint8Array) =>
        JSON.parse(new TextDecoder().decode(bytes)),
}))

const { ChatConflictError, NodeStorage } = await import('./nodeStorage')

const fakeStartupCache = {
    probe: vi.fn(async () => null),
    resolveNotModified: vi.fn(async () => null),
    storeAuthoritative: vi.fn(async () => ({ rawStored: true, decodedStored: true })),
    recordPatch: vi.fn(async () => 'recorded'),
    invalidate: vi.fn(async () => undefined),
}

function chat(messages: Array<{ role: string, data: string }>) {
    return { id: 'chat-1', name: 'Chat', message: messages }
}

function makeStorage(responses: Array<Response | Error>) {
    const storage = new NodeStorage(fakeStartupCache as any)
    const authFetch = vi.fn(async (
        _input: RequestInfo | URL,
        _init: RequestInit = {},
    ): Promise<Response> => {
        const response = responses.shift()
        if (!response) throw new Error('Unexpected request')
        if (response instanceof Error) throw response
        return response
    })
    ;(storage as any).authFetch = authFetch
    return { storage, authFetch }
}

function seedRevision(storage: InstanceType<typeof NodeStorage>, snapshot: any | null) {
    ;(storage as any).chatSyncStates.set('char-1|chat-1', {
        revision: 'revision-1',
        snapshot,
        encodedBytes: snapshot ? JSON.stringify(snapshot).length : 0,
    })
}

function serverChatResponse(value: unknown, revision: string, status = 200) {
    return new Response(JSON.stringify(value), {
        status,
        headers: {
            'content-type': 'application/octet-stream',
            'x-chat-revision': revision,
        },
    })
}

describe('NodeStorage chat revision safety', () => {
    beforeEach(() => vi.clearAllMocks())

    test('a delta conflict never falls through to a full overwrite', async () => {
        const original = chat([{ role: 'char', data: 'x'.repeat(12_000) }])
        const changed = chat([
            ...original.message,
            { role: 'user', data: 'small append' },
        ])
        const remote = chat([
            ...original.message,
            { role: 'user', data: 'different remote append' },
        ])
        const conflict = new Response(JSON.stringify({
            error: 'Chat revision mismatch',
            currentRevision: 'revision-2',
        }), {
            status: 409,
            headers: {
                'content-type': 'application/json',
                'x-chat-revision': 'revision-2',
            },
        })
        const { storage, authFetch } = makeStorage([
            conflict,
            serverChatResponse(remote, 'revision-2'),
        ])
        seedRevision(storage, original)

        await expect(storage.saveChatContent('char-1', 0, 'chat-1', changed))
            .rejects.toBeInstanceOf(ChatConflictError)
        expect(authFetch).toHaveBeenCalledTimes(2)
        expect(String(authFetch.mock.calls[0]![0])).toContain('/patch')
        expect(String(authFetch.mock.calls[1]![0])).not.toContain('/patch')
    })

    test('a revision-only state uses CAS for a full save', async () => {
        const success = new Response(JSON.stringify({ revision: 'revision-2' }), {
            status: 200,
            headers: {
                'content-type': 'application/json',
                'x-chat-revision': 'revision-2',
            },
        })
        const { storage, authFetch } = makeStorage([success])
        seedRevision(storage, null)

        await storage.saveChatContent(
            'char-1',
            0,
            'chat-1',
            chat([{ role: 'user', data: 'full save' }]),
        )

        const [, request] = authFetch.mock.calls[0]!
        expect((request.headers as Record<string, string>)['x-chat-base-revision'])
            .toBe('revision-1')
        expect(String(authFetch.mock.calls[0]![0])).not.toContain('/patch')
    })

    test('an unsupported delta endpoint falls back once but keeps the base revision', async () => {
        const original = chat([{ role: 'char', data: 'x'.repeat(12_000) }])
        const changed = chat([
            ...original.message,
            { role: 'user', data: 'small append' },
        ])
        const unsupported = new Response('', { status: 405 })
        const success = new Response(JSON.stringify({ revision: 'revision-2' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        })
        const { storage, authFetch } = makeStorage([unsupported, success])
        seedRevision(storage, original)

        await storage.saveChatContent('char-1', 0, 'chat-1', changed)

        expect(authFetch).toHaveBeenCalledTimes(2)
        expect((authFetch.mock.calls[1]![1].headers as Record<string, string>)['x-chat-base-revision'])
            .toBe('revision-1')
    })

    test('recovers a lost delta acknowledgement when a fresh GET matches the desired snapshot', async () => {
        const original = chat([{ role: 'char', data: 'x'.repeat(12_000) }])
        const changed = chat([
            ...original.message,
            { role: 'user', data: 'small append' },
        ])
        const { storage, authFetch } = makeStorage([
            new TypeError('connection reset after commit'),
            serverChatResponse(changed, 'revision-2'),
        ])
        seedRevision(storage, original)

        await expect(storage.saveChatContent('char-1', 0, 'chat-1', changed))
            .resolves.toBeUndefined()
        expect(authFetch).toHaveBeenCalledTimes(2)
        expect(String(authFetch.mock.calls[0]![0])).toContain('/patch')
        expect(String(authFetch.mock.calls[1]![0])).not.toContain('/patch')
        expect((storage as any).chatSyncStates.get('char-1|chat-1').revision)
            .toBe('revision-2')
    })

    test('treats a delta 409 as a lost ACK when the authoritative chat already matches', async () => {
        const original = chat([{ role: 'char', data: 'x'.repeat(12_000) }])
        const changed = chat([
            ...original.message,
            { role: 'user', data: 'small append' },
        ])
        const conflict = new Response(JSON.stringify({
            error: 'Chat revision mismatch',
            currentRevision: 'revision-2',
        }), {
            status: 409,
            headers: { 'content-type': 'application/json' },
        })
        const { storage, authFetch } = makeStorage([
            conflict,
            serverChatResponse(changed, 'revision-2'),
        ])
        seedRevision(storage, original)

        await expect(storage.saveChatContent('char-1', 0, 'chat-1', changed))
            .resolves.toBeUndefined()
        expect(authFetch).toHaveBeenCalledTimes(2)
        expect((storage as any).chatSyncStates.get('char-1|chat-1').revision)
            .toBe('revision-2')
    })

    test('keeps a real delta conflict when the authoritative chat differs', async () => {
        const original = chat([{ role: 'char', data: 'x'.repeat(12_000) }])
        const changed = chat([
            ...original.message,
            { role: 'user', data: 'local append' },
        ])
        const remote = chat([
            ...original.message,
            { role: 'user', data: 'remote append' },
        ])
        const conflict = new Response(JSON.stringify({
            error: 'Chat revision mismatch',
            currentRevision: 'revision-2',
        }), {
            status: 409,
            headers: { 'content-type': 'application/json' },
        })
        const { storage, authFetch } = makeStorage([
            conflict,
            serverChatResponse(remote, 'revision-2'),
        ])
        seedRevision(storage, original)

        await expect(storage.saveChatContent('char-1', 0, 'chat-1', changed))
            .rejects.toBeInstanceOf(ChatConflictError)
        expect(authFetch).toHaveBeenCalledTimes(2)
        expect((storage as any).chatSyncStates.get('char-1|chat-1').revision)
            .toBe('revision-1')
    })

    test('preflights an unknown existing chat and saves it with a seeded revision', async () => {
        const original = chat([{ role: 'char', data: 'server copy' }])
        const changed = chat([{ role: 'char', data: 'local edit' }])
        const success = new Response(JSON.stringify({ revision: 'revision-2' }), {
            status: 200,
            headers: {
                'content-type': 'application/json',
                'x-chat-revision': 'revision-2',
            },
        })
        const { storage, authFetch } = makeStorage([
            serverChatResponse(original, 'revision-1'),
            success,
        ])

        await storage.saveChatContent('char-1', 0, 'chat-1', changed)

        expect(authFetch).toHaveBeenCalledTimes(2)
        const [, saveRequest] = authFetch.mock.calls[1]!
        expect((saveRequest.headers as Record<string, string>)['x-chat-base-revision'])
            .toBe('revision-1')
        expect((saveRequest.headers as Record<string, string>)['if-none-match'])
            .toBeUndefined()
    })

    test('uses an explicit create-only precondition after an authoritative 404', async () => {
        const created = chat([{ role: 'user', data: 'brand new chat' }])
        const success = new Response(JSON.stringify({ revision: 'revision-1' }), {
            status: 200,
            headers: {
                'content-type': 'application/json',
                'x-chat-revision': 'revision-1',
            },
        })
        const { storage, authFetch } = makeStorage([
            new Response('', { status: 404 }),
            success,
        ])

        await storage.saveChatContent('char-1', 0, 'chat-1', created)

        expect(authFetch).toHaveBeenCalledTimes(2)
        const [, saveRequest] = authFetch.mock.calls[1]!
        expect((saveRequest.headers as Record<string, string>)['if-none-match'])
            .toBe('*')
        expect((saveRequest.headers as Record<string, string>)['x-chat-base-revision'])
            .toBeUndefined()
    })

    test('recovers a lost full-save acknowledgement by verifying the server snapshot', async () => {
        const changed = chat([{ role: 'user', data: 'full save' }])
        const { storage, authFetch } = makeStorage([
            new TypeError('connection reset after commit'),
            serverChatResponse(changed, 'revision-2'),
        ])
        seedRevision(storage, null)

        await expect(storage.saveChatContent('char-1', 0, 'chat-1', changed))
            .resolves.toBeUndefined()
        expect(authFetch).toHaveBeenCalledTimes(2)
        expect((storage as any).chatSyncStates.get('char-1|chat-1').revision)
            .toBe('revision-2')
    })
})

describe('NodeStorage startup database revalidation', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        fakeStartupCache.probe.mockResolvedValue(null)
        fakeStartupCache.resolveNotModified.mockResolvedValue(null)
    })

    test('uses a decoded object only after the server confirms its ETag', async () => {
        const cachedDatabase = { characters: [], username: 'cached' }
        fakeStartupCache.probe.mockResolvedValue({ etag: 'db-etag-1', source: 'decoded' } as any)
        fakeStartupCache.resolveNotModified.mockResolvedValue({
            kind: 'decoded',
            etag: 'db-etag-1',
            database: cachedDatabase,
        } as any)
        const { storage, authFetch } = makeStorage([
            new Response(null, { status: 304 }),
        ])

        const loaded = await storage.loadDatabaseForStartup()

        expect(loaded).toMatchObject({
            decoded: cachedDatabase,
            bytes: null,
            etag: 'db-etag-1',
            fromCache: true,
        })
        const request = authFetch.mock.calls[0]![1]
        expect((request.headers as Record<string, string>)['if-none-match'])
            .toBe('db-etag-1')
    })

    test('retries unconditionally when a 304 has no matching cached body', async () => {
        fakeStartupCache.probe.mockResolvedValue({ etag: 'db-etag-1', source: 'raw' } as any)
        fakeStartupCache.resolveNotModified.mockResolvedValue(null)
        const authoritative = new TextEncoder().encode('{"characters":[]}')
        const { storage, authFetch } = makeStorage([
            new Response(null, { status: 304 }),
            new Response(authoritative, {
                status: 200,
                headers: { 'x-db-etag': 'db-etag-2' },
            }),
        ])

        const loaded = await storage.loadDatabaseForStartup()

        expect(authFetch).toHaveBeenCalledTimes(2)
        expect(fakeStartupCache.invalidate).toHaveBeenCalledTimes(1)
        expect(loaded.fromCache).toBe(false)
        expect(loaded.etag).toBe('db-etag-2')
        expect(loaded.bytes).toEqual(authoritative)
        const retryRequest = authFetch.mock.calls[1]![1]
        expect((retryRequest.headers as Record<string, string>)['if-none-match'])
            .toBeUndefined()
    })
})

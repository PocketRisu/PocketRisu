import { describe, expect, test, vi, afterEach } from 'vitest'
import { flushSync } from 'svelte'
import { makeStateProxy, observeReactive } from './proxyFixture.svelte'

// Field-bug pin (2026-07-28 T3-a): recovery filled the message on a RAW chat
// object returned by hydration, invisible to Svelte 5's $state proxy graph —
// no UI update, no save-tracker signal, text lost. These tests run the REAL
// recovery path against a REAL $state proxy plus hydration that mimics
// chatStorage's semantics (assign into the array, RETURN THE RAW OBJECT), so
// the raw-write mistake fails here instead of on a phone.

const mocks = vi.hoisted(() => ({
    db: null as any,
    hydrate: null as any,
    // Captures what the post-slot-in save would serialize — a raw-object write
    // would leave this snapshot empty even when the local reference looks right.
    saved: [] as any[],
}))

vi.mock('src/ts/globalApi.svelte', () => ({
    forageStorage: { createAuth: async () => 'test-auth' },
}))
vi.mock('src/ts/storage/database.svelte', () => ({
    getDatabase: () => mocks.db,
}))
vi.mock('src/ts/storage/chatStorage', () => ({
    ensureChatHydrated: (...args: unknown[]) => mocks.hydrate(...args),
    saveChatToServer: async (chaId: string, index: number, chatId: string, chat: any) => {
        mocks.saved.push({ chaId, index, chatId, chat: JSON.parse(JSON.stringify(chat)) })
    },
}))
vi.mock('src/ts/alert', () => ({
    notifyError: vi.fn(),
    notifyInfo: vi.fn(),
}))
vi.mock('src/ts/log', () => ({
    addLog: vi.fn(),
    // Recovery records the recovered job in the request log, which stamps the
    // client id onto the entry.
    getClientId: vi.fn(() => 'test'),
}))

const OPENAI_SSE =
    'data: {"choices":[{"delta":{"content":"Hello from the journal"}}]}\n\n'
    + 'data: [DONE]\n\n'

function sseStream(body: string): ReadableStream<Uint8Array> {
    const enc = new TextEncoder()
    return new ReadableStream({
        start(c) { c.enqueue(enc.encode(body)); c.close() },
    })
}

function stubServer() {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        if (url.endsWith('/stream')) {
            return new Response(sseStream(OPENAI_SSE), {
                status: 200,
                headers: { 'content-type': 'text/event-stream', 'x-model-job-upstream-status': '200' },
            })
        }
        if (url.endsWith('/claim') && method === 'POST') {
            return new Response('{"success":true}', { status: 200 })
        }
        throw new Error(`unexpected fetch: ${method} ${url}`)
    }))
}

afterEach(() => {
    vi.unstubAllGlobals()
    mocks.saved = []
})

async function loadRecovery() {
    vi.resetModules()
    return await import('./jobRecovery')
}

const JOB = {
    id: 'job-1',
    chatId: 'chat-1',
    generationId: 'gen-1',
    adapterKind: 'openai-compatible',
    streaming: true,
    status: 'done',
    upstreamStatus: 200,
} as any

describe('recovery against a real $state proxy (field-bug pin)', () => {
    test('fill after HYDRATION is visible to the reactive graph and to fresh proxy reads', async () => {
        // Placeholder chat in a REAL $state proxy, exactly like boot.
        mocks.db = makeStateProxy({
            characters: [{
                chaId: 'cha-1', name: 'Rina', chatPage: 0, reloadKeys: 0,
                chats: [{ id: 'chat-1', _placeholder: true, message: [] as any[] }],
            }],
        })
        // Mimic REAL chatStorage semantics: build a fresh RAW object, assign it
        // into the (possibly proxied) array, return the RAW reference.
        mocks.hydrate = (chats: any[], index: number) => {
            const full = {
                id: 'chat-1',
                message: [
                    { role: 'user', data: 'hi', chatId: 'u1' },
                    { role: 'char', data: '', chatId: 'gen-1', generationInfo: { generationId: 'gen-1' } },
                ],
            }
            chats[index] = full
            return Promise.resolve(full)
        }
        stubServer()
        const recovery = await loadRecovery()

        // Reactive observer on the message text — stands in for the UI and the
        // save change-tracker. If the fill writes through the proxy, it
        // re-runs; if it writes the raw object, it never fires (the field bug).
        const obs = observeReactive(() => mocks.db.characters[0]?.chats?.[0]?.message?.[1]?.data ?? '')
        flushSync()
        expect(obs.runs).toBe(1)
        expect(obs.current).toBe('')

        await recovery.recoverTerminalJob(JOB)
        flushSync()

        // Fresh proxy read (what a reload/save would serialize):
        expect(mocks.db.characters[0].chats[0].message[1].data).toBe('Hello from the journal')
        // Reactive visibility (what the UI/save tracker need):
        expect(obs.current).toBe('Hello from the journal')
        expect(obs.runs).toBeGreaterThan(1)
        // Persisted: the save watcher only tracks the ON-SCREEN chat, so
        // recovery has to save this itself or the text dies on the next reload
        // (field bug 2026-07-29).
        expect(mocks.saved).toHaveLength(1)
        expect(mocks.saved[0]).toMatchObject({ chaId: 'cha-1', index: 0, chatId: 'chat-1' })
        expect(mocks.saved[0].chat.message[1].data).toBe('Hello from the journal')
        obs.stop()
    })

    test('insert into a hydrated chat is reactively visible too (T4 shape)', async () => {
        mocks.db = makeStateProxy({
            characters: [{
                chaId: 'cha-1', name: 'Rina', chatPage: 0, reloadKeys: 0,
                chats: [{ id: 'chat-1', _placeholder: true, message: [] as any[] }],
            }],
        })
        mocks.hydrate = (chats: any[], index: number) => {
            const full = { id: 'chat-1', message: [{ role: 'user', data: 'hi', chatId: 'u1' }] }
            chats[index] = full
            return Promise.resolve(full)
        }
        stubServer()
        const recovery = await loadRecovery()

        const obs = observeReactive(() => mocks.db.characters[0]?.chats?.[0]?.message?.length ?? 0)
        flushSync()
        expect(obs.current).toBe(0) // placeholder: hydration hasn't run yet

        await recovery.recoverTerminalJob(JOB)
        flushSync()

        expect(mocks.db.characters[0].chats[0].message).toHaveLength(2)
        expect(mocks.db.characters[0].chats[0].message[1].data).toBe('Hello from the journal')
        expect(obs.current).toBe(2) // reactive observer saw the push
        expect(mocks.saved).toHaveLength(1)
        expect(mocks.saved[0].chat.message).toHaveLength(2)
        obs.stop()
    })
})

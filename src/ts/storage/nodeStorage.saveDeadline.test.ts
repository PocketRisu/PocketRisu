import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../alert', () => ({ alertInput: vi.fn(), waitAlert: vi.fn(), notifyError: vi.fn() }))
vi.mock('./risuSave', () => ({
    decodeRisuSave: vi.fn(async () => ({})),
    encodeRisuSaveLegacy: vi.fn(() => new Uint8Array([1])),
}))
vi.mock('./database.svelte', () => ({ normalizeChat: (chat: any) => chat }))

const { NodeStorage, saveResponseDeadlineMs } = await import('./nodeStorage')

const BASE_MS = saveResponseDeadlineMs(0)
const IDLE_MS = 60_000

function setUpStorage(fetchMock: ReturnType<typeof vi.fn>) {
    ;(NodeStorage as any).sessionInitialized = true
    ;(NodeStorage as any).sessionPending = null
    const storage = new NodeStorage(fetchMock as any, { baseDelayMs: 0, delay: vi.fn(async () => {}), random: () => 1 })
    storage.authChecked = true
    vi.spyOn(storage, 'createAuth').mockResolvedValue('token')
    return storage
}

/** A link that dropped silently and a fetch that ignores the abort. */
const silentFetch = () => vi.fn((_input: any, _init: RequestInit) => new Promise<Response>(() => {}))

/** Headers arrive with a first chunk, then the body never continues. */
function stalledBodyFetch(headers: Record<string, string> = {}, status = 200) {
    return vi.fn(async (_input: any, _init: RequestInit) => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode('{')) },
    }), { status, headers }))
}

function track(promise: Promise<unknown>) {
    const state = { settled: false, error: undefined as unknown }
    promise.then(() => { state.settled = true }, (error) => { state.settled = true; state.error = error })
    return state
}

const requests: [string, (s: any) => Promise<unknown>][] = [
    ['POST /api/patch', (s) => s.patchItem('database/database.bin', { patch: [], expectedHash: 'h' })],
    ['POST /api/write', (s) => s.setItem('database/database.bin', new Uint8Array([1]), 'etag', { saveDeadline: true })],
    ['POST /api/chat-content', (s) => s.saveChatContentDelta('c', 0, 'chat', { message: [] }, null)],
    ['GET /api/read', (s) => s.getItem('database/database.bin', { saveDeadline: true })],
]

describe('save request deadlines (#114)', () => {
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

    for (const [name, run] of requests) {
        test(`${name}: no answer fails after the deadline even when fetch ignores the abort`, async () => {
            const fetchMock = silentFetch()
            const state = track(run(setUpStorage(fetchMock)))
            await vi.advanceTimersByTimeAsync(BASE_MS - 1000)
            expect(state.settled).toBe(false)
            await vi.advanceTimersByTimeAsync(2000)
            expect(state.settled).toBe(true)
            expect((state.error as Error).name).toBe('TimeoutError')
            expect(fetchMock).toHaveBeenCalledTimes(1)
            expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true)
        })

        test(`${name}: a body that stops arriving fails after the idle time`, async () => {
            // A chat save reads its body only for a refused delta.
            const chat = name.includes('chat-content')
            const fetchMock = stalledBodyFetch({}, chat ? 409 : 200)
            const state = track(chat
                ? setUpStorage(fetchMock).saveChatContentDelta('c', 0, 'chat', { message: [] }, { count: 1, fp: 'f' })
                : run(setUpStorage(fetchMock)))
            await vi.advanceTimersByTimeAsync(IDLE_MS - 1000)
            expect(state.settled).toBe(false)
            await vi.advanceTimersByTimeAsync(2000)
            expect(state.settled).toBe(true)
            expect((state.error as Error).name).toBe('TimeoutError')
            expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true)
        })
    }

    const errorAnswers: [string, (s: any) => Promise<unknown>][] = [
        ['POST /api/patch', (s) => s.patchItem('database/database.bin', { patch: [], expectedHash: 'h' })],
        ['POST /api/write', (s) => s.setItem('database/database.bin', new Uint8Array([1]), 'etag', { saveDeadline: true })],
        ['GET /api/read', (s) => s.getItem('database/database.bin', { saveDeadline: true })],
    ]
    for (const [name, run] of errorAnswers) {
        test(`${name}: an error answer whose body stops arriving is reported as no answer`, async () => {
            const state = track(run(setUpStorage(stalledBodyFetch({}, 500))))
            await vi.advanceTimersByTimeAsync(IDLE_MS + 1000)
            expect(state.settled).toBe(true)
            expect((state.error as Error)?.name).toBe('TimeoutError')
        })
    }

    test('a slow download that keeps arriving is not cut off, however long it takes', async () => {
        const chunks = 10
        const fetchMock = vi.fn(async () => {
            let sent = 0
            return new Response(new ReadableStream<Uint8Array>({
                async pull(controller) {
                    if (sent === chunks) { controller.close(); return }
                    await new Promise((resolve) => setTimeout(resolve, 30_000))
                    controller.enqueue(new Uint8Array([sent++]))
                },
            }), { status: 200, headers: { 'x-db-etag': 'server-etag' } })
        })
        const storage = setUpStorage(fetchMock)
        const pending = storage.getItem('database/database.bin', { saveDeadline: true })
        const state = track(pending)
        await vi.advanceTimersByTimeAsync(chunks * 30_000 + 1000)
        expect(state.settled).toBe(true)
        expect(Array.from(await pending)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
        expect(storage._lastDbEtag).toBe('server-etag')
    })

    test('the deadline grows with the upload, up to the server\'s own request timeout', async () => {
        expect(saveResponseDeadlineMs(1024 * 1024)).toBe(BASE_MS + 64_000)
        expect(saveResponseDeadlineMs(500 * 1024 * 1024)).toBe(BASE_MS + 300_000)

        const fetchMock = silentFetch()
        const state = track(setUpStorage(fetchMock).setItem('database/database.bin', new Uint8Array(1024 * 1024), 'etag', { saveDeadline: true }))
        await vi.advanceTimersByTimeAsync(BASE_MS + 63_000)
        expect(state.settled).toBe(false)
        await vi.advanceTimersByTimeAsync(2000)
        expect((state.error as Error).name).toBe('TimeoutError')
    })

    test('a read whose body stalls keeps the etag the client held', async () => {
        const storage = setUpStorage(stalledBodyFetch({ 'x-db-etag': 'foreign' }))
        storage.setDbEtag('mine')
        const state = track(storage.getItem('database/database.bin', { saveDeadline: true }))
        await vi.advanceTimersByTimeAsync(IDLE_MS + 1000)
        expect((state.error as Error).name).toBe('TimeoutError')
        expect(storage._lastDbEtag).toBe('mine')
    })

    test('reads and writes outside the save cycle (boot, assets) get no deadline', async () => {
        const fetchMock = silentFetch()
        const storage = setUpStorage(fetchMock)
        const read = track(storage.getItem('database/database.bin'))
        const write = track(storage.setItem('assets/a.png', new Uint8Array([1])))
        await vi.advanceTimersByTimeAsync(30 * 60_000)
        expect([read.settled, write.settled]).toEqual([false, false])
        expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBeUndefined()
        expect((fetchMock.mock.calls[1][1] as RequestInit).signal).toBeUndefined()
    })

    test('an answer that arrives in time is read as usual', async () => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, etag: 'next' }), { status: 200 }))
        const storage = setUpStorage(fetchMock)
        await expect(storage.patchItem('database/database.bin', { patch: [], expectedHash: 'h' }))
            .resolves.toMatchObject({ success: true, etag: 'next' })
        expect(storage._lastDbEtag).toBe('next')
    })
})

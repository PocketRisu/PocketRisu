import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../alert', () => ({
    alertInput: vi.fn(),
    waitAlert: vi.fn(),
    notifyError: vi.fn(),
}))

vi.mock('./risuSave', () => ({
    decodeRisuSave: vi.fn(async () => ({ id: 'chat-1', message: [] })),
    encodeRisuSaveLegacy: vi.fn(),
}))

vi.mock('./database.svelte', () => ({
    normalizeChat: (chat: any) => chat,
}))

const { NodeStorage } = await import('./nodeStorage')

const TIMEOUT_MS = 30_000

function setUpStorage(fetchMock: ReturnType<typeof vi.fn>) {
    ;(NodeStorage as any).sessionInitialized = true
    ;(NodeStorage as any).sessionPending = null
    const storage = new NodeStorage(fetchMock as any, { baseDelayMs: 0, delay: vi.fn(async () => {}), random: () => 1 })
    storage.authChecked = true
    vi.spyOn(storage, 'createAuth').mockResolvedValue('token')
    return storage
}

/** A fetch that never answers until its signal aborts — a half-open link. */
function hangingFetch() {
    return vi.fn((_input: any, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))
}

function octetResponse() {
    return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'application/octet-stream' } })
}

describe('NodeStorage first-byte timeout on chat-entry GETs', () => {
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

    test('chat content: a hung request is aborted after the timeout and retried once', async () => {
        const fetchMock = vi.fn()
        const hang = hangingFetch()
        fetchMock.mockImplementationOnce(hang).mockResolvedValueOnce(octetResponse())
        const storage = setUpStorage(fetchMock)

        const pending = storage.fetchChatContent('char-1', 0, 'chat-1')
        await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 1)
        await expect(pending).resolves.toEqual({ id: 'chat-1', message: [] })

        expect(fetchMock).toHaveBeenCalledTimes(2)
        expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true)
        expect((fetchMock.mock.calls[1][1] as RequestInit).signal?.aborted).toBe(false)
    })

    test('a second hang is surfaced as the abort error, not retried forever', async () => {
        const fetchMock = vi.fn().mockImplementation(hangingFetch())
        const storage = setUpStorage(fetchMock)

        const pending = storage.fetchChatContent('char-1', 0, 'chat-1')
        const settled = pending.then(() => 'resolved', (error) => error)
        await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 2 + 2)
        const error = await settled
        expect(error).toBeInstanceOf(DOMException)
        expect((error as DOMException).name).toBe('AbortError')
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    test('a hang that ignores the abort signal (auth pre-flight fetches) still times out and retries', async () => {
        const fetchMock = vi.fn()
            .mockImplementationOnce(() => new Promise<Response>(() => {}))
            .mockResolvedValueOnce(octetResponse())
        const storage = setUpStorage(fetchMock)

        const pending = storage.fetchChatContent('char-1', 0, 'chat-1')
        await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 1)
        await expect(pending).resolves.toEqual({ id: 'chat-1', message: [] })
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    test('a prompt response is not aborted after headers arrive, and the timer is cleared', async () => {
        const fetchMock = vi.fn().mockResolvedValueOnce(octetResponse())
        const storage = setUpStorage(fetchMock)

        await expect(storage.fetchChatContent('char-1', 0, 'chat-1')).resolves.toEqual({ id: 'chat-1', message: [] })
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(vi.getTimerCount()).toBe(0)
        expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(false)
    })

    test('manifest pages send the format version and use the same timeout path', async () => {
        const fetchMock = vi.fn()
        fetchMock.mockImplementationOnce(hangingFetch()).mockResolvedValueOnce(
            new Response(JSON.stringify({ total: 0, offset: 0, limit: 500, items: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
        )
        const storage = setUpStorage(fetchMock)

        const pending = storage.getAssetManifestPage({ id: 'm1', version: 1, count: 0, sha256: 'x' }, { offset: 0, limit: 500 })
        await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 1)
        await expect(pending).resolves.toMatchObject({ total: 0 })
        expect(fetchMock).toHaveBeenCalledTimes(2)
        expect(String(fetchMock.mock.calls[1][0])).toBe('/api/asset-manifests/m1?offset=0&limit=500&v=1')
    })
})

import { afterEach, describe, expect, test, vi } from 'vitest'

vi.mock('../alert', () => ({
    alertInput: vi.fn(),
    waitAlert: vi.fn(),
    notifyError: vi.fn(),
}))

vi.mock('./risuSave', () => ({
    decodeRisuSave: vi.fn(),
    encodeRisuSaveLegacy: vi.fn(),
}))

vi.mock('./database.svelte', () => ({
    normalizeChat: (chat: any) => chat,
}))

const { NodeStorage } = await import('./nodeStorage')

const KEY = 'risu-writer-session-id'

function setUpStorage() {
    const storage = new NodeStorage(vi.fn() as any)
    vi.spyOn(storage, 'createAuth').mockResolvedValue('token')
    return storage
}

describe('NodeStorage writer lock claim', () => {
    afterEach(() => {
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
    })

    test('claims for a new id the reload boots with, keeping this page on its old one', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
        vi.stubGlobal('fetch', fetchMock)
        const storage = setUpStorage()
        const current = storage.getSessionId()

        await expect(storage.claimWriterLock()).resolves.toBe(true)

        const [url, init] = fetchMock.mock.calls[0]
        expect(url).toBe('/api/session/claim')
        expect(init.method).toBe('POST')
        const claimed = (init.headers as Record<string, string>)['x-session-id']
        expect(claimed).toBeTruthy()
        expect(claimed).not.toBe(current)
        expect(sessionStorage.getItem(KEY)).toBe(claimed)
        expect(storage.getSessionId()).toBe(current)
    })

    // A page booted from this tab's storage before the server answered (a
    // duplicated tab) must not come up with the id about to become the writer.
    test('stores the new id only once the server took the claim', async () => {
        let answer: (response: Response) => void = () => {}
        vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise<Response>((resolve) => { answer = resolve })))
        const before = sessionStorage.getItem(KEY)
        const claiming = setUpStorage().claimWriterLock()
        await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
        expect(sessionStorage.getItem(KEY)).toBe(before)
        answer(new Response(JSON.stringify({ ok: true }), { status: 200 }))
        await expect(claiming).resolves.toBe(true)
        expect(sessionStorage.getItem(KEY)).not.toBe(before)
    })

    test('reports a refused or failed claim and keeps the stored id, so the reload falls back to the first-action takeover', async () => {
        const before = sessionStorage.getItem(KEY)
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 423 })))
        await expect(setUpStorage().claimWriterLock()).resolves.toBe(false)
        expect(sessionStorage.getItem(KEY)).toBe(before)

        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
        await expect(setUpStorage().claimWriterLock()).resolves.toBe(false)
        expect(sessionStorage.getItem(KEY)).toBe(before)
    })
})

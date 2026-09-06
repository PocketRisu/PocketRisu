import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../alert', () => ({ alertInput: vi.fn(), waitAlert: vi.fn(), notifyError: vi.fn() }))
vi.mock('./risuSave', () => ({ decodeRisuSave: vi.fn(), encodeRisuSaveLegacy: vi.fn() }))
vi.mock('./database.svelte', () => ({ normalizeChat: (chat: any) => chat }))

const { NodeStorage } = await import('./nodeStorage')

function jsonResponse(status: number, body: any = {}) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function setUpStorage(fetchMock: ReturnType<typeof vi.fn>) {
    ;(NodeStorage as any).sessionInitialized = true
    ;(NodeStorage as any).sessionPending = null
    const storage = new NodeStorage(fetchMock as any, { baseDelayMs: 0, delay: vi.fn(async () => {}), random: () => 1 })
    storage.authChecked = true
    vi.spyOn(storage, 'createAuth').mockResolvedValue('token')
    return storage
}

describe('NodeStorage.patchItem on 409', () => {
    beforeEach(() => { vi.restoreAllMocks() })

    test('returns the server etag and diagnostics but keeps the last synced etag', async () => {
        const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(409, {
            error: 'Hash mismatch - data out of sync',
            code: 'HASH_MISMATCH',
            currentEtag: 'server-etag',
            serverHash: 'ab',
            keyHashes: { username: '1' },
            characterHashes: { c1: '2' },
            duplicateCharIds: [],
        }))
        const storage = setUpStorage(fetchMock)
        storage.setDbEtag('synced-etag')

        const result = await storage.patchItem('database/database.bin', { patch: [], expectedHash: 'x' })
        expect(result.success).toBe(false)
        expect(result.etag).toBe('server-etag')
        expect(result.conflictCode).toBe('HASH_MISMATCH')
        expect(result.hashDiagnostics).toEqual({ serverHash: 'ab', keyHashes: { username: '1' }, characterHashes: { c1: '2' }, duplicateCharIds: [] })
        expect((storage as any)._lastDbEtag).toBe('synced-etag')
    })

    test('a 409 without hash fields carries only the code and error', async () => {
        const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(409, {
            error: 'Patch rejected: character x is both active and deactivated',
            code: 'ARCHIVE_GUARD_REJECTED',
            currentEtag: 'e',
        }))
        const storage = setUpStorage(fetchMock)
        const result = await storage.patchItem('database/database.bin', { patch: [], expectedHash: 'x' })
        expect(result).toMatchObject({ success: false, etag: 'e', conflictCode: 'ARCHIVE_GUARD_REJECTED', chatGuardRejected: false })
        expect(result.hashDiagnostics).toBeUndefined()
    })

    test('a successful full write stores the persisted view hashes for one pickup', async () => {
        const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, {
            success: true, etag: 'w', serverHash: 'ff', keyHashes: { a: '1' }, characterHashes: {}, duplicateCharIds: [],
        }))
        const storage = setUpStorage(fetchMock)
        await storage.setItem('database/database.bin', new Uint8Array([1]))
        expect((storage as any)._lastDbEtag).toBe('w')
        expect(storage.takeDbWriteDiagnostics()).toEqual({ serverHash: 'ff', keyHashes: { a: '1' }, characterHashes: {}, duplicateCharIds: [] })
        expect(storage.takeDbWriteDiagnostics()).toBeNull()
    })
})

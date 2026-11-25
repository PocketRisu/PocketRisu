// The autosave loop end to end (#114): the real saveDb, change tracking,
// patcher, rebase and NodeStorage, against a fake server behind fetch that
// follows server.cjs for /api/patch, /api/write and /api/read.
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'

type Db = Record<string, any> & { characters: any[], botPresets: any[], modules: any[] }
// One preset: decoding a full write with none adds a template preset.
const initialDb = (): Db => ({ characters: [], botPresets: [{ id: 'p1', name: 'P' }], modules: [], first: 0, later: 0, remote: 0, items: ['a'] })
// Created per test from the Svelte runtime that test loads (boot resets the
// modules, and effects only track state of their own runtime).
let state: { db: Db }
let tick: () => Promise<void>

// DBState reads through to the current test's state, whichever test the
// mocked module was first loaded for.
vi.doMock('./stores.svelte', async () => ({
    DBState: { get db() { return state.db }, set db(value: Db) { state.db = value } },
    selectedCharID: (await import('svelte/store')).writable(-1),
}))
vi.doMock('./storage/database.svelte', () => ({
    getDatabase: () => state.db,
    setDatabase: (db: Db) => { state.db = db },
    getCurrentCharacter: () => null,
}))
vi.doMock('./alert', () => ({ alertError: vi.fn(), notifyError: vi.fn(), notifyInfo: vi.fn() }))
for (const id of [
    'streamsaver', './plugins/plugins.svelte', './parser/parser.svelte',
    './characterCards', './update', './gui/animation', './gui/colorscheme', './gui/guisize',
    './observer.svelte', './characters', './hotkey', './process/modules', './log', './requestLog',
]) vi.doMock(id, () => ({}))
vi.doMock('./util', () => ({ sleep: (ms: number) => new Promise(r => setTimeout(r, ms)) }))
vi.doMock('./platform', () => ({ supportsPatchSync: true }))

type Route = 'patch' | 'write' | 'read'
/**
 * hang: no answer (the link dropped); the request ends only when aborted.
 * apply-then-hang: the server applies the write, then the answer is lost.
 * network-error: fetch rejects (authFetch retries it up to three times).
 * own-conflict: /api/patch refuses the client's own revision (hash diverged),
 * which sends the save to the full-write fallback.
 */
type Fault = 'hang' | 'apply-then-hang' | 'network-error' | 'own-conflict'

async function fakeServer(start: Db) {
    const { calculateHash, decodeRisuSave, encodeRisuSaveLegacy } = await import('./storage/risuSave')
    const { applyPatch } = await import('fast-json-patch')
    const server = { db: structuredClone(start), etag: 'e0', rev: 0 }
    const faults: Record<Route, Fault[]> = { patch: [], write: [], read: [] }
    const calls: { route: Route, fault?: Fault, ifMatch?: string | null }[] = []
    const bump = () => { server.etag = `e${++server.rev}` }
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    const hang = (init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
    })
    async function answer(route: Route, fault: Fault | undefined, init: RequestInit): Promise<Response> {
        if (route === 'patch') {
            const body = JSON.parse(String(init.body))
            if (fault === 'own-conflict' || body.expectedHash !== calculateHash(server.db).toString(16)) {
                return json(409, { error: 'hash mismatch', currentEtag: server.etag })
            }
            if (body.patch.length > 0) {
                applyPatch(server.db, body.patch, true)
                bump()
            }
            return json(200, { success: true, etag: server.etag })
        }
        if (route === 'write') {
            const ifMatch = new Headers(init.headers).get('x-if-match')
            if (ifMatch && ifMatch !== server.etag) return json(409, { error: 'conflict', currentEtag: server.etag })
            server.db = await decodeRisuSave(init.body as Uint8Array) as Db
            bump()
            return json(200, { success: true, etag: server.etag })
        }
        return new Response(encodeRisuSaveLegacy(server.db), {
            status: 200,
            headers: { 'content-type': 'application/octet-stream', 'x-db-etag': server.etag },
        })
    }
    async function fetchImpl(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
        const url = String(input)
        const route: Route | null = url.startsWith('/api/patch') ? 'patch'
            : url.startsWith('/api/write') ? 'write'
            : url.startsWith('/api/read') ? 'read'
            : null
        if (!route) return json(404, { error: `unexpected ${url}` })
        const fault = faults[route].shift()
        calls.push({ route, fault, ifMatch: new Headers(init.headers).get('x-if-match') })
        if (fault === 'hang') return hang(init)
        if (fault === 'network-error') throw new TypeError('Failed to fetch')
        const response = await answer(route, fault, init)
        if (fault === 'apply-then-hang') return hang(init)
        return response
    }
    /** Another device saves a change. */
    const foreign = (mutate: (db: Db) => void) => { mutate(server.db); bump() }
    return { server, faults, calls, fetchImpl, foreign }
}

async function boot(start: Db = initialDb()) {
    vi.resetModules()
    state = (await import('svelte/internal/client')).proxy({ db: structuredClone(start) })
    tick = (await import('svelte')).tick
    const api = await import('./globalApi.svelte')
    const fake = await fakeServer(start)
    globalThis.fetch = fake.fetchImpl as typeof fetch
    await api.forageStorage.Init()
    const storage = api.forageStorage.realStorage as any
    storage.constructor.sessionInitialized = true
    storage.constructor.sessionPending = null
    storage.authChecked = true
    vi.spyOn(storage, 'createAuth').mockResolvedValue('token')
    api.forageStorage.setDbEtag('e0')
    void api.saveDb()
    await tick()
    await vi.advanceTimersByTimeAsync(0)
    return { api, fake }
}

async function edit(change: (db: Db) => void) {
    change(state.db)
    await tick()
    // debounce (500 ms) + the loop's 200 ms poll
    await vi.advanceTimersByTimeAsync(1000)
    await vi.dynamicImportSettled()
}

/** Advance virtual time until the promise settles; fail past maxMs. */
async function settle<T>(promise: Promise<T>, maxMs = 10 * 60_000): Promise<T> {
    let done = false
    promise.then(() => { done = true }, () => { done = true })
    for (let elapsed = 0; !done && elapsed < maxMs; elapsed += 1000) {
        await vi.advanceTimersByTimeAsync(1000)
        await vi.dynamicImportSettled()
    }
    if (!done) throw new Error(`did not settle within ${maxMs} ms of virtual time`)
    return promise
}

const originalFetch = globalThis.fetch

beforeAll(() => {
    // Instances left over from earlier tests must not see this one's saves.
    ;(window as any).BroadcastChannel = undefined
})

afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
})

describe('autosave failure path (#114)', () => {
    test('a patch that failed before reaching the server is sent again when another device saved meanwhile', async () => {
        vi.useFakeTimers()
        const { api, fake } = await boot()
        fake.foreign((db) => { db.remote = 2 })
        // authFetch retries a network error three times; all four fail.
        fake.faults.patch.push('network-error', 'network-error', 'network-error', 'network-error')
        await edit((db) => { db.first = 1 })
        await settle(new Promise((r) => setTimeout(r, 10_000)))
        await edit((db) => { db.later = 1 })

        expect(await settle(api.flushSaves())).toBe(true)
        expect(fake.server.db).toMatchObject({ first: 1, later: 1, remote: 2 })
        expect(state.db).toMatchObject({ first: 1, later: 1, remote: 2 })
    })

    test('the retry also carries the failed attempt\'s character and module edits, not only root keys', async () => {
        vi.useFakeTimers()
        const start = {
            ...initialDb(),
            characters: [{ chaId: 'c1', name: 'A', chats: [] }],
            modules: [{ id: 'm1', name: 'M', lorebook: [] }],
        }
        const { api, fake } = await boot(start)
        fake.foreign((db) => { db.remote = 2 })
        fake.faults.patch.push('network-error', 'network-error', 'network-error', 'network-error')
        await edit((db) => { db.characters[0].name = 'B'; db.modules[0].name = 'N'; db.first = 1 })
        await settle(new Promise((r) => setTimeout(r, 10_000)))

        expect(await settle(api.flushSaves())).toBe(true)
        expect(fake.server.db).toMatchObject({ first: 1, remote: 2 })
        expect(fake.server.db.characters[0].name).toBe('B')
        expect(fake.server.db.modules[0].name).toBe('N')
        expect(state.db.characters[0].name).toBe('B')
        expect(state.db.modules[0].name).toBe('N')
    })

    test('a failed rebase read keeps the etag held before it, so the retry rebases instead of overwriting the other device', async () => {
        vi.useFakeTimers()
        const { api, fake } = await boot()
        fake.foreign((db) => { db.remote = 2 })
        fake.faults.read.push('network-error', 'network-error', 'network-error', 'network-error')
        await edit((db) => { db.first = 1 })

        expect(await settle(api.flushSaves())).toBe(true)
        expect(fake.server.db).toMatchObject({ first: 1, remote: 2 })
        expect(state.db).toMatchObject({ first: 1, remote: 2 })
        expect(fake.calls.filter((call) => call.route === 'write')).toEqual([])
    })
})

describe('autosave deadline (#114)', () => {
    test('a patch that never answers fails after the deadline, and the edits made meanwhile reach the server', async () => {
        vi.useFakeTimers()
        const { api, fake } = await boot()
        fake.faults.patch.push('hang')
        await edit((db) => { db.first = 1 })
        expect(fake.calls.filter((call) => call.route === 'patch')).toHaveLength(1)
        await edit((db) => { db.later = 1 })

        const immediate = Promise.resolve(api.requestImmediateSave())
        // The wait ends with the attempt that got no answer instead of
        // starting more of them; the edits stay queued.
        expect(await settle(api.flushSaves(), 3 * 60_000)).toBe(false)
        await settle(immediate, 60_000)
        // The loop retries on its own after the backoff.
        await settle(new Promise((r) => setTimeout(r, 10_000)))
        expect(fake.server.db).toMatchObject({ first: 1, later: 1 })
        expect(api.saving.state).toBe(false)
        expect(await settle(api.flushSaves())).toBe(true)
    })

    test('a rebase read that never answers fails, and the retry still keeps the other device\'s change', async () => {
        vi.useFakeTimers()
        const { api, fake } = await boot()
        fake.foreign((db) => { db.remote = 2 })
        fake.faults.read.push('hang')
        await edit((db) => { db.first = 1 })
        await settle(new Promise((r) => setTimeout(r, 3 * 60_000)))

        expect(await settle(api.flushSaves())).toBe(true)
        expect(fake.server.db).toMatchObject({ first: 1, remote: 2 })
        expect(fake.calls.filter((call) => call.route === 'write')).toEqual([])
    })

    test('a patch the server applied but whose answer was lost ends on the server once, with the other device\'s change', async () => {
        vi.useFakeTimers()
        const { api, fake } = await boot()
        fake.faults.patch.push('apply-then-hang')
        await edit((db) => { db.items.push('b'); db.first = 1 })
        expect(fake.server.db.items).toEqual(['a', 'b'])
        fake.foreign((db) => { db.remote = 2 })

        expect(await settle(api.flushSaves())).toBe(false)
        await settle(new Promise((r) => setTimeout(r, 10_000)))
        expect(await settle(api.flushSaves())).toBe(true)
        expect(fake.server.db).toMatchObject({ first: 1, remote: 2, items: ['a', 'b'] })
        expect(state.db).toMatchObject({ first: 1, remote: 2, items: ['a', 'b'] })
    })

    test('a full write the server applied but whose answer was lost ends on the server once, with the other device\'s change', async () => {
        vi.useFakeTimers()
        const { api, fake } = await boot()
        fake.faults.patch.push('own-conflict')
        fake.faults.write.push('apply-then-hang')
        await edit((db) => { db.items.push('b') })
        expect(fake.server.db.items).toEqual(['a', 'b'])
        fake.foreign((db) => { db.remote = 2 })

        expect(await settle(api.flushSaves())).toBe(false)
        await settle(new Promise((r) => setTimeout(r, 10_000)))
        expect(await settle(api.flushSaves())).toBe(true)
        expect(fake.server.db).toMatchObject({ remote: 2, items: ['a', 'b'] })
        expect(state.db).toMatchObject({ remote: 2, items: ['a', 'b'] })
    })
})

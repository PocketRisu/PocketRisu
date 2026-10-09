import 'fake-indexeddb/auto'
import localforage from 'localforage'
import { Blob as NativeBlob } from 'node:buffer'
import { beforeEach, describe, expect, test, vi } from 'vitest'

// fake-indexeddb uses Node's structuredClone; use its native Blob as well.
vi.stubGlobal('Blob', NativeBlob)
Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true })
const legacy = new Map<string, Uint8Array>()
let serverAvailable = true
async function listLegacy(prefix: string) {
    if (!serverAvailable) throw new Error('server unavailable')
    return [...legacy.keys()].filter((key) => key.startsWith(prefix))
}
const server = {
    Init: vi.fn(async () => {}),
    keys: vi.fn(listLegacy),
    getItem: vi.fn(async (key: string) => {
        if (!serverAvailable) throw new Error('server unavailable')
        return legacy.get(key) ?? null
    }),
    setItem: vi.fn(async () => { throw new Error('unexpected server write') }),
    removeItem: vi.fn(async () => { throw new Error('unexpected server deletion') }),
}
vi.mock('../globalApi.svelte', () => ({ toGetter: (v: unknown) => v, forageStorage: server }))
vi.mock('../storage/database.svelte', () => ({ getDatabase: () => ({}) }))
vi.mock('../parser/parser.svelte', () => ({ hasher: async () => '' }))

const nativeStore = localforage.createInstance({ name: 'plugin', storeName: 'plugin' })
const marker = '__pocketrisu_server_migrated_v1__'
let Storage = (await import('./pluginSafeClass')).SafeLocalPluginStorage
async function reload() {
    vi.resetModules()
    Storage = (await import('./pluginSafeClass')).SafeLocalPluginStorage
    return new Storage('p')
}
function seed(key: string, value: unknown, prefix = 'cache/plugin-storage/') {
    const storageKey = `${prefix}${Buffer.from(key).toString('base64url')}.json`
    legacy.set(storageKey, new TextEncoder().encode(JSON.stringify(value)))
}
beforeEach(async () => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
    server.keys.mockImplementation(listLegacy)
    serverAvailable = true
    legacy.clear()
    localStorage.clear()
    await nativeStore.clear()
    await reload()
})

describe('upstream browser storage', () => {
    test('uses the upstream database, store and key prefix directly', async () => {
        await nativeStore.setItem('safe_plugin_existing', { original: true })
        const storage = new Storage('p')
        expect(await storage.getItem('existing')).toEqual({ original: true })
        await storage.setItem('new', new Uint8Array([1, 2]))
        expect(await nativeStore.getItem('safe_plugin_new')).toEqual(new Uint8Array([1, 2]))
        expect(nativeStore.driver()).toBe(localforage.INDEXEDDB)
        expect(await (await reload()).getItem('new')).toEqual(new Uint8Array([1, 2]))
        expect(server.setItem).not.toHaveBeenCalled()
    })
    test('retains Blob bytes and MIME after reload', async () => {
        await new Storage().setItem('audio', new Blob([new Uint8Array([0, 255, 3])], { type: 'audio/wav' }))
        const audio = await (await reload()).getItem<Blob>('audio')
        expect(audio).toBeInstanceOf(Blob)
        expect(audio.type).toBe('audio/wav')
        expect(new Uint8Array(await audio.arrayBuffer())).toEqual(new Uint8Array([0, 255, 3]))
    })
    test('preserves backing buffers, offsets, shared references and cycles', async () => {
        const buffer = new Uint8Array(64).fill(7).buffer
        const value: any = { buffer, first: new Uint16Array(buffer, 4, 2), second: new DataView(buffer, 8, 4), map: new Map(), set: new Set() }
        value.self = value
        value.alias = value.first
        value.map.set(value, value.first)
        value.set.add(value)
        await new Storage().setItem('graph', value)
        const restored = await (await reload()).getItem<typeof value>('graph')
        expect(restored.first.byteOffset).toBe(4)
        expect(restored.first.length).toBe(2)
        expect(restored.second.byteOffset).toBe(8)
        expect(restored.buffer.byteLength).toBe(64)
        expect(new Uint8Array(restored.buffer)[63]).toBe(7)
        expect(restored.first.buffer).toBe(restored.buffer)
        expect(restored.second.buffer).toBe(restored.buffer)
        expect(restored.alias).toBe(restored.first)
        expect(restored.self).toBe(restored)
        expect(restored.map.get(restored)).toBe(restored.first)
        expect(restored.set.has(restored)).toBe(true)
    })
    test.each([
        ['Date and RegExp', () => [new Date('2026-01-01'), new Date(NaN), /audio/gi]],
        ['primitives', () => ({ values: [NaN, Infinity, -Infinity, -0, 123n, undefined, , 2], missing: undefined })],
        ['Error', () => new TypeError('failure', { cause: { code: 1 } })],
    ] as const)('uses native clone semantics for %s', async (_name, makeValue) => {
        const value = makeValue()
        await new Storage().setItem('native', value)
        expect(await (await reload()).getItem('native')).toEqual(structuredClone(value))
    })
    test('stores a non-extractable CryptoKey', async () => {
        const value = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 128 }, false, ['encrypt', 'decrypt'])
        await new Storage().setItem('key', value)
        const restored = await (await reload()).getItem<CryptoKey>('key')
        expect(restored.extractable).toBe(false)
        expect(restored.algorithm).toEqual(value.algorithm)
        expect(restored.usages).toEqual(value.usages)
    })
    test('retains resizable buffers and length-tracking views', async () => {
        const buffer: any = new (ArrayBuffer as any)(8, { maxByteLength: 16 })
        const value = { buffer, tracking: new Uint8Array(buffer, 2), fixed: new Uint8Array(buffer, 2, 6) }
        await new Storage().setItem('resize', value)
        const restored = await (await reload()).getItem<typeof value>('resize')
        expect(restored.buffer.resizable).toBe(true)
        expect(restored.buffer.maxByteLength).toBe(16)
        restored.buffer.resize(16)
        expect(restored.tracking.length).toBe(14)
        expect(restored.fixed.length).toBe(6)
    })
    test('an iframe transfer and caller mutation cannot affect persisted data', async () => {
        const storage = new Storage()
        await storage.setItem('bytes', new Uint8Array([1, 2]).buffer)
        const first = await storage.getItem<ArrayBuffer>('bytes')
        structuredClone(first, { transfer: [first] })
        expect(first.byteLength).toBe(0)
        new Uint8Array(await storage.getItem<ArrayBuffer>('bytes'))[0] = 9
        expect(new Uint8Array(await storage.getItem<ArrayBuffer>('bytes'))).toEqual(new Uint8Array([1, 2]))
    })
    test('a rejected native write preserves existing data', async () => {
        const storage = new Storage()
        await storage.setItem('saved', 'original')
        await expect(storage.setItem('saved', { fn: () => {} })).rejects.toMatchObject({ name: 'DataCloneError' })
        expect(await storage.getItem('saved')).toBe('original')
    })
    test('read-before-write ordering follows IndexedDB', async () => {
        const storage = new Storage()
        await storage.setItem('order', 'old')
        const read = storage.getItem('order')
        const write = storage.setItem('order', 'new')
        expect(await read).toBe('old')
        await write
        expect(await storage.getItem('order')).toBe('new')
    })
    test('keys and clear affect only upstream-prefixed plugin data', async () => {
        const storage = new Storage('p')
        await nativeStore.setItem('unrelated', 'keep')
        await storage.setItem('z', 'last')
        await storage.setItem('a', 'first')
        expect(await storage.keys()).toEqual(['a', 'z'])
        await storage.removeItem('a')
        expect(await storage.getItem('a')).toBeNull()
        await storage.clear()
        expect(await storage.keys()).toEqual([])
        expect(await nativeStore.getItem('unrelated')).toBe('keep')
        expect(await nativeStore.getItem(marker)).toBe(true)
        expect(server.removeItem).not.toHaveBeenCalled()
    })
    test('ownership stays in the browser and is hidden from plugin keys', async () => {
        const storage = new Storage('p')
        const { getOwners } = await import('./pluginStorageMeta')
        await storage.setItem('owned', 'value')
        expect(await getOwners('idb')).toEqual({ owned: 'p' })
        expect(await storage.keys()).toEqual(['owned'])
        await storage.removeItem('owned')
        expect(await getOwners('idb')).toEqual({})
        await storage.setItem('owned', 'value')
        await storage.clear()
        expect(await getOwners('idb')).toEqual({})
        expect(await nativeStore.getItem(marker)).toBe(true)
        expect(server.setItem).not.toHaveBeenCalled()
    })
})

describe('one-time server migration', () => {
    test('copies JSON and ownership while preserving server originals', async () => {
        seed('음성/1', { text: 'legacy', values: [1, true] })
        seed('음성/1', { plugin: 'old-plugin', updatedAt: 1 }, 'cache/plugin-storage-meta/')
        const before = new Map(legacy)
        expect(await new Storage().getItem('음성/1')).toEqual({ text: 'legacy', values: [1, true] })
        const { getOwners } = await import('./pluginStorageMeta')
        expect(await getOwners('idb')).toEqual({ '음성/1': 'old-plugin' })
        expect(legacy).toEqual(before)
        expect(await nativeStore.getItem(marker)).toBe(true)
    })
    test('preserves existing browser values, including null', async () => {
        seed('existing', 'server')
        seed('null', 'server')
        await nativeStore.setItem('safe_plugin_existing', 'browser')
        await nativeStore.setItem('safe_plugin_null', null)
        const storage = new Storage()
        expect(await storage.getItem('existing')).toBe('browser')
        expect(await storage.getItem('null')).toBeNull()
        expect(await storage.keys()).toEqual(['existing', 'null'])
    })
    test('does not attach a server owner to a conflicting browser value', async () => {
        seed('existing', 'server')
        seed('existing', { plugin: 'server-plugin', updatedAt: 1 }, 'cache/plugin-storage-meta/')
        await nativeStore.setItem('safe_plugin_existing', 'browser')
        expect(await new Storage().getItem('existing')).toBe('browser')
        const { getOwners } = await import('./pluginStorageMeta')
        expect(await getOwners('idb')).toEqual({})
    })
    test('fallback migration requires a cross-tab lock before copying missing values', async () => {
        seed('legacy', 'old')
        const { localPluginStorage } = await import('./localPluginStorage')
        await localPluginStorage.setDriver(localforage.LOCALSTORAGE)
        const storage = new Storage()
        await expect(storage.keys()).rejects.toThrow('requires IndexedDB or Web Locks')
        expect(await localPluginStorage.getItem('safe_plugin_legacy')).toBeNull()
        expect(await localPluginStorage.getItem(marker)).toBeNull()
        const request = vi.fn(async (_name: string, run: () => Promise<void>) => { await run() })
        Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true })
        try {
            expect(await storage.getItem('legacy')).toBe('old')
            expect(request).toHaveBeenCalled()
        } finally { Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true }) }
    })
    test('fallback rechecks completion after a slow server fetch', async () => {
        seed('legacy', 'old')
        const { localPluginStorage } = await import('./localPluginStorage')
        await localPluginStorage.setDriver(localforage.LOCALSTORAGE)
        let release: () => void
        let held: () => void
        const gate = new Promise<void>((resolve) => { release = resolve })
        const paused = new Promise<void>((resolve) => { held = resolve })
        server.keys.mockImplementationOnce(async (prefix) => { held(); await gate; return listLegacy(prefix) })
        const read = new Storage().getItem('legacy')
        try {
            await paused
            // Another tab finished copying and then deleted the imported value.
            await localPluginStorage.setItem(marker, true)
            await localPluginStorage.removeItem('safe_plugin_legacy')
            release()
            expect(await read).toBeNull()
        } finally { release(); await Promise.allSettled([read]) }
    })
    test('after migration all operations and reloads work without the server', async () => {
        seed('legacy', 'copied')
        const storage = new Storage('p')
        expect(await storage.getItem('legacy')).toBe('copied')
        const reads = server.getItem.mock.calls.length
        const lists = server.keys.mock.calls.length
        serverAvailable = false
        await storage.setItem('local', new Uint8Array([1]))
        await storage.removeItem('legacy')
        const fresh = await reload()
        expect(await fresh.getItem('local')).toEqual(new Uint8Array([1]))
        await fresh.clear()
        expect(await (await reload()).keys()).toEqual([])
        expect(server.getItem).toHaveBeenCalledTimes(reads)
        expect(server.keys).toHaveBeenCalledTimes(lists)
        expect(server.setItem).not.toHaveBeenCalled()
        expect(server.removeItem).not.toHaveBeenCalled()
    })
    test('server changes and deleted browser values are not reimported', async () => {
        seed('legacy', 'old')
        const storage = new Storage()
        expect(await storage.getItem('legacy')).toBe('old')
        await storage.removeItem('legacy')
        seed('legacy', 'new server value')
        seed('later', 'server only')
        expect(await (await reload()).keys()).toEqual([])
        expect(await new Storage().getItem('legacy')).toBeNull()
    })
    test('a server failure leaves migration incomplete and retryable', async () => {
        seed('legacy', 'copied')
        serverAvailable = false
        await expect(new Storage().getItem('legacy')).rejects.toThrow('server unavailable')
        expect(await nativeStore.getItem(marker)).toBeNull()
        serverAvailable = true
        expect(await new Storage().getItem('legacy')).toBe('copied')
        expect(await nativeStore.getItem(marker)).toBe(true)
    })
    test('a disappeared server key is skipped while a stored null is copied', async () => {
        seed('gone', 'old')
        seed('null', null)
        server.getItem.mockImplementationOnce(async (key) => { legacy.delete(key); return null })
        expect(await new Storage().keys()).toEqual(['null'])
        expect(await nativeStore.getItem(marker)).toBe(true)
    })
    test('unreadable server JSON cannot silently complete migration', async () => {
        seed('a', 'valid')
        seed('b', 'bad')
        const badKey = 'cache/plugin-storage/' + Buffer.from('b').toString('base64url') + '.json'
        legacy.set(badKey, new TextEncoder().encode('invalid JSON'))
        await expect(new Storage().keys()).rejects.toBeInstanceOf(SyntaxError)
        expect(await nativeStore.getItem('safe_plugin_a')).toBeNull()
        expect(await nativeStore.getItem(marker)).toBeNull()
        seed('b', 'fixed')
        expect(await new Storage().keys()).toEqual(['a', 'b'])
    })
    test('an aborted copy rolls back imported keys and the marker together', async () => {
        seed('a', 'first')
        seed('b', 'second')
        const original = IDBObjectStore.prototype.add
        const add = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function(value, key) {
            if (key === 'safe_plugin_b') throw new DOMException('quota', 'QuotaExceededError')
            return original.call(this, value, key)
        })
        await expect(new Storage().keys()).rejects.toMatchObject({ name: 'QuotaExceededError' })
        expect(await nativeStore.getItem('safe_plugin_a')).toBeNull()
        expect(await nativeStore.getItem(marker)).toBeNull()
        add.mockRestore()
        expect(await new Storage().keys()).toEqual(['a', 'b'])
    })
    test('a second tab finishing migration later cannot resurrect a cleared key', async () => {
        seed('legacy', 'old')
        const FirstStorage = Storage
        await reload()
        let release: () => void
        let held: () => void
        const gate = new Promise<void>((resolve) => { release = resolve })
        const paused = new Promise<void>((resolve) => { held = resolve })
        let lists = 0
        server.keys.mockImplementation(async (prefix) => {
            if (prefix === 'cache/plugin-storage/' && ++lists === 2) { held(); await gate }
            return listLegacy(prefix)
        })
        const first = new FirstStorage()
        const copy = first.getItem('legacy')
        const second = new Storage().getItem('legacy')
        try {
            await paused
            expect(await copy).toBe('old')
            await first.clear()
            release()
            expect(await second).toBeNull()
            expect(await first.keys()).toEqual([])
        } finally { release(); await Promise.allSettled([copy, second]) }
    })
})

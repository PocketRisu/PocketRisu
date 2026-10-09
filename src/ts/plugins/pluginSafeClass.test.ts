import { describe, test, expect, vi, beforeEach } from 'vitest'
import { Blob as NativeBlob } from 'node:buffer'

// Use a Blob that Node's structuredClone can copy, as the browser bridge does.
vi.stubGlobal('Blob', NativeBlob)

// In-memory stand-in for the server kv behind persistentKv, with a switch to
// make writes fail like a 423 session-lock rejection or a dropped connection.
const kv = new Map<string, Uint8Array>()
let failWrites = false
// Serialized values containing this text are rejected (a per-write switch,
// so a failing write and a later successful one can be in flight together).
let poison: string | null = null
vi.mock('../globalApi.svelte', () => ({
    toGetter: (v: any) => v,
    forageStorage: {
        Init: async () => {},
        getItem: async (key: string) => kv.get(key) ?? null,
        setItem: async (key: string, value: Uint8Array) => {
            if (failWrites) throw new Error('write rejected')
            // One-shot: the first matching write fails, later ones succeed.
            if (poison && new TextDecoder().decode(value).includes(poison)) { poison = null; throw new Error('write rejected') }
            kv.set(key, value)
        },
        removeItem: async (key: string) => {
            if (failWrites) throw new Error('remove rejected')
            kv.delete(key)
        },
        keys: async (prefix: string) => [...kv.keys()].filter((k) => k.startsWith(prefix)),
    },
}))
vi.mock('../parser/parser.svelte', () => ({ hasher: async () => '' }))
const meta = { recordOwner: vi.fn(async () => {}), removeOwner: vi.fn(async () => {}), clearOwners: vi.fn(async () => {}) }
vi.mock('./pluginStorageMeta', () => meta)

const { SafeLocalPluginStorage } = await import('./pluginSafeClass')

describe('SafeLocalPluginStorage write failure', () => {
    beforeEach(async () => {
        kv.clear()
        failWrites = false
        poison = null
        meta.recordOwner.mockClear()
        await new SafeLocalPluginStorage().clear()
    })

    test('a rejected server write is rolled back and surfaced', async () => {
        const storage = new SafeLocalPluginStorage('p')
        await storage.setItem('cfg', { v: 1 })
        expect(await storage.getItem('cfg')).toEqual({ v: 1 })

        failWrites = true
        await expect(storage.setItem('cfg', { v: 2 })).rejects.toThrow('write rejected')
        // The plugin reads what the server holds, not the value it never got.
        expect(await storage.getItem('cfg')).toEqual({ v: 1 })
        expect(meta.recordOwner).toHaveBeenCalledTimes(1)
    })

    test('a rejected first write leaves no phantom value', async () => {
        const storage = new SafeLocalPluginStorage('p')
        failWrites = true
        await expect(storage.setItem('fresh', 1)).rejects.toThrow()
        expect(await storage.getItem('fresh')).toBeNull()
    })

    test('a rejected remove keeps the value readable', async () => {
        const storage = new SafeLocalPluginStorage('p')
        await storage.setItem('keep', 'x')
        failWrites = true
        await expect(storage.removeItem('keep')).rejects.toThrow('remove rejected')
        expect(await storage.getItem('keep')).toBe('x')
    })

    test('rollback does not clobber a newer write to the same key', async () => {
        const storage = new SafeLocalPluginStorage('p')
        await storage.setItem('k', 'a')
        poison = 'b'
        const failing = storage.setItem('k', 'b')
        await storage.setItem('k', 'c')
        await expect(failing).rejects.toThrow()
        expect(await storage.getItem('k')).toBe('c')
    })

    test('rollback does not clobber a newer write of the same value', async () => {
        const storage = new SafeLocalPluginStorage('p')
        await storage.setItem('k', 'a')
        poison = 'same'
        const failing = storage.setItem('k', 'same')
        await storage.setItem('k', 'same')
        await expect(failing).rejects.toThrow()
        expect(await storage.getItem('k')).toBe('same')
    })

    test('an owner-record failure after a successful write is not a write failure', async () => {
        meta.recordOwner.mockImplementationOnce(async () => { throw new Error('meta down') })
        const storage = new SafeLocalPluginStorage('p')
        await expect(storage.setItem('cfg', { v: 3 })).resolves.toBeUndefined()
        expect(await storage.getItem('cfg')).toEqual({ v: 3 })
    })
})

describe('SafeLocalPluginStorage binary persistence', () => {
    let Storage = SafeLocalPluginStorage

    async function reload() {
        // A second instance shares the cache; re-import to simulate a page reload.
        vi.resetModules()
        Storage = (await import('./pluginSafeClass')).SafeLocalPluginStorage
        return new Storage('p')
    }

    beforeEach(async () => {
        failWrites = false
        poison = null
        await new Storage().clear()
        kv.clear()
        meta.recordOwner.mockClear()
    })

    test('restores Blob bytes and MIME type after a reload', async () => {
        const bytes = new Uint8Array([0, 255, 128, 1])
        await new Storage('p').setItem('audio', new Blob([bytes], { type: 'audio/mpeg' }))

        const restored = await (await reload()).getItem<Blob>('audio')
        expect(restored).toBeInstanceOf(Blob)
        expect(restored.type).toBe('audio/mpeg')
        expect(new Uint8Array(await restored.arrayBuffer())).toEqual(bytes)
    })

    test('restores an empty Blob and ArrayBuffer', async () => {
        const storage = new Storage('p')
        await storage.setItem('empty-blob', new Blob([], { type: 'audio/wav' }))
        await storage.setItem('empty-buffer', new ArrayBuffer(0))

        const fresh = await reload()
        const blob = await fresh.getItem<Blob>('empty-blob')
        expect(blob).toBeInstanceOf(Blob)
        expect(blob.size).toBe(0)
        expect(blob.type).toBe('audio/wav')
        expect(await fresh.getItem('empty-buffer')).toBeInstanceOf(ArrayBuffer)
    })

    test.each([
        ['Int8Array', () => new Int8Array([-128, 0, 127])],
        ['Uint8Array', () => new Uint8Array([0, 128, 255])],
        ['Uint8ClampedArray', () => new Uint8ClampedArray([0, 128, 255])],
        ['Int16Array', () => new Int16Array([-32768, 0, 32767])],
        ['Uint16Array', () => new Uint16Array([0, 65535])],
        ['Int32Array', () => new Int32Array([-2147483648, 2147483647])],
        ['Uint32Array', () => new Uint32Array([0, 4294967295])],
        ['Float32Array', () => new Float32Array([0.5, -1.25, Infinity])],
        ['Float64Array', () => new Float64Array([Math.PI, NaN, -Infinity])],
        ['BigInt64Array', () => new BigInt64Array([-1n, 9223372036854775807n])],
        ['BigUint64Array', () => new BigUint64Array([0n, 18446744073709551615n])],
    ] as const)('restores %s after a reload', async (_name, makeValue) => {
        const original = makeValue()
        await new Storage('p').setItem('typed', original)
        const restored = await (await reload()).getItem('typed')
        expect(restored).toBeInstanceOf(original.constructor)
        expect(restored).toEqual(original)
    })

    test('preserves a slice offset, length and entire backing buffer', async () => {
        const bytes = new Uint8Array([99, 1, 2, 3, 88])
        const storage = new Storage('p')
        await storage.setItem('slice', bytes.subarray(1, 4))
        await storage.setItem('view', new DataView(bytes.buffer, 1, 3))

        const fresh = await reload()
        const slice = await fresh.getItem<Uint8Array>('slice')
        expect(slice).toEqual(new Uint8Array([1, 2, 3]))
        expect(slice.byteOffset).toBe(1)
        expect(new Uint8Array(slice.buffer)).toEqual(bytes)
        const view = await fresh.getItem<DataView>('view')
        expect(view).toBeInstanceOf(DataView)
        expect(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)).toEqual(new Uint8Array([1, 2, 3]))
        expect(view.byteOffset).toBe(1)
        expect(new Uint8Array(view.buffer)).toEqual(bytes)
    })

    test('preserves shared buffers and repeated binary/object references', async () => {
        const buffer = new Uint8Array([1, 2, 3, 4, 5, 6]).buffer
        const bytes = new Uint8Array(buffer, 1, 3)
        const view = new DataView(buffer, 2, 2)
        const object = { bytes }
        const blob = new Blob([new Uint8Array([9])])
        const value = { bytes, view, buffer, again: bytes, object, alias: object, blob, blobAlias: blob }
        await new Storage('p').setItem('shared', value)
        const restored = await (await reload()).getItem<typeof value>('shared')
        expect(restored.bytes.buffer).toBe(restored.buffer)
        expect(restored.view.buffer).toBe(restored.buffer)
        expect(restored.bytes).toBe(restored.again)
        expect(restored.object).toBe(restored.alias)
        expect(restored.object.bytes).toBe(restored.bytes)
        expect(restored.blob).toBe(restored.blobAlias)
        restored.bytes[1] = 77
        expect(restored.view.getUint8(0)).toBe(77)
        // A getItem result is a separate clone, as with IndexedDB reads.
        expect((await new Storage('p').getItem<typeof value>('shared')).bytes[1]).toBe(3)
    })

    test('preserves empty and multi-byte views at nonzero offsets', async () => {
        const buffer = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer
        const value = { empty: new Uint8Array(buffer, 8, 0), words: new Uint16Array(buffer, 2, 2) }
        await new Storage('p').setItem('views', value)
        const restored = await (await reload()).getItem<typeof value>('views')
        expect(restored.empty.byteOffset).toBe(8)
        expect(restored.empty.byteLength).toBe(0)
        expect(restored.words.byteOffset).toBe(2)
        expect(restored.words.length).toBe(2)
        expect(restored.words.buffer).toBe(restored.empty.buffer)
        expect(new Uint8Array(restored.words.buffer)).toEqual(new Uint8Array(buffer))
    })

    test('preserves cycles and aliases around binary data', async () => {
        const value: any = { audio: new Uint8Array([1, 2]), text: 'clip' }
        value.self = value
        value.list = [value, value.audio]
        await new Storage('p').setItem('cycle', value)
        const restored = await (await reload()).getItem<typeof value>('cycle')
        expect(restored.self).toBe(restored)
        expect(restored.list[0]).toBe(restored)
        expect(restored.list[1]).toBe(restored.audio)
    })

    test('preserves resizable buffers and distinguishes fixed and length-tracking views', async () => {
        const BufferConstructor = ArrayBuffer as any
        const buffer = new BufferConstructor(8, { maxByteLength: 16 })
        const value = {
            buffer,
            tracking: new Uint8Array(buffer, 2), fixed: new Uint8Array(buffer, 2, 6),
            data: new DataView(buffer, 2), empty: new Uint8Array(buffer, 8),
            fixedEmpty: new Uint8Array(buffer, 8, 0),
        }
        await new Storage('p').setItem('resize', value)
        const restored = await (await reload()).getItem<typeof value>('resize')
        expect(restored.buffer.resizable).toBe(true)
        expect(restored.buffer.maxByteLength).toBe(16)
        restored.buffer.resize(16)
        expect(restored.tracking.length).toBe(14)
        expect(restored.fixed.length).toBe(6)
        expect(restored.data.byteLength).toBe(14)
        expect(restored.empty.length).toBe(8)
        expect(restored.fixedEmpty.length).toBe(0)
        expect(restored.tracking.buffer).toBe(restored.buffer)
    })

    test('rejects an out-of-bounds resizable view rather than storing an empty view', async () => {
        const buffer: any = new (ArrayBuffer as any)(8, { maxByteLength: 16 })
        const view = new Uint8Array(buffer, 4, 4)
        buffer.resize(2)
        await expect(new Storage().setItem('out-of-bounds', view)).rejects.toMatchObject({ name: 'DataCloneError' })
        expect(await new Storage().getItem('out-of-bounds')).toBeNull()
    })

    test.each([
        ['Date', () => new Date('2026-01-02T03:04:05Z')],
        ['invalid Date', () => new Date(NaN)],
        ['Map', () => new Map([['audio', new Uint8Array([1, 2])]])],
        ['Set', () => new Set([new Blob([new Uint8Array([3])]), 'text'])],
        ['RegExp', () => /audio/gi],
        ['BigInt', () => 123456789012345678901234567890n],
        ['boxed values', () => [Object(123n), new Number(NaN), new Boolean(false), new String('text')]],
        ['special numbers', () => [NaN, Infinity, -Infinity, -0]],
        ['undefined and sparse arrays', () => ({ missing: undefined, array: [undefined, , 3] })],
    ] as const)('returns the structured-clone shape of %s after reload', async (_name, makeValue) => {
        const value = makeValue()
        await new Storage('p').setItem('clone', value)
        expect(await (await reload()).getItem('clone')).toEqual(structuredClone(value))
    })

    test('stores a shared backing buffer once, while retaining bytes outside the view', async () => {
        const { makeEncodedStorageKey } = await import('../storage/persistentKv')
        const buffer = new Uint8Array(4096).fill(7).buffer
        await new Storage('p').setItem('size-shared', {
            first: new Uint8Array(buffer, 1024, 16), second: new DataView(buffer, 2048, 32), buffer,
        })
        const raw = kv.get(makeEncodedStorageKey('cache/plugin-storage/', 'size-shared'))
        expect(raw.length).toBeGreaterThan(4096)
        expect(raw.length).toBeLessThan(4096 + 1024)
        const restored: any = await (await reload()).getItem('size-shared')
        expect(new Uint8Array(restored.first.buffer)[4000]).toBe(7)
        expect(restored.first.buffer).toBe(restored.second.buffer)
    })

    test('preserves binary values nested inside objects and arrays', async () => {
        const audio = new Blob([new Uint8Array([1, 255])], { type: 'audio/wav' })
        const value = { text: '한글', audio, clips: [new Uint8Array([7]), new Uint8Array([8]).buffer], asset: 'assets/test.png' }
        await new Storage('p').setItem('nested', value)

        const restored = await (await reload()).getItem<typeof value>('nested')
        expect(restored.text).toBe(value.text)
        expect(restored.asset).toBe(value.asset)
        expect(restored.audio).toBeInstanceOf(Blob)
        expect(restored.audio.type).toBe('audio/wav')
        expect(new Uint8Array(await restored.audio.arrayBuffer())).toEqual(new Uint8Array([1, 255]))
        expect(restored.clips[0]).toEqual(new Uint8Array([7]))
        expect(restored.clips[1]).toBeInstanceOf(ArrayBuffer)
        expect(new Uint8Array(restored.clips[1] as ArrayBuffer)).toEqual(new Uint8Array([8]))
    })

    test('returns fresh buffers so an iframe transfer cannot detach the cache', async () => {
        const storage = new Storage('p')
        await storage.setItem('buffer', new Uint8Array([1, 2, 3]).buffer)
        const first = await storage.getItem<ArrayBuffer>('buffer')
        structuredClone(first, { transfer: [first] })
        expect(first.byteLength).toBe(0)
        expect(new Uint8Array(await storage.getItem<ArrayBuffer>('buffer'))).toEqual(new Uint8Array([1, 2, 3]))

        const fresh = await reload()
        const cold = await fresh.getItem<ArrayBuffer>('buffer')
        structuredClone(cold, { transfer: [cold] })
        expect(new Uint8Array(await fresh.getItem<ArrayBuffer>('buffer'))).toEqual(new Uint8Array([1, 2, 3]))
    })

    test('reads existing JSON records and keeps new JSON records unchanged', async () => {
        const { makeEncodedStorageKey } = await import('../storage/persistentKv')
        const storageKey = makeEncodedStorageKey('cache/plugin-storage/', 'legacy')
        const legacy = { audio: null, text: '한글', values: [1, true, 'x'] }
        kv.set(storageKey, new TextEncoder().encode(JSON.stringify(legacy)))
        const fresh = await reload()
        expect(await fresh.getItem('legacy')).toEqual(legacy)
        await fresh.setItem('legacy', legacy)
        expect(new TextDecoder().decode(kv.get(storageKey))).toBe(JSON.stringify(legacy))
    })

    test('lists, replaces, removes and clears binary records in the existing namespace', async () => {
        const storage = new Storage('p')
        await storage.setItem('음성/1', new Blob([new Uint8Array([1])]))
        await storage.setItem('음성/2', new Uint8Array([2]))
        const fresh = await reload()
        expect(await fresh.keys()).toEqual(['음성/1', '음성/2'])
        await fresh.setItem('음성/1', { replaced: true })
        expect(await (await reload()).getItem('음성/1')).toEqual({ replaced: true })
        await fresh.removeItem('음성/2')
        expect(await (await reload()).getItem('음성/2')).toBeNull()
        expect(meta.removeOwner).toHaveBeenCalledWith('idb', '음성/2')
        await fresh.clear()
        expect(await (await reload()).keys()).toEqual([])
        expect(kv.size).toBe(0)
    })

    function delayedBlob() {
        let release: () => void
        let started: () => void
        const gate = new Promise<void>((resolve) => { release = resolve })
        const reading = new Promise<void>((resolve) => { started = resolve })
        class SlowBlob extends Blob {
            async arrayBuffer() {
                started()
                await gate
                return super.arrayBuffer()
            }
        }
        return { blob: new SlowBlob([new Uint8Array([1])]), reading, release: () => release() }
    }

    test('snapshots submitted values and returns independent warm-cache objects', async () => {
        const storage = new Storage('p')
        const slow = delayedBlob()
        const first = storage.setItem('snapshot', slow.blob)
        await slow.reading
        const value = { bytes: new Uint8Array([1, 2]), text: 'saved' }
        const second = storage.setItem('snapshot', value)
        value.bytes[0] = 9
        value.text = 'changed'
        const read = storage.getItem<typeof value>('snapshot')
        slow.release()
        await Promise.all([first, second])
        const restored = await read
        expect(restored).toEqual({ bytes: new Uint8Array([1, 2]), text: 'saved' })
        restored.bytes[0] = 8
        expect((await storage.getItem<typeof value>('snapshot')).bytes[0]).toBe(1)
        expect(await (await reload()).getItem('snapshot')).toEqual({ bytes: new Uint8Array([1, 2]), text: 'saved' })
    })

    test('a read waiting on failed writes returns persisted data, including two failures', async () => {
        const storage = new Storage('p')
        await storage.setItem('failure', 'persisted')
        const slow = delayedBlob()
        failWrites = true
        const first = storage.setItem('failure', slow.blob).catch((error) => error.message)
        await slow.reading
        const second = storage.setItem('failure', new Uint8Array([9])).catch((error) => error.message)
        const read = storage.getItem('failure')
        slow.release()
        expect(await Promise.all([first, second])).toEqual(['write rejected', 'write rejected'])
        expect(await read).toBe('persisted')
        expect(await storage.getItem('failure')).toBe('persisted')
    })

    test('keys waits for pending Blob storage and uses decoded lexical ordering', async () => {
        const storage = new Storage('p')
        await storage.setItem('z', 'last')
        const slow = delayedBlob()
        const write = storage.setItem('a', slow.blob)
        await slow.reading
        const keys = storage.keys()
        slow.release()
        await write
        expect(await keys).toEqual(['a', 'z'])
    })

    test.each(['warm', 'cold'] as const)('a %s read submitted before a write returns the earlier value', async (cache) => {
        await new Storage('p').setItem('order', 'old')
        const storage = cache === 'cold' ? await reload() : new Storage('p')
        const read = storage.getItem('order')
        const write = storage.setItem('order', 'new')
        expect(await read).toBe('old')
        await write
        expect(await storage.getItem('order')).toBe('new')
    })

    test('rejects uncloneable values without replacing existing data', async () => {
        const storage = new Storage('p')
        await storage.setItem('invalid', 'saved')
        await expect(storage.setItem('invalid', { audio: new Uint8Array([1]), fn: () => {} })).rejects.toMatchObject({ name: 'DataCloneError' })
        expect(await storage.getItem('invalid')).toBe('saved')
    })

    test('keeps a newer write after asynchronous Blob encoding finishes', async () => {
        const storage = new Storage('p')
        const slow = delayedBlob()
        const first = storage.setItem('race', slow.blob)
        await slow.reading
        const second = storage.setItem('race', new Uint8Array([9]))
        slow.release()
        await Promise.all([first, second])
        expect(await (await reload()).getItem('race')).toEqual(new Uint8Array([9]))
    })

    test('does not resurrect a removed binary value after Blob encoding finishes', async () => {
        const storage = new Storage('p')
        const slow = delayedBlob()
        const write = storage.setItem('race', slow.blob)
        await slow.reading
        const remove = storage.removeItem('race')
        slow.release()
        await Promise.all([write, remove])
        expect(await (await reload()).getItem('race')).toBeNull()
        expect(await new Storage().keys()).toEqual([])
    })

    test('orders a clear after pending writes and before subsequent writes', async () => {
        const storage = new Storage('p')
        const slow = delayedBlob()
        const write = storage.setItem('before', slow.blob)
        await slow.reading
        const clear = storage.clear()
        const later = storage.setItem('after', new Uint8Array([9]))
        slow.release()
        await Promise.all([write, clear, later])
        const fresh = await reload()
        expect(await fresh.getItem('before')).toBeNull()
        expect(await fresh.getItem('after')).toEqual(new Uint8Array([9]))
    })

    test('a partially failed clear waits for remaining deletes before later writes', async () => {
        const storage = new Storage('p')
        await storage.setItem('a', 'old')
        await storage.setItem('b', 'old')
        const { forageStorage } = await import('../globalApi.svelte')
        const { makeEncodedStorageKey } = await import('../storage/persistentKv')
        const a = makeEncodedStorageKey('cache/plugin-storage/', 'a')
        const b = makeEncodedStorageKey('cache/plugin-storage/', 'b')
        let release: () => void
        let started: () => void
        const gate = new Promise<void>((resolve) => { release = resolve })
        const deleting = new Promise<void>((resolve) => { started = resolve })
        const remove = vi.spyOn(forageStorage, 'removeItem').mockImplementation(async (key) => {
            if (key === a) throw new Error('delete failed')
            if (key === b) { started(); await gate }
            kv.delete(key)
        })
        const set = vi.spyOn(forageStorage, 'setItem')
        let write: Promise<void> | undefined
        const clear = storage.clear().catch((error) => error.message)
        try {
            await deleting
            write = storage.setItem('b', 'new')
            // Drain queued microtasks while the second deletion is held open.
            for (let i = 0; i < 20; i++) await Promise.resolve()
            expect(set).not.toHaveBeenCalled()
            release()
            expect(await clear).toBe('delete failed')
            await write
            expect(await storage.getItem('b')).toBe('new')
            expect(await (await reload()).getItem('b')).toBe('new')
        } finally {
            release()
            await Promise.allSettled([clear, write])
            remove.mockRestore()
            set.mockRestore()
        }
    })

    test('a read after a queued remove cannot repopulate the cache with old data', async () => {
        const storage = new Storage('p')
        await storage.setItem('race', 'old')
        const slow = delayedBlob()
        const write = storage.setItem('race', slow.blob)
        await slow.reading
        const remove = storage.removeItem('race')
        const read = storage.getItem('race')
        slow.release()
        await Promise.all([write, remove])
        expect(await read).toBeNull()
        expect(await storage.getItem('race')).toBeNull()
    })

    test('a read after a queued clear cannot resurrect the cleared cache', async () => {
        const storage = new Storage('p')
        await storage.setItem('old', 'old')
        const slow = delayedBlob()
        const write = storage.setItem('pending', slow.blob)
        await slow.reading
        const clear = storage.clear()
        const read = storage.getItem('old')
        slow.release()
        await Promise.all([write, clear])
        expect(await read).toBeNull()
        expect(await storage.getItem('old')).toBeNull()
    })

    test.each(['remove', 'clear'] as const)('a %s submitted during a cold read cannot leave a stale cache', async (kind) => {
        await new Storage('p').setItem('race', 'old')
        const storage = await reload()
        const { forageStorage } = await import('../globalApi.svelte')
        let release: () => void
        let started: () => void
        const gate = new Promise<void>((resolve) => { release = resolve })
        const removing = new Promise<void>((resolve) => { started = resolve })
        const remove = vi.spyOn(forageStorage, 'removeItem').mockImplementation(async (key) => {
            started()
            await gate
            kv.delete(key)
        })
        try {
            const read = storage.getItem('race')
            const mutation = kind === 'remove' ? storage.removeItem('race') : storage.clear()
            await removing
            release()
            await Promise.all([read, mutation])
            expect(await read).toBe('old')
            expect(await storage.getItem('race')).toBeNull()
            expect(await (await reload()).getItem('race')).toBeNull()
        } finally {
            release()
            remove.mockRestore()
        }
    })

    test('rolls back a failed binary write to the previous persisted value', async () => {
        const storage = new Storage('p')
        await storage.setItem('failure', new Uint8Array([1]))
        failWrites = true
        await expect(storage.setItem('failure', new Blob([new Uint8Array([2])]))).rejects.toThrow('write rejected')
        expect(await storage.getItem('failure')).toEqual(new Uint8Array([1]))
        failWrites = false
        expect(await (await reload()).getItem('failure')).toEqual(new Uint8Array([1]))
    })

    test('stores raw bytes with bounded overhead and keeps asset references visible', async () => {
        const { makeEncodedStorageKey } = await import('../storage/persistentKv')
        const bytes = new Uint8Array(4096).fill(255)
        await new Storage('p').setItem('size', { audio: bytes, path: 'assets/keep.png' })
        const raw = kv.get(makeEncodedStorageKey('cache/plugin-storage/', 'size'))
        expect(raw.length).toBeLessThan(bytes.length + 256)
        expect(raw.subarray(raw.length - bytes.length)).toEqual(bytes)
        // The server cleanup scanner searches UTF-8 text for these references.
        expect(new TextDecoder().decode(raw)).toContain('assets/keep.png')
    })

    test('restores nested binary values under special JSON keys without prototype mutation', async () => {
        const value = JSON.parse('{"__proto__":{"audio":null},"constructor":null}')
        value.__proto__.audio = new Uint8Array([1])
        value.constructor = new Blob([new Uint8Array([2])])
        await new Storage('p').setItem('special', value)
        const restored = await (await reload()).getItem<typeof value>('special')
        expect(Object.hasOwn(restored, '__proto__')).toBe(true)
        expect(Object.getPrototypeOf(restored)).toBe(Object.prototype)
        expect(restored.__proto__.audio).toEqual(new Uint8Array([1]))
        expect(restored.constructor).toBeInstanceOf(Blob)
    })

    test('rejects truncated binary records instead of returning damaged data', async () => {
        const { makeEncodedStorageKey } = await import('../storage/persistentKv')
        await new Storage('p').setItem('corrupt', new Uint8Array([1, 2]))
        const key = makeEncodedStorageKey('cache/plugin-storage/', 'corrupt')
        kv.set(key, kv.get(key).subarray(0, kv.get(key).length - 1))
        await expect((await reload()).getItem('corrupt')).rejects.toThrow('Invalid local plugin storage binary part')
    })
})

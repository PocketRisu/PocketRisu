import { describe, it, expect, vi, beforeEach } from 'vitest'

const importFileByName = vi.fn(async () => true)
const importPlugin = vi.fn(async () => true as true | undefined)
vi.mock('src/ts/characterCards', () => ({ importFileByName }))
vi.mock('src/ts/plugins/plugins.svelte', () => ({ importPlugin }))
const checkCharOrder = vi.fn()
vi.mock('src/ts/globalApi.svelte', () => ({ checkCharOrder }))
const alertError = vi.fn()
vi.mock('src/ts/alert', () => ({ notifySuccess: vi.fn(), alertError }))
vi.mock('src/lang', () => ({ language: { successImport: 'ok', errors: { noData: 'no data' } } }))

// Stand-in for the SDK's public link client.
let claimedSize: number | undefined
let blocks: Uint8Array[] = []
let children: Record<string, unknown> = {}
const share = {
    getRootNode: async () => ({ uid: 'root', name: { ok: true, value: 'shared' }, type: 'folder' }),
    async *iterateFolderChildrenNodeUids() { yield* Object.keys(children) },
    async *iterateNodes(uids: string[]) { for (const uid of uids) yield children[uid] },
    getFileDownloader: async () => ({
        getClaimedSizeInBytes: () => claimedSize,
        downloadToStream(stream: WritableStream<Uint8Array>) {
            const done = (async () => {
                const writer = stream.getWriter()
                for (const block of blocks) await writer.write(block)
                await writer.close()
            })()
            return { completion: () => done }
        },
    }),
}
vi.mock('./protonDriveClient', () => ({
    createProtonDriveClient: () => ({
        experimental: {
            getURLAccessInfo: async () => ({ isLegacy: false, isCustomPasswordProtected: false }),
            authURLAccess: async () => share,
        },
    }),
}))

const { findProtonLink, isProtonImportable, importProtonFile, anySignal, openProtonShare } = await import('./protonImport')

const bytes = (text: string) => new TextEncoder().encode(text)

describe('findProtonLink', () => {
    it('finds one share link inside pasted text', () => {
        expect(findProtonLink('자료 https://drive.proton.me/urls/SB15SG1G9R#MqANyP9tCTLA 입니다'))
            .toBe('https://drive.proton.me/urls/SB15SG1G9R#MqANyP9tCTLA')
    })

    it('drops tracking parameters, a trailing slash and trailing punctuation', () => {
        expect(findProtonLink('(https://drive.proton.me/urls/ABC123/?utm_source=x#key_1-2).'))
            .toBe('https://drive.proton.me/urls/ABC123#key_1-2')
    })

    it('rejects links without the password fragment or on other hosts', () => {
        expect(findProtonLink('https://drive.proton.me/urls/ABC123')).toBeNull()
        expect(findProtonLink('https://evil.example/urls/ABC123#key')).toBeNull()
        expect(findProtonLink('http://drive.proton.me/urls/ABC123#key')).toBeNull()
    })

    it('treats the same share pasted twice as one, but two shares as ambiguous', () => {
        const a = 'https://drive.proton.me/urls/AAA#k1'
        expect(findProtonLink(`${a} ${a}`)).toBe(a)
        expect(findProtonLink(`${a} https://drive.proton.me/urls/BBB#k2`)).toBeNull()
    })
})

describe('isProtonImportable', () => {
    it('accepts card, module, preset and plugin files regardless of case', () => {
        for (const name of ['a.charx', 'a.PNG', 'a.jpeg', 'a.risum', 'a.risup', 'a.risupreset', 'cleanlog_1.9.0.js', 'p.ts']) {
            expect(isProtonImportable(name)).toBe(true)
        }
    })

    it('rejects archives, text and extensionless files', () => {
        for (const name of ['editor.zip', 'readme.txt', 'noext', 'card.json']) {
            expect(isProtonImportable(name)).toBe(false)
        }
    })
})

describe('importProtonFile', () => {
    beforeEach(() => {
        importFileByName.mockClear()
        importPlugin.mockClear()
        checkCharOrder.mockClear()
        alertError.mockClear()
    })

    it('installs plugins itself, stripping a BOM', async () => {
        expect(await importProtonFile('test.js', bytes('\uFEFF//@name test\n//@api 3.0\n'))).toBe(true)
        expect(importPlugin).toHaveBeenCalledWith('//@name test\n//@api 3.0\n', { isTypescript: false })
        expect(importFileByName).not.toHaveBeenCalled()
    })

    it('reports a plugin import that did not finish as failed', async () => {
        importPlugin.mockResolvedValueOnce(undefined)
        expect(await importProtonFile('bad.js', bytes('x'))).toBe(false)
    })

    it('rejects an empty plugin instead of letting importPlugin open a file picker', async () => {
        expect(await importProtonFile('empty.js', bytes('\uFEFF\n'))).toBe(false)
        expect(importPlugin).not.toHaveBeenCalled()
        expect(alertError).toHaveBeenCalledWith('no data')
    })

    it('hands other files to importFileByName with a lower-case extension', async () => {
        const data = bytes('x')
        await importProtonFile('Card.PNG', data)
        expect(importFileByName).toHaveBeenCalledWith('Card.png', data)
        expect(importPlugin).not.toHaveBeenCalled()
        // A new character must also land in the sidebar order.
        expect(checkCharOrder).toHaveBeenCalled()
    })
})

describe('anySignal without AbortSignal.any', () => {
    const native = AbortSignal.any
    beforeEach(() => {
        // Simulates Safari before 17.4.
        AbortSignal.any = undefined
        return () => { AbortSignal.any = native }
    })

    it('aborts with the reason of whichever input aborts later', () => {
        const a = new AbortController()
        const b = new AbortController()
        const combined = anySignal([a.signal, b.signal])
        expect(combined.aborted).toBe(false)
        b.abort('stop')
        expect(combined.aborted).toBe(true)
        expect(combined.reason).toBe('stop')
    })

    it('detaches from the other inputs once one aborts', () => {
        const session = new AbortController()
        const removed: unknown[] = []
        const remove = session.signal.removeEventListener.bind(session.signal)
        session.signal.removeEventListener = (type: string, listener: EventListenerOrEventListenerObject) => {
            removed.push(listener)
            remove(type, listener)
        }
        const request = new AbortController()
        anySignal([session.signal, request.signal])
        request.abort()
        expect(removed).toHaveLength(1)
    })

    it('starts aborted when an input already is', () => {
        const combined = anySignal([new AbortController().signal, AbortSignal.abort('gone')])
        expect(combined.aborted).toBe(true)
        expect(combined.reason).toBe('gone')
    })
})

describe('opened share', () => {
    const open = async () => {
        const result = await openProtonShare('https://drive.proton.me/urls/AAA#k1')
        if (result.kind !== 'ready') throw new Error(result.kind)
        return result.share
    }
    const file = { uid: 'f', name: 'a.risum', type: 'file' as const }
    const expected = [1, 2, 3, 4, 5, 6]

    beforeEach(() => {
        blocks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])]
    })

    it('writes blocks straight into a buffer of the claimed size', async () => {
        // A generous claim shows it: the result is a trimmed view of that buffer.
        claimedSize = 8
        const data = await (await open()).download(file)
        expect([...data]).toEqual(expected)
        expect(data.buffer.byteLength).toBe(8)
    })

    it('still returns the whole file when the claimed size is wrong or missing', async () => {
        for (const claim of [4, 10, undefined]) {
            claimedSize = claim
            const data = await (await open()).download(file)
            expect([...data]).toEqual(expected)
        }
    })

    it('lists a placeholder for undecryptable names and skips unreadable ones', async () => {
        children = {
            a: { uid: 'a', name: { ok: true, value: 'v1.10.risum' }, type: 'file' },
            b: { uid: 'b', name: { ok: false, error: { name: 'Unknown name', error: 'decrypt failed' } }, type: 'file' },
            c: { uid: 'c', name: { ok: false, error: new Error('broken') }, type: 'file' },
            d: { missingUid: 'd' },
        }
        const entries = await (await open()).list('root')
        expect(entries.map((e) => e.name)).toEqual(['Unknown name', 'v1.10.risum'])
    })
})

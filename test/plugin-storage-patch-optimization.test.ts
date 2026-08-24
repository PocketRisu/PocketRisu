import { describe, expect, it } from 'vitest'
import patchHashPkg from '../server/node/patch-hash-cache.cjs'
import selectiveClonePkg from '../server/node/patch-selective-clone.cjs'
import utilsPkg from '../server/node/utils.cjs'
import jsonPatchPkg from 'fast-json-patch'

const { createPatchHashCache, collectPluginStorageChildKeys } = patchHashPkg as any
const { clonePatchSnapshot, clonePluginStorageForPatch } = selectiveClonePkg as any
const { calculateHash } = utilsPkg as { calculateHash: (value: any) => number }
const { applyPatch } = jsonPatchPkg

function apply(base: any, patch: any[]) {
    const snapshot = clonePatchSnapshot(base, patch)
    applyPatch(snapshot, patch, true)
    return snapshot
}

describe('pluginCustomStorage direct-child optimization', () => {
    it('keeps cached hash equal to the full reference across child mutations', () => {
        const cache = createPatchHashCache(calculateHash)
        let db: any = {
            pluginCustomStorage: {
                alpha: { nested: { n: 1 } },
                beta: { nested: { n: 2 } },
            },
            other: { stable: true },
        }
        expect(cache.hash(db)).toBe(calculateHash(db))

        const patches = [
            [{ op: 'replace', path: '/pluginCustomStorage/alpha/nested/n', value: 7 }],
            [{ op: 'add', path: '/pluginCustomStorage/gamma', value: { n: 3 } }],
            [{ op: 'remove', path: '/pluginCustomStorage/beta' }],
            [{ op: 'copy', from: '/pluginCustomStorage/alpha', path: '/pluginCustomStorage/copied' }],
            [{ op: 'move', from: '/pluginCustomStorage/gamma', path: '/pluginCustomStorage/moved' }],
        ]

        for (const patch of patches) {
            const next = apply(db, patch)
            expect(cache.update(db, next, patch)).toBe(calculateHash(next))
            expect(cache.hash(next)).toBe(calculateHash(next))
            db = next
        }
    })

    it('does not rehash an untouched large direct child', () => {
        const large = { items: Array.from({ length: 500 }, (_, i) => ({ i, text: `large-${i}` })) }
        const db = {
            pluginCustomStorage: {
                large,
                touched: { n: 1 },
            },
            other: 'x',
        }
        let largeCalls = 0
        const countingHash = (value: any) => {
            if (value === large) largeCalls++
            return calculateHash(value)
        }
        const cache = createPatchHashCache(countingHash)
        expect(cache.hash(db)).toBe(calculateHash(db))
        expect(largeCalls).toBe(1)

        const patch = [{ op: 'replace', path: '/pluginCustomStorage/touched/n', value: 2 }]
        const next = apply(db, patch)
        expect(cache.update(db, next, patch)).toBe(calculateHash(next))
        expect(largeCalls).toBe(1)
    })

    it('clones only touched direct children and keeps untouched children shared', () => {
        const storage = {
            alpha: { nested: { n: 1 } },
            beta: { nested: { n: 2 } },
            gamma: { stable: true },
        }
        const patch = [
            { op: 'replace', path: '/pluginCustomStorage/alpha/nested/n', value: 9 },
            { op: 'copy', from: '/pluginCustomStorage/beta', path: '/pluginCustomStorage/copied' },
        ]
        const cloned = clonePluginStorageForPatch(storage, patch)

        expect(cloned).not.toBe(storage)
        expect(cloned.alpha).not.toBe(storage.alpha)
        expect(cloned.beta).not.toBe(storage.beta)
        expect(cloned.gamma).toBe(storage.gamma)
    })

    it('preserves the original storage when a later patch op fails', () => {
        const db = {
            pluginCustomStorage: {
                alpha: { n: 1 },
                untouched: { n: 2 },
            },
        }
        const before = structuredClone(db)
        const patch = [
            { op: 'replace', path: '/pluginCustomStorage/alpha/n', value: 5 },
            { op: 'remove', path: '/pluginCustomStorage/alpha/missing' },
        ]
        const snapshot = clonePatchSnapshot(db, patch)
        expect(() => applyPatch(snapshot, patch, true)).toThrow()
        expect(db).toEqual(before)
    })

    it('falls back for plugin storage root operations and non-object storage', () => {
        const storage = { alpha: { n: 1 }, beta: { n: 2 } }
        const rootClone = clonePluginStorageForPatch(storage, [
            { op: 'replace', path: '/pluginCustomStorage', value: { replaced: true } },
        ])
        expect(rootClone.alpha).not.toBe(storage.alpha)
        expect(rootClone.beta).not.toBe(storage.beta)

        const arrayStorage = [{ n: 1 }, { n: 2 }]
        const arrayClone = clonePluginStorageForPatch(arrayStorage, [
            { op: 'replace', path: '/pluginCustomStorage/0/n', value: 3 },
        ])
        expect(arrayClone).not.toBe(arrayStorage)
        expect(arrayClone[0]).not.toBe(arrayStorage[0])
    })

    it('tracks escaped direct-child keys plus path/from for move and copy', () => {
        const result = collectPluginStorageChildKeys([
            { op: 'move', from: '/pluginCustomStorage/a~1b/n', path: '/pluginCustomStorage/x~0y/n' },
            { op: 'copy', from: '/other/n', path: '/pluginCustomStorage/plain/n' },
        ])
        expect(result.touchesStorageRoot).toBe(false)
        expect(result.referencesStorage).toBe(true)
        expect([...result.keys].sort()).toEqual(['a/b', 'plain', 'x~y'].sort())
    })
})

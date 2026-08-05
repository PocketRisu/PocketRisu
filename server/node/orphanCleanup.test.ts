import { describe, it, expect } from 'vitest'
import pkg from './orphanCleanup.cjs'

const { findOrphans, collectAssetBasenames, GRACE_MS } = pkg as {
    findOrphans: (
        dbObj: any,
        assetEntries: { key: string; size: number; updatedAt?: number; meta?: Uint8Array }[],
        remoteEntries: { key: string; size: number; meta?: Uint8Array }[],
        uncleanable: Set<string>,
        now?: number,
    ) => { key: string; size: number; prefix: string; reason: string }[]
    GRACE_MS: number
    collectAssetBasenames: (value: unknown, target?: Set<string>) => Set<string>
}

const NOW = 1_000_000_000_000
const OLD = NOW - GRACE_MS - 1
const enc = (obj: object) => new TextEncoder().encode(JSON.stringify(obj))

describe('server-validated current-view candidate detection', () => {
    it('flags assets whose basename is not in the uncleanable set', () => {
        const db = { characters: [] }
        const assets = [{ key: 'assets/abc.png', size: 100, updatedAt: OLD }, { key: 'assets/def.png', size: 200, updatedAt: OLD }]
        const uncleanable = new Set(['abc.png'])
        const result = findOrphans(db, assets, [], uncleanable, NOW)
        expect(result).toHaveLength(1)
        expect(result[0].key).toBe('assets/def.png')
        expect(result[0].prefix).toBe('assets')
        expect(result[0].reason).toBe('unreferenced')
    })

    it('does not flag assets that ARE in the uncleanable set', () => {
        const db = { characters: [] }
        const assets = [{ key: 'assets/keep.png', size: 50, updatedAt: OLD }]
        const uncleanable = new Set(['keep.png'])
        expect(findOrphans(db, assets, [], uncleanable, NOW)).toHaveLength(0)
    })

    it('skips .meta entries', () => {
        const db = { characters: [] }
        const assets = [{ key: 'assets/orphan.png.meta', size: 10 }]
        const uncleanable = new Set<string>()
        expect(findOrphans(db, assets, [], uncleanable, NOW)).toHaveLength(0)
    })

    it('does not flag remotes whose character still exists', () => {
        const db = { characters: [{ chaId: 'ghost' }] }
        const remotes = [{ key: 'remotes/ghost.local.bin', size: 500 }]
        const uncleanable = new Set<string>()
        expect(findOrphans(db, [], remotes, uncleanable, NOW)).toHaveLength(0)
    })

    it('does not flag remotes within the 7-day grace period', () => {
        const db = { characters: [] }
        const recent = NOW - GRACE_MS + 1000
        const remotes = [{ key: 'remotes/ghost.local.bin', size: 500, meta: enc({ lastUsed: recent }) }]
        const uncleanable = new Set<string>()
        expect(findOrphans(db, [], remotes, uncleanable, NOW)).toHaveLength(0)
    })

    it('flags remotes past the 7-day grace period', () => {
        const db = { characters: [] }
        const old = NOW - GRACE_MS - 1000
        const remotes = [{ key: 'remotes/ghost.local.bin', size: 500, meta: enc({ lastUsed: old }) }]
        const uncleanable = new Set<string>()
        const result = findOrphans(db, [], remotes, uncleanable, NOW)
        expect(result).toHaveLength(1)
        expect(result[0].prefix).toBe('remotes')
        expect(result[0].reason).toBe('stale')
    })

    it('skips remotes with no .meta (grace not started)', () => {
        const db = { characters: [] }
        const remotes = [{ key: 'remotes/ghost.local.bin', size: 500 }]
        const uncleanable = new Set<string>()
        expect(findOrphans(db, [], remotes, uncleanable, NOW)).toHaveLength(0)
    })

    it('handles corrupt .meta gracefully (treats as no meta)', () => {
        const db = { characters: [] }
        const badMeta = new Uint8Array([0, 1, 2, 3])
        const remotes = [{ key: 'remotes/ghost.local.bin', size: 500, meta: badMeta }]
        const uncleanable = new Set<string>()
        expect(findOrphans(db, [], remotes, uncleanable, NOW)).toHaveLength(0)
    })

})

describe('asset cleanup safety protections', () => {
    it('preserves assets created or overwritten within the 7-day grace period', () => {
        const assets = [
            { key: 'assets/recent.png', size: 10, updatedAt: NOW - GRACE_MS + 1 },
            { key: 'assets/old.png', size: 20, updatedAt: OLD },
            { key: 'assets/unknown.png', size: 30 },
        ]
        const result = findOrphans({ characters: [] }, assets, [], new Set(), NOW)
        expect(result.map(entry => entry.key)).toEqual(['assets/old.png'])
    })

    it('collects GPT-SoVITS reference audio asset paths', () => {
        const db = {
            characters: [{
                gptSoVitsConfig: { ref_audio_data: { assetId: 'assets/reference.wav' } },
            }],
        }
        expect([...collectAssetBasenames(db)]).toEqual(['reference.wav'])
    })

    it('collects arbitrary nested plugin asset paths', () => {
        const db = {
            pluginData: {
                arbitrary: [{ futureField: 'assets/plugin-image.webp' }],
                ignored: 'https://example.invalid/assets/not-local.png',
            },
        }
        expect([...collectAssetBasenames(db)]).toEqual(['plugin-image.webp'])
    })
})

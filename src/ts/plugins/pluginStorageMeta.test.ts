import { describe, it, expect, vi, beforeEach } from 'vitest'

const db: { pluginStorageMeta?: Record<string, { plugin: string, updatedAt: number }> } = {}
vi.mock('../storage/database.svelte', () => ({ getDatabase: () => db }))
vi.mock('../storage/persistentKv', () => ({}))

const { recordOwner } = await import('./pluginStorageMeta')

describe('recordOwner', () => {
    beforeEach(() => {
        delete db.pluginStorageMeta
        localStorage.clear()
    })

    it('leaves the save record untouched when the owner is unchanged', () => {
        recordOwner('save', 'k', 'memory')
        const first = db.pluginStorageMeta!.k
        recordOwner('save', 'k', 'memory')
        // Same object: the root key pluginStorageMeta did not change.
        expect(db.pluginStorageMeta!.k).toBe(first)
    })

    it('records a new owner in the save backend', () => {
        recordOwner('save', 'k', 'memory')
        recordOwner('save', 'k', 'other')
        expect(db.pluginStorageMeta!.k.plugin).toBe('other')
    })

    it('does not rewrite the local map when the owner is unchanged', () => {
        recordOwner('local', 'k', 'memory')
        const setItem = vi.spyOn(localStorage, 'setItem')
        recordOwner('local', 'k', 'memory')
        expect(setItem).not.toHaveBeenCalled()
        recordOwner('local', 'k', 'other')
        expect(setItem).toHaveBeenCalledTimes(1)
        setItem.mockRestore()
    })
})

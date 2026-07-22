import { describe, expect, it } from 'vitest'
import { findTrackedDeletionConflict, mergeThreeWayValue, mergeTrackedChanges } from './conflictRebase'

describe('conflict rebase', () => {
    it('preserves local edits made while the original save was in flight', () => {
        const base = {
            username: 'old',
            characters: [{
                chaId: 'a',
                name: 'old char',
                chats: [{ id: 'c1', name: 'old chat', _stub: true }],
            }],
        }
        const local = {
            username: 'typed while waiting',
            characters: [{
                chaId: 'a',
                name: 'locally edited',
                chats: [{ id: 'c1', name: 'old chat', message: [{ role: 'user', data: 'new' }] }],
            }],
        }
        const remote = {
            username: 'old',
            characters: [{
                chaId: 'a',
                name: 'old char',
                chats: [{ id: 'c1', name: 'renamed remotely', _stub: true }],
            }],
        }

        const merged = mergeThreeWayValue(base, local, remote)
        expect(merged.username).toBe('typed while waiting')
        expect(merged.characters[0].name).toBe('locally edited')
        expect(merged.characters[0].chats[0].name).toBe('renamed remotely')
        expect(merged.characters[0].chats[0].message).toEqual([{ role: 'user', data: 'new' }])
        expect(merged.characters[0].chats[0]._stub).toBeUndefined()
    })

    it('does not revive a remotely deleted chat or lose a remote addition', () => {
        const base = [{
            chaId: 'a',
            chats: [
                { id: 'keep', name: 'Keep', _stub: true },
                { id: 'deleted', name: 'Deleted', _stub: true },
            ],
        }]
        const local = [{
            chaId: 'a',
            chats: [
                { id: 'keep', name: 'Local rename', message: [] },
                { id: 'deleted', name: 'Deleted', message: [{ role: 'user', data: 'stale' }] },
                { id: 'local-new', name: 'Local new', message: [] },
            ],
        }]
        const remote = [{
            chaId: 'a',
            chats: [
                { id: 'keep', name: 'Keep', _stub: true },
                { id: 'remote-new', name: 'Remote new', _stub: true },
            ],
        }]

        const merged = mergeThreeWayValue(base, local, remote)
        const ids = merged[0].chats.map((chat: any) => chat.id)
        expect(ids).toEqual(['keep', 'local-new', 'remote-new'])
        expect(merged[0].chats.find((chat: any) => chat.id === 'keep').name).toBe('Local rename')
    })

    it('keeps remote metadata when hydration is the only local shape change', () => {
        const base = [{ chaId: 'a', chats: [{ id: 'c', name: 'Old', _stub: true }] }]
        const local = [{ chaId: 'a', chats: [{ id: 'c', name: 'Old', _placeholder: true, message: [] }] }]
        const remote = [{ chaId: 'a', chats: [{ id: 'c', name: 'Remote', folderId: 'f', _stub: true }] }]

        const merged = mergeThreeWayValue(base, local, remote)
        expect(merged[0].chats[0]).toMatchObject({
            id: 'c',
            name: 'Remote',
            folderId: 'f',
            _placeholder: true,
            message: [],
        })
    })

    it('combines pending tracker entries without duplicates', () => {
        const primary = {
            character: ['a'],
            chat: [['a', 'c1']] as [string, string][],
            root: false,
            botPreset: true,
            modules: false,
            plugins: false,
            pluginCustomStorage: false,
        }
        const pending = {
            character: ['a', 'b'],
            chat: [['a', 'c1'], ['b', 'c2']] as [string, string][],
            root: true,
            botPreset: false,
            modules: true,
            plugins: false,
            pluginCustomStorage: true,
        }

        expect(mergeTrackedChanges(primary, pending)).toEqual({
            character: ['a', 'b'],
            chat: [['a', 'c1'], ['b', 'c2']],
            root: true,
            botPreset: true,
            modules: true,
            plugins: false,
            pluginCustomStorage: true,
        })
    })

    it('detects inactive chat metadata edits racing a remote deletion', () => {
        const base = {
            characters: [{ chaId: 'a', chats: [{ id: 'c', name: 'Old', _stub: true }] }],
        }
        const local = {
            characters: [{ chaId: 'a', chats: [{ id: 'c', name: 'Renamed', _placeholder: true, message: [] }] }],
        }
        const remote = {
            characters: [{ chaId: 'a', chats: [] }],
        }
        const changes = {
            character: ['a'],
            chat: [] as [string, string][],
            root: false,
            botPreset: false,
            modules: false,
            plugins: false,
            pluginCustomStorage: false,
        }
        const toMetadata = (chat: any) => ({ id: chat.id, name: chat.name, _stub: true })

        expect(findTrackedDeletionConflict(base, local, remote, changes, toMetadata)).toEqual({
            scope: 'chat-metadata',
            charId: 'a',
            chatId: 'c',
        })
    })

    it('does not treat placeholder hydration alone as a metadata edit', () => {
        const base = {
            characters: [{ chaId: 'a', chats: [{ id: 'c', name: 'Same', _stub: true }] }],
        }
        const local = {
            characters: [{ chaId: 'a', chats: [{ id: 'c', name: 'Same', _placeholder: true, message: [] }] }],
        }
        const remote = { characters: [{ chaId: 'a', chats: [] }] }
        const changes = {
            character: ['a'],
            chat: [] as [string, string][],
            root: false,
            botPreset: false,
            modules: false,
            plugins: false,
            pluginCustomStorage: false,
        }
        const toMetadata = (chat: any) => ({ id: chat.id, name: chat.name, _stub: true })

        expect(findTrackedDeletionConflict(base, local, remote, changes, toMetadata)).toBeNull()
    })
})

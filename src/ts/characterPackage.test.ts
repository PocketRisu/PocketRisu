import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fflate from 'fflate'

const db = { characters: [] as any[], personas: [] as any[] }
const alertError = vi.fn()
const notifySuccess = vi.fn()
const importCharacterProcess = vi.fn()
let packageZip: Uint8Array

vi.mock('fflate', async (orig) => {
    const actual = await orig<typeof import('fflate')>()
    return {
        ...actual,
        unzip: (data: Uint8Array, cb: (err: unknown, out?: fflate.Unzipped) => void) => {
            try { cb(null, actual.unzipSync(data)) } catch (err) { cb(err) }
        },
    }
})
vi.mock('./util', () => ({ selectSingleFile: async () => ({ name: 'package.zip', data: packageZip }) }))
vi.mock('./alert', () => ({
    alertConfirm: async () => true,
    alertError: (e: unknown) => alertError(e),
    alertStore: { set: () => {} },
    alertWait: () => {},
    notifySuccess: (m: string) => notifySuccess(m),
}))
vi.mock('./characterCards', () => ({
    exportCharacterCard: vi.fn(),
    importCharacterProcess: (arg: unknown) => importCharacterProcess(arg),
}))
vi.mock('./globalApi.svelte', () => ({
    LocalWriter: class {},
    VirtualWriter: class {},
    readImage: vi.fn(),
    checkCharOrder: () => {},
}))
vi.mock('src/lang', () => ({ language: new Proxy({}, { get: (_t, key) => String(key) }) }))
vi.mock('./storage/database.svelte', () => ({
    getDatabase: () => db,
    setDatabase: () => {},
    saveImage: vi.fn(),
    normalizeChat: (chat: unknown) => chat,
}))
vi.mock('./storage/chatStorage', () => ({ fetchChatFromServer: vi.fn() }))
vi.mock('./characters', () => ({ createBlankChar: () => ({ name: '', chaId: 'blank', chats: [] }) }))
vi.mock('./process/processzip', () => ({ CharXWriter: class {} }))
vi.mock('./process/files/inlays', () => ({
    getInlayAsset: vi.fn(), setInlayAsset: vi.fn(), getInlayInfosBatch: vi.fn(), reencodeImage: vi.fn(),
}))
vi.mock('./process/files/inlayMeta', () => ({ getInlayMeta: vi.fn(), setInlayMeta: vi.fn() }))
vi.mock('./pngChunk', () => ({ PngChunk: {} }))

const { importCharacterPackage } = await import('./characterPackage')

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

describe('importCharacterPackage', () => {
    beforeEach(() => {
        alertError.mockClear()
        importCharacterProcess.mockReset()
        notifySuccess.mockClear()
        db.characters = [{
            name: 'Existing',
            chaId: 'existing',
            chatPage: 0,
            chats: [{ name: 'My chat', message: [{ role: 'user', data: 'mine' }] }],
        }]
        packageZip = fflate.zipSync({
            'manifest.json': json({
                type: 'risuCharacterPackage',
                version: 1,
                createdAt: '',
                character: { name: 'Packaged', file: 'character/packaged.charx' },
                chats: { count: 1, file: 'chats.json' },
            }),
            'character/packaged.charx': new Uint8Array([1, 2, 3]),
            'chats.json': json({ type: 'risuAllChats', ver: 2, data: [{ name: 'Package chat', message: [] }] }),
        })
    })

    it('adds nothing when the card is declined, even if another device added a character', async () => {
        // A declined low-level access prompt: with returnCharacter the importer
        // gives false. Meanwhile a rebase brought in a character from another
        // device, so the count alone would look like a success.
        importCharacterProcess.mockImplementation(async () => {
            db.characters.push({ name: 'Remote', chaId: 'remote', chats: [] })
            return false
        })
        await importCharacterPackage()
        expect(importCharacterProcess).toHaveBeenCalledWith(expect.objectContaining({ returnCharacter: true }))
        expect(db.characters.map((c: { chaId: string }) => c.chaId)).toEqual(['existing', 'remote'])
        expect(db.characters[0].chats.map((c: { name: string }) => c.name)).toEqual(['My chat'])
        expect(db.characters[1].chats).toEqual([])
        expect(alertError).toHaveBeenCalled()
        expect(notifySuccess).not.toHaveBeenCalled()
    })

    it('gives the package chats to the card it imported', async () => {
        // returnCharacter hands the card back without adding it.
        importCharacterProcess.mockImplementation(async () => ({ name: 'Packaged', chaId: 'packaged', chats: [] }))
        await importCharacterPackage()
        expect(db.characters.map((c: { chaId: string }) => c.chaId)).toEqual(['existing', 'packaged'])
        expect(db.characters[0].chats.map((c: { name: string }) => c.name)).toEqual(['My chat'])
        expect(db.characters[1].chats.map((c: { name: string }) => c.name)).toEqual(['Package chat'])
        expect(notifySuccess).toHaveBeenCalled()
    })
})

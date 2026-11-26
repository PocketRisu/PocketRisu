import { writable } from 'svelte/store'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const trackChatForSave = vi.fn()
const requestImmediateSave = vi.fn()
const selectedCharID = writable(0)
const DBState = { db: { characters: [] as any[] } }

vi.mock('../globalApi.svelte', () => ({ requestImmediateSave, trackChatForSave }))
vi.mock('../stores.svelte', () => ({ DBState, selectedCharID }))

const { getSendTarget, saveSendTargetIfHidden } = await import('./sendTarget')

function char(chaId: string, chats: any[], chatPage = 0) {
    return { chaId, chats, chatPage } as any
}

beforeEach(() => {
    trackChatForSave.mockClear()
    requestImmediateSave.mockClear()
    selectedCharID.set(0)
})

describe('reply save for the chat a send wrote to', () => {
    test('nothing extra while the chat is still on screen', () => {
        DBState.db.characters = [char('x', [{ id: 'a' }, { id: 'b' }])]
        const target = getSendTarget()
        saveSendTargetIfHidden(target)
        expect(trackChatForSave).not.toHaveBeenCalled()
        expect(requestImmediateSave).not.toHaveBeenCalled()
    })

    test('queued after another chat of the character was opened', () => {
        DBState.db.characters = [char('x', [{ id: 'a' }, { id: 'b' }])]
        const target = getSendTarget()
        DBState.db.characters[0].chatPage = 1
        saveSendTargetIfHidden(target)
        expect(trackChatForSave).toHaveBeenCalledWith('x', 'a')
        expect(requestImmediateSave).toHaveBeenCalled()
    })

    test('queued after another character was opened, even if characters moved', () => {
        DBState.db.characters = [char('x', [{ id: 'a' }]), char('y', [{ id: 'c' }])]
        const target = getSendTarget()
        DBState.db.characters.reverse()
        selectedCharID.set(0)
        saveSendTargetIfHidden(target)
        expect(trackChatForSave).toHaveBeenCalledWith('x', 'a')
    })

    test('skipped when the chat is gone or now an unloaded placeholder', () => {
        DBState.db.characters = [char('x', [{ id: 'a' }, { id: 'b' }])]
        const target = getSendTarget()
        DBState.db.characters[0].chatPage = 1
        DBState.db.characters[0].chats[0] = { id: 'a', _placeholder: true }
        saveSendTargetIfHidden(target)
        DBState.db.characters[0].chats.splice(0, 1)
        DBState.db.characters[0].chatPage = 0
        saveSendTargetIfHidden(target)
        expect(trackChatForSave).not.toHaveBeenCalled()
    })

    test('skipped for a legacy chat without an id', () => {
        DBState.db.characters = [char('x', [{}, { id: 'b' }])]
        const target = getSendTarget()
        DBState.db.characters[0].chatPage = 1
        saveSendTargetIfHidden(target)
        expect(trackChatForSave).not.toHaveBeenCalled()
    })
})

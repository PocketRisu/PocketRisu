import { get } from 'svelte/store'
import { requestImmediateSave, trackChatForSave } from '../globalApi.svelte'
import { DBState, selectedCharID } from '../stores.svelte'

export type SendTarget = { chaId?: string, chatId?: string }

/** The chat a send writes to: the one on screen when it starts. */
export function getSendTarget(): SendTarget {
    const char = DBState.db.characters[get(selectedCharID)]
    return { chaId: char?.chaId, chatId: char?.chats?.[char.chatPage]?.id }
}

/**
 * Only the chat on screen is saved on its own. If the user moved to another
 * chat while the reply came in, queue the send's chat, or the reply is lost
 * on reload (its server job is already claimed).
 */
export function saveSendTargetIfHidden({ chaId, chatId }: SendTarget) {
    if (!chaId || !chatId) return
    const target = DBState.db.characters.find((c) => c?.chaId === chaId)?.chats?.find((c) => c?.id === chatId)
    // Gone, or reloaded as an unloaded placeholder: nothing to save.
    if (!target || target._placeholder) return
    const shown = DBState.db.characters[get(selectedCharID)]
    if (shown?.chaId === chaId && shown?.chats?.[shown.chatPage]?.id === chatId) return
    trackChatForSave(chaId, chatId)
    void requestImmediateSave()
}

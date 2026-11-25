import type { Message } from '../storage/database.svelte'

// Continue appends to the last reply. Update it in place: a new object
// dropped its swipes, name and disabled state. The original chatId stays,
// since older jobs match on it (jobRecovery secondary match).
export function writeContinuedMessage(
    messages: Message[],
    index: number,
    update: Pick<Message, 'role' | 'data' | 'saying' | 'time' | 'generationInfo' | 'promptInfo'>,
    newChatId: string,
){
    const target = messages[index]
    if(!target){
        messages[index] = { ...update, chatId: newChatId }
        return
    }
    Object.assign(target, update)
    target.chatId ??= newChatId
}

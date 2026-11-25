import type { OpenAIChat } from './index.svelte'

// Whether a prompt message carries anything a provider can take. A message left
// as only whitespace (an editRequest trigger, a plugin or a depth prompt that
// emptied it) is rejected outright by Anthropic and Gemini. Function results
// stay even when empty: dropping one breaks the call it answers. Content that
// is not a string (a plugin may hand back content parts) is not ours to judge.
export function hasMessagePayload(message: OpenAIChat): boolean {
    if (message.role === 'function') return true
    if (message.multimodals && message.multimodals.length > 0) return true
    if (message.thoughts && message.thoughts.length > 0) return true
    const content: unknown = message.content
    if (content === null || content === undefined) return false
    if (typeof content !== 'string') return true
    return content.trim() !== ''
}

// Drops messages with no payload, without changing the input array or its
// messages. A cache point on a dropped message moves to (a copy of) the message
// before it, which ends the same cached prefix. A prompt with nothing left is
// returned as it was: several request builders read formated[0] unguarded, and
// the provider rejecting it is the ordinary failure it always was.
export function removeEmptyChatMessages(messages: OpenAIChat[]): OpenAIChat[] {
    if (messages.every(hasMessagePayload)) return messages
    if (!messages.some(hasMessagePayload)) return messages
    const kept: OpenAIChat[] = []
    for (const message of messages) {
        if (hasMessagePayload(message)) {
            kept.push(message)
            continue
        }
        if (message.cachePoint && kept.length > 0 && !kept[kept.length - 1].cachePoint) {
            kept[kept.length - 1] = { ...kept[kept.length - 1], cachePoint: true }
        }
    }
    return kept
}

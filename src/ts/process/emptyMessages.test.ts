import { describe, it, expect } from 'vitest'
import { removeEmptyChatMessages } from './emptyMessages'
import type { OpenAIChat } from './index.svelte'

describe('removeEmptyChatMessages', () => {
    it('drops whitespace-only messages and keeps the rest in order', () => {
        const messages: OpenAIChat[] = [
            { role: 'system', content: 'rules' },
            { role: 'user', content: ' \n\t ' },
            { role: 'assistant', content: 'hi' },
            { role: 'user', content: '' },
        ]
        expect(removeEmptyChatMessages(messages).map((m) => m.content)).toEqual(['rules', 'hi'])
    })

    it('keeps messages that carry images, thoughts or a function result', () => {
        const messages: OpenAIChat[] = [
            { role: 'user', content: ' ', multimodals: [{ type: 'image', base64: 'x' }] },
            { role: 'assistant', content: '', thoughts: ['thinking'] },
            { role: 'function', content: '' },
        ]
        expect(removeEmptyChatMessages(messages)).toHaveLength(3)
    })

    it('moves a cache point off a dropped message onto the one before it', () => {
        const messages: OpenAIChat[] = [
            { role: 'system', content: 'rules' },
            { role: 'user', content: 'question' },
            { role: 'user', content: '  ', cachePoint: true },
            { role: 'assistant', content: 'answer' },
        ]
        const kept = removeEmptyChatMessages(messages)
        expect(kept.map((m) => m.content)).toEqual(['rules', 'question', 'answer'])
        expect(kept[1].cachePoint).toBe(true)
        // The input stays as it was: a retry runs the plugins on it again.
        expect(messages).toHaveLength(4)
        expect(messages[1].cachePoint).toBeUndefined()
    })

    it('keeps content that is not a string and drops missing content', () => {
        const parts = [{ type: 'text', text: 'hi' }]
        const messages = [
            { role: 'user', content: parts },
            { role: 'user', content: undefined },
            { role: 'user', content: null },
        ] as unknown as OpenAIChat[]
        const kept = removeEmptyChatMessages(messages)
        expect(kept).toHaveLength(1)
        expect(kept[0].content).toBe(parts)
    })

    it('returns a prompt with nothing left as it was', () => {
        const messages: OpenAIChat[] = [
            { role: 'system', content: ' ' },
            { role: 'user', content: '' },
        ]
        expect(removeEmptyChatMessages(messages)).toBe(messages)
        expect(removeEmptyChatMessages([])).toEqual([])
    })

    it('returns the same array when nothing is empty', () => {
        const messages: OpenAIChat[] = [{ role: 'user', content: 'a' }]
        expect(removeEmptyChatMessages(messages)).toBe(messages)
    })
})

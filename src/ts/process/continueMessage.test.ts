import { describe, test, expect } from 'vitest'
import { writeContinuedMessage } from './continueMessage'
import type { Message } from '../storage/database.svelte'

const update = (data: string) => ({
    role: 'char' as const,
    data,
    saying: 'char-1',
    time: 2,
    generationInfo: { model: 'm' },
    promptInfo: undefined,
})

describe('continue', () => {
    test('updates the reply in place, keeping its swipes, name and id', () => {
        const swipes = ['A', 'B', 'C']
        const messages: Message[] = [{
            role: 'char', data: 'B', chatId: 'old-id', saying: 'char-1', time: 1,
            swipes, swipeId: 1, name: 'Bob', disabled: false,
        }]
        writeContinuedMessage(messages, 0, update('B and more'), 'new-id')
        expect(messages[0]).toMatchObject({
            data: 'B and more', chatId: 'old-id', swipeId: 1, name: 'Bob', disabled: false,
        })
        expect(messages[0].swipes).toBe(swipes)
    })

    test('a message without an id gets the new one', () => {
        const messages: Message[] = [{ role: 'char', data: 'x' }]
        writeContinuedMessage(messages, 0, update('x y'), 'new-id')
        expect(messages[0]).toMatchObject({ data: 'x y', chatId: 'new-id' })
    })

    test('a missing message is written fresh with the new id', () => {
        const messages: Message[] = []
        writeContinuedMessage(messages, 0, update('z'), 'new-id')
        expect(messages[0]).toMatchObject({ data: 'z', chatId: 'new-id' })
    })
})

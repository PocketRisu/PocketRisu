import { describe, expect, test, vi } from 'vitest'

// shared.ts imports getDatabase at module load; stub it so this pure-helper test
// stays off the big database import graph (mirrors modelPresetBinding.test.ts).
vi.mock('src/ts/storage/database.svelte', () => ({
    getDatabase: () => ({}),
}))

import { collectStreamingText } from './shared'

// collectStreamingText underpins per-preset decoupled streaming: the wire stays
// SSE, but the stream is drained to a single string. Every chunk carries the
// FULL accumulated text in its first key, so draining must return the LAST
// chunk's first-key value (not a concatenation of deltas).

function streamOf(chunks: Array<{ [key: string]: string }>): ReadableStream<{ [key: string]: string }> {
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk)
            controller.close()
        },
    })
}

describe('collectStreamingText', () => {
    test('returns the last chunk because chunks are cumulative, not deltas', async () => {
        const stream = streamOf([{ '0': 'He' }, { '0': 'Hello' }, { '0': 'Hello world' }])
        expect(await collectStreamingText(stream)).toBe('Hello world')
    })

    test('preserves a reasoning-prefixed final chunk verbatim', async () => {
        const final = '<Thoughts>\nthinking\n</Thoughts>\n\nanswer'
        const stream = streamOf([{ '0': '<Thoughts>' }, { '0': final }])
        expect(await collectStreamingText(stream)).toBe(final)
    })

    test('reads the first key only (multiGen sidecar indices are ignored)', async () => {
        const stream = streamOf([{ '0': 'main', '1': 'second' }])
        expect(await collectStreamingText(stream)).toBe('main')
    })

    test('returns empty string for an empty stream', async () => {
        const stream = streamOf([])
        expect(await collectStreamingText(stream)).toBe('')
    })
})

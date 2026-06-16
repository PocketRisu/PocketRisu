import { describe, expect, test, vi } from 'vitest'
import { StreamFlushThrottle, pumpPresetStream, type StreamChunkController } from './presetStreamPump'
import type { AdapterChatStreamDelta } from 'src/ts/preset/adapter'

// --- StreamFlushThrottle (pure, injected clock) -----------------------------
//
// The throttle never touches real time or timers: onDelta/onTrailing/onEnd take
// `now` and read desiredSize through a closure, so flush decisions are fully
// deterministic here. The trailing-timer wiring is exercised by the pump tests.

function makeThrottle(initialDesiredSize: number | null = 1) {
    const enqueued: string[] = []
    let text = ''
    let desiredSize = initialDesiredSize
    const throttle = new StreamFlushThrottle(
        50,
        (chunk) => enqueued.push(chunk),
        () => text,
        () => desiredSize,
    )
    return {
        enqueued,
        throttle,
        append: (s: string) => { text += s },
        setDesiredSize: (n: number | null) => { desiredSize = n },
    }
}

describe('StreamFlushThrottle', () => {
    test('flushes the first delta immediately regardless of clock', () => {
        const h = makeThrottle()
        h.append('a')
        expect(h.throttle.onDelta(1_000_000)).toBe(false)
        expect(h.enqueued).toEqual(['a'])
    })

    test('coalesces deltas within the interval into one flush', () => {
        const h = makeThrottle()
        h.append('a'); h.throttle.onDelta(0)             // first -> flush 'a'
        h.append('b'); expect(h.throttle.onDelta(10)).toBe(true)  // <50ms -> pending
        h.append('c'); expect(h.throttle.onDelta(20)).toBe(true)  // still pending
        expect(h.enqueued).toEqual(['a'])
        h.append('d'); expect(h.throttle.onDelta(60)).toBe(false) // 60>=50 -> flush 'abcd'
        expect(h.enqueued).toEqual(['a', 'abcd'])
    })

    test('flushes the tail via onTrailing when the stream goes quiet (P1)', () => {
        const h = makeThrottle()
        h.append('a'); h.throttle.onDelta(0)             // flush 'a'
        h.append('b'); expect(h.throttle.onDelta(10)).toBe(true)  // pending 'ab'
        // no further deltas; the trailing timer fires
        expect(h.throttle.onTrailing(60)).toBe(false)
        expect(h.enqueued).toEqual(['a', 'ab'])
    })

    test('onEnd forces the final flush even under backpressure', () => {
        const h = makeThrottle()
        h.append('a'); h.throttle.onDelta(0)             // flush 'a'
        h.append('b'); h.throttle.onDelta(10)            // pending 'ab'
        h.setDesiredSize(0)                              // consumer full
        h.throttle.onEnd(20)
        expect(h.enqueued).toEqual(['a', 'ab'])
    })

    test('skips flushes under backpressure and emits only the latest on recovery (P2)', () => {
        const h = makeThrottle()
        h.append('a'); h.throttle.onDelta(0)             // flush 'a' (desiredSize 1)
        h.setDesiredSize(0)                              // consumer full
        h.append('b'); expect(h.throttle.onDelta(60)).toBe(true)   // interval ok but skipped
        h.append('c'); expect(h.throttle.onDelta(120)).toBe(true)  // still skipped
        expect(h.enqueued).toEqual(['a'])               // stale 'ab' never enqueued
        h.setDesiredSize(1)                             // consumer recovers
        expect(h.throttle.onTrailing(180)).toBe(false)  // flush latest only
        expect(h.enqueued).toEqual(['a', 'abc'])
    })

    test('keeps pending (requesting re-arm) while backpressure persists', () => {
        const h = makeThrottle()
        h.append('a'); h.throttle.onDelta(0)             // flush 'a'
        h.setDesiredSize(-1)
        h.append('b'); h.throttle.onDelta(60)            // skipped, pending
        expect(h.throttle.onTrailing(120)).toBe(true)    // still backpressured -> re-arm
        expect(h.throttle.onTrailing(180)).toBe(true)
        h.setDesiredSize(2)
        expect(h.throttle.onTrailing(240)).toBe(false)   // recovered -> flush
        expect(h.enqueued).toEqual(['a', 'ab'])
    })

    test('treats null desiredSize as no backpressure', () => {
        const h = makeThrottle(null)
        h.append('a'); expect(h.throttle.onDelta(0)).toBe(false)
        expect(h.enqueued).toEqual(['a'])
    })

    test('does not flush or duplicate when nothing is pending', () => {
        const h = makeThrottle()
        h.append('a'); h.throttle.onDelta(0)             // flush 'a', nothing pending
        expect(h.throttle.onTrailing(100)).toBe(false)
        h.throttle.onEnd(200)
        expect(h.enqueued).toEqual(['a'])
    })
})

// --- pumpPresetStream (integration with timers) -----------------------------

function makeController(desiredSize: number | null = 1) {
    const enqueued: Array<{ [key: string]: string }> = []
    const state = {
        enqueued,
        closed: false,
        errored: undefined as unknown,
        desiredSize,
        enqueue(chunk: { [key: string]: string }) { enqueued.push(chunk) },
        close() { state.closed = true },
        error(err: unknown) { state.errored = err },
    }
    return state
}

async function* genOf(
    ...deltas: Array<Partial<AdapterChatStreamDelta>>
): AsyncGenerator<AdapterChatStreamDelta, void, void> {
    for (const d of deltas) {
        yield { textDelta: '', raw: null, ...d }
    }
}

const passthroughReasoning = (t: string) => t

describe('pumpPresetStream', () => {
    test('pumps deltas through and closes, leaking no timer', async () => {
        vi.useFakeTimers()
        try {
            const controller = makeController()
            await pumpPresetStream(genOf({ textDelta: 'a' }, { textDelta: 'b' }), controller, {
                intervalMs: 50,
                formatReasoning: passthroughReasoning,
            })
            // 'a' flushes immediately; 'b' coalesces and lands in the final flush
            expect(controller.enqueued).toEqual([{ '0': 'a' }, { '0': 'ab' }])
            expect(controller.closed).toBe(true)
            expect(vi.getTimerCount()).toBe(0)
        } finally {
            vi.useRealTimers()
        }
    })

    test('wraps reasoning via formatReasoning, separate from the answer text', async () => {
        vi.useFakeTimers()
        try {
            const controller = makeController()
            await pumpPresetStream(
                genOf({ reasoningDelta: 'why' }, { textDelta: 'answer' }),
                controller,
                { intervalMs: 50, formatReasoning: (t) => `<R>${t}</R>` },
            )
            expect(controller.enqueued).toEqual([
                { '0': '<R>why</R>' },
                { '0': '<R>why</R>answer' },
            ])
        } finally {
            vi.useRealTimers()
        }
    })

    test('fires a trailing flush when the stream pauses mid-response', async () => {
        vi.useFakeTimers()
        try {
            const controller = makeController()
            let release!: () => void
            const gate = new Promise<void>((r) => { release = r })
            async function* paused(): AsyncGenerator<AdapterChatStreamDelta, void, void> {
                yield { textDelta: 'a', raw: null }
                yield { textDelta: 'b', raw: null }
                await gate
                yield { textDelta: 'c', raw: null }
            }
            const done = pumpPresetStream(paused(), controller, {
                intervalMs: 50,
                formatReasoning: passthroughReasoning,
            })
            // drain microtasks so the generator reaches `await gate`
            await vi.advanceTimersByTimeAsync(1)
            expect(controller.enqueued).toEqual([{ '0': 'a' }]) // 'b' still pending
            // trailing timer (armed at t=0, delay 50) fires -> flush 'ab'
            await vi.advanceTimersByTimeAsync(60)
            expect(controller.enqueued).toEqual([{ '0': 'a' }, { '0': 'ab' }])
            release()
            await done
            expect(controller.enqueued).toEqual([{ '0': 'a' }, { '0': 'ab' }, { '0': 'abc' }])
            expect(controller.closed).toBe(true)
            expect(vi.getTimerCount()).toBe(0)
        } finally {
            vi.useRealTimers()
        }
    })

    test('forces the final flush even when the consumer stays backpressured', async () => {
        vi.useFakeTimers()
        try {
            const controller = makeController(0) // always full
            await pumpPresetStream(genOf({ textDelta: 'a' }, { textDelta: 'b' }), controller, {
                intervalMs: 50,
                formatReasoning: passthroughReasoning,
            })
            // every throttled flush skipped; onEnd forces the latest snapshot out
            expect(controller.enqueued).toEqual([{ '0': 'ab' }])
            expect(controller.closed).toBe(true)
            expect(vi.getTimerCount()).toBe(0)
        } finally {
            vi.useRealTimers()
        }
    })

    test('routes generator errors to controller.error and onError, clearing timers', async () => {
        vi.useFakeTimers()
        try {
            const controller = makeController(0) // backpressure -> a trailing timer is armed before the throw
            const onError = vi.fn()
            const boom = new Error('aborted mid-stream')
            async function* exploding(): AsyncGenerator<AdapterChatStreamDelta, void, void> {
                yield { textDelta: 'a', raw: null }
                throw boom
            }
            await pumpPresetStream(exploding(), controller, {
                intervalMs: 50,
                formatReasoning: passthroughReasoning,
                onError,
            })
            expect(controller.errored).toBe(boom)
            expect(onError).toHaveBeenCalledWith(boom)
            expect(controller.closed).toBe(false)
            expect(vi.getTimerCount()).toBe(0) // catch cleared the armed trailing timer
        } finally {
            vi.useRealTimers()
        }
    })

    test('onDelta observes every raw delta, before throttling', async () => {
        vi.useFakeTimers()
        try {
            const controller = makeController()
            const seen: Array<Partial<AdapterChatStreamDelta>> = []
            await pumpPresetStream(
                genOf({ reasoningDelta: 'why' }, { textDelta: 'a' }, { textDelta: 'b' }),
                controller,
                {
                    intervalMs: 50,
                    formatReasoning: passthroughReasoning,
                    onDelta: (d) => seen.push({ reasoningDelta: d.reasoningDelta, textDelta: d.textDelta }),
                },
            )
            // onDelta fires once per delta even though 'a'/'b' coalesce into one flush.
            expect(seen).toEqual([
                { reasoningDelta: 'why', textDelta: '' },
                { reasoningDelta: undefined, textDelta: 'a' },
                { reasoningDelta: undefined, textDelta: 'b' },
            ])
        } finally {
            vi.useRealTimers()
        }
    })

    test('onFinish reports done with the last usage seen', async () => {
        vi.useFakeTimers()
        try {
            const controller = makeController()
            const onFinish = vi.fn()
            await pumpPresetStream(
                genOf(
                    { textDelta: 'a' },
                    { textDelta: 'b', usage: { completionTokens: 7 } },
                ),
                controller,
                { intervalMs: 50, formatReasoning: passthroughReasoning, onFinish },
            )
            expect(onFinish).toHaveBeenCalledTimes(1)
            expect(onFinish).toHaveBeenCalledWith('done', { completionTokens: 7 })
        } finally {
            vi.useRealTimers()
        }
    })

    test('onFinish reports failed when the stream throws', async () => {
        vi.useFakeTimers()
        try {
            const controller = makeController()
            const onFinish = vi.fn()
            async function* exploding(): AsyncGenerator<AdapterChatStreamDelta, void, void> {
                yield { textDelta: 'a', raw: null }
                throw new Error('boom')
            }
            await pumpPresetStream(exploding(), controller, {
                intervalMs: 50,
                formatReasoning: passthroughReasoning,
                onFinish,
            })
            expect(onFinish).toHaveBeenCalledTimes(1)
            expect(onFinish.mock.calls[0][0]).toBe('failed')
        } finally {
            vi.useRealTimers()
        }
    })
})

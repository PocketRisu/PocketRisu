import type { AdapterChatStreamDelta } from "src/ts/preset/adapter"

// Coalesces streaming deltas into throttled renderer flushes.
//
// Adapters yield one delta per token; the chat renderer re-parses the whole
// accumulated message (markdown + sanitize) on every emitted chunk, so emitting
// per token makes re-parse cost scale with token count and stalls slow devices.
// This throttle keeps every delta (the pump accumulates text and exposes it via
// buildChunk) but bounds how often a chunk reaches the renderer:
//
//   - the first delta flushes immediately (lastFlushAt starts at -Infinity),
//   - subsequent deltas flush at most once per intervalMs,
//   - a flush is skipped while the consumer signals backpressure
//     (desiredSize <= 0); since each chunk is the full accumulated text, the
//     skipped snapshot is superseded by the next flush, so no data is lost and
//     stale intermediate snapshots never pile up on a slow renderer,
//   - onEnd forces a final flush, ignoring backpressure, so the last tokens
//     (or a short response that never crossed the interval) always render.
//
// The class is pure aside from the injected effects: its flush decisions are
// driven by an injected clock (`now`) and desiredSize reader, so they are
// unit-testable without real timers. Trailing-timer scheduling lives in the
// pump below.
export class StreamFlushThrottle {
    private lastFlushAt = -Infinity
    private pending = false

    constructor(
        private readonly intervalMs: number,
        private readonly enqueue: (chunk: string) => void,
        private readonly buildChunk: () => string,
        private readonly desiredSize: () => number | null,
    ) {}

    // Call after accumulating a delta. Returns true if a flush is still pending
    // (interval not elapsed, or skipped by backpressure) so the caller arms a
    // trailing timer; false if it flushed and nothing is outstanding.
    onDelta(now: number): boolean {
        this.pending = true
        if (now - this.lastFlushAt >= this.intervalMs) {
            this.flush(now, false)
        }
        return this.pending
    }

    // Call when the trailing timer fires. Returns true if still pending (the
    // flush was skipped by backpressure) so the caller re-arms the timer.
    onTrailing(now: number): boolean {
        this.flush(now, false)
        return this.pending
    }

    // Call when the stream ends. Forces the final chunk out regardless of
    // backpressure so the last accumulated text always reaches the renderer.
    onEnd(now: number): void {
        this.flush(now, true)
    }

    private flush(now: number, force: boolean): void {
        if (!this.pending) {
            return
        }
        if (!force) {
            const ds = this.desiredSize()
            if (ds !== null && ds <= 0) {
                return
            }
        }
        this.enqueue(this.buildChunk())
        this.lastFlushAt = now
        this.pending = false
    }
}

// Minimal slice of ReadableStreamDefaultController the pump needs. A real
// ReadableStreamDefaultController<{[k:string]:string}> satisfies this, and a
// fake one keeps the pump testable without constructing a stream.
export interface StreamChunkController {
    enqueue(chunk: { [key: string]: string }): void
    close(): void
    error(err: unknown): void
    readonly desiredSize: number | null
}

export interface PumpPresetStreamOptions {
    intervalMs: number
    // Wraps accumulated reasoning text for display (e.g. in <Thoughts>). Called
    // only when reasoning is present. Kept injected so the pump stays free of
    // request.ts's formatting/import graph.
    formatReasoning: (reasoningText: string) => string
    // Side-channel for logging the error; controller.error is always called too.
    onError?: (err: unknown) => void
}

// Drains an adapter stream into a chunk controller, accumulating text/reasoning
// and emitting throttled, backpressure-aware, trailing-flushed snapshots.
export async function pumpPresetStream(
    gen: AsyncGenerator<AdapterChatStreamDelta, void, void>,
    controller: StreamChunkController,
    options: PumpPresetStreamOptions,
): Promise<void> {
    const { intervalMs, formatReasoning, onError } = options
    let fullText = ''
    let reasoningText = ''
    // Prepend accumulated reasoning (mirrors the non-streaming path) so thinking
    // shows as reasoning and is never merged into the saved answer.
    const buildChunk = () =>
        (reasoningText.length > 0 ? formatReasoning(reasoningText) : '') + fullText

    const throttle = new StreamFlushThrottle(
        intervalMs,
        (chunk) => controller.enqueue({ "0": chunk }),
        buildChunk,
        () => controller.desiredSize,
    )

    // Trailing timer: flushes the tail during quiet or backpressured gaps
    // without waiting for the next delta. At most one is armed at a time; it is
    // re-armed when a flush is skipped by backpressure, and cleared on every
    // successful flush and on exit (so no timer leaks past the stream).
    let trailingTimer: ReturnType<typeof setTimeout> | null = null
    const clearTrailing = () => {
        if (trailingTimer !== null) {
            clearTimeout(trailingTimer)
            trailingTimer = null
        }
    }
    const armTrailing = () => {
        if (trailingTimer !== null) {
            return
        }
        trailingTimer = setTimeout(() => {
            trailingTimer = null
            if (throttle.onTrailing(Date.now())) {
                armTrailing()
            }
        }, intervalMs)
    }

    try {
        for await (const delta of gen) {
            if (delta.reasoningDelta) {
                reasoningText += delta.reasoningDelta
            }
            fullText += delta.textDelta
            if (throttle.onDelta(Date.now())) {
                armTrailing()
            } else {
                clearTrailing()
            }
        }
        clearTrailing()
        throttle.onEnd(Date.now())
        controller.close()
    } catch (err) {
        clearTrailing()
        onError?.(err)
        controller.error(err)
    }
}

import { forageStorage } from 'src/ts/globalApi.svelte'
import { language } from 'src/lang'

// Server-side model-preset requests — job-based fetchImpl (Stage 3 of
// .agent/notes/model-preset-server-side-requests.md).
//
// Instead of the browser fetching the provider directly (makeProxiedFetch),
// the client creates a server job (POST /api/model-jobs) and reads the
// provider's raw bytes back through the job's journal stream
// (GET /api/model-jobs/:id/stream). The server keeps consuming the upstream
// even if this client disconnects, so a dropped connection never kills the
// generation — Stage 4's discovery recovers it from the journal.
//
// The returned function is `typeof fetch`-compatible so it drops into the
// adapters' `options.fetchImpl` seam unchanged: the adapter sees a faithful
// provider Response (mirrored upstream status + content-type, byte-identical
// body). Works for streaming and non-streaming alike (non-streaming adapters
// just await response.json(), which drains the same wrapped stream).

/** Job creation was refused with 409 — this chat already has a running job.
 *  Must NOT fall back to the direct path (would double-generate). */
export class ModelJobBusyError extends Error {
    constructor() {
        // Localized: this surfaces to the user as the generation's error text.
        super(language.errors.modelJobBusy)
        this.name = 'ModelJobBusyError'
    }
}

/** Safety rule 1 (끊김 ≠ 완료): the journal stream ended but the server says
 *  the job is still running — the tail connection was lost, NOT the
 *  generation. The message must not be saved as complete; the job keeps
 *  running server-side and discovery (Stage 4) recovers it.
 *
 *  Worded as "still generating, it will resume" rather than as a failure: the
 *  user is looking at what appears to be an error while the generation is in
 *  fact fine, and a re-send would only hit the per-chat job guard (409). */
export class ModelJobConnectionLostError extends Error {
    constructor() {
        super(language.errors.modelJobConnectionLost)
        this.name = 'ModelJobConnectionLostError'
    }
}

export interface JobFetchOptions {
    /** Job key: the real chat.id for main generations (server enforces one
     *  running main job per chat on it). Aux side requests pass their unique
     *  per-request genId here instead — the guard never applies to them. */
    realChatId: string
    /** Per-request generationId (idempotency key for Stage 4 slot-in). */
    generationId: string
    adapterKind: string
    /** Model id, persisted with the job so a recovered generation can be
     *  logged with the model it actually used. */
    model?: string
    /** User-facing preset/model label stored for recovered message metadata. */
    modelLabel?: string
    inputTokens?: number
    outputTokens?: number
    maxContext?: number
    streaming: boolean
    /** 'main' = chat generation (recoverable at boot, per-chat guard).
     *  'aux' = pipeline side request (translate / memory / …) riding the job
     *  transport only for its reconnectable stream — relay-only server-side. */
    jobKind?: 'main' | 'aux'
    /** Upstream request timeout, forwarded to the server job. */
    timeoutMs?: number
    /** Base delay of the stream-reattach backoff (default 1000ms). Injectable
     *  so tests do not sleep for real. */
    reconnectBaseDelayMs?: number
    /** Used when job creation fails for infra reasons (network error / 404 /
     *  5xx — older or misbehaving server): the request transparently falls
     *  back to the direct proxied path. NOT used after the job exists. */
    fallbackFetch: typeof fetch
}

// Reattach policy. Attempts are per reconnect cycle (reset once a stream is
// successfully attached); no-progress cycles guard against a pathological
// middlebox that accepts the stream but closes it before new bytes arrive —
// without it that would loop forever against a still-running job.
const RECONNECT_MAX_ATTEMPTS = 5
const RECONNECT_MAX_NO_PROGRESS_CYCLES = 3

// Same auth mechanism the /proxy2 path uses (fetchViaProxy2). Shared with
// jobRecovery.ts (all /api/model-jobs endpoints expect it).
export async function authHeader(): Promise<Record<string, string>> {
    return { 'risu-auth': await forageStorage.createAuth() }
}

export function makeJobFetch(opts: JobFetchOptions): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input.toString()
        const signal = init?.signal ?? undefined

        // 1. Create the job. Infra failures fall back to the direct path;
        //    409 (chat already generating) must surface, never fall back.
        let created: Response
        try {
            created = await fetch('/api/model-jobs', {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...await authHeader() },
                body: JSON.stringify({
                    targetUrl: url,
                    method: init?.method ?? 'POST',
                    headers: (init?.headers as Record<string, string>) ?? {},
                    body: typeof init?.body === 'string' ? init.body : undefined,
                    chatId: opts.realChatId,
                    generationId: opts.generationId,
                    adapterKind: opts.adapterKind,
                    model: opts.model,
                    modelLabel: opts.modelLabel,
                    inputTokens: opts.inputTokens,
                    outputTokens: opts.outputTokens,
                    maxContext: opts.maxContext,
                    kind: opts.jobKind ?? 'main',
                    streaming: opts.streaming,
                    timeoutMs: opts.timeoutMs,
                }),
                signal,
            })
        } catch (err) {
            if (signal?.aborted) throw err
            console.warn('[ModelJob] job creation failed, falling back to direct request path', err)
            return opts.fallbackFetch(input, init)
        }
        let jobId: string
        if (created.status === 409) {
            // The chat already has a running job. If it is THIS generation's
            // own job (the previous attempt lost its stream before the
            // upstream answered — a gateway 504 in front of a slow-first-byte
            // model, or a killed tab — and the send pipeline retried), attach
            // to it instead of failing: the journal replays from byte 0, so
            // the retry resumes the generation in place. A job of another
            // generation is a genuine conflict and must surface (issue #87).
            let busy: { jobId?: string, generationId?: string } = {}
            try { busy = await created.json() } catch { /* body optional */ }
            if (!busy.jobId || busy.generationId !== opts.generationId) {
                throw new ModelJobBusyError()
            }
            console.warn('[ModelJob] chat busy with this generation\'s own job, reattaching', busy.jobId)
            jobId = busy.jobId
        } else if (!created.ok) {
            console.warn('[ModelJob] job creation rejected (', created.status, '), falling back to direct request path')
            return opts.fallbackFetch(input, init)
        } else {
            jobId = (await created.json()).jobId
        }

        // Abort propagation: aborting the request DELETEs the job (server
        // aborts the upstream) and cancels the local stream fetch (same
        // signal). Fire-and-forget — abort must never hang on cleanup.
        const abortJob = () => {
            void (async () => {
                await fetch(`/api/model-jobs/${jobId}`, { method: 'DELETE', headers: await authHeader() })
            })().catch(() => {})
        }
        signal?.addEventListener('abort', abortJob, { once: true })
        const detach = () => signal?.removeEventListener('abort', abortJob)

        // 2. Attach to the journal stream (replay from byte 0 + live tail).
        //
        // Retried with the same backoff policy as mid-stream reattach: the
        // dominant mobile pattern is "send, then background the tab" — the tab
        // freezes with this fetch in flight and it rejects the moment the tab
        // resumes, while the radio may take several more seconds to come back.
        // The job is already running server-side and the journal replays from
        // byte 0 on every attach, so attaching late loses nothing. Only fetch
        // REJECTIONS (network-level) and responses that did not come from our
        // server retry — a reverse proxy in front of the server answers with
        // its own 502/504 when the pre-header wait (a thinking model's first
        // byte) outlasts its idle timeout, and that is a transport failure,
        // not the server's answer (issue #87). Our own stream responses always
        // carry x-model-job-id, so a response without it is a middlebox; 404
        // stays definitive (the job is gone). On exhaustion this is a lost
        // connection, not a lost generation — surface the same
        // ModelJobConnectionLostError the mid-stream path uses (recovery picks
        // the job up at the next return), never the raw TypeError.
        const baseDelay = opts.reconnectBaseDelayMs ?? 1000
        const abortError = () => new DOMException('The operation was aborted.', 'AbortError')
        const sleepAbortable = (ms: number) => new Promise<void>((resolve, reject) => {
            const cleanup = () => {
                clearTimeout(timer)
                signal?.removeEventListener('abort', onAbort)
            }
            const onAbort = () => { cleanup(); reject(abortError()) }
            const timer = setTimeout(() => { cleanup(); resolve() }, ms)
            if (signal?.aborted) { onAbort(); return }
            signal?.addEventListener('abort', onAbort)
        })

        let streamRes: Response | null = null
        for (let attempt = 0; attempt < RECONNECT_MAX_ATTEMPTS; attempt++) {
            try {
                if (attempt > 0) {
                    await sleepAbortable(baseDelay * 2 ** (attempt - 1))
                }
                const res = await fetch(`/api/model-jobs/${jobId}/stream`, { headers: await authHeader(), signal })
                // Gateway-shaped statuses only (502/503/504, Cloudflare 52x,
                // 408): a headerless 4xx/500 can also be the server's own
                // auth/handler error and must stay definitive.
                if (!res.headers.has('x-model-job-id') && (res.status === 408 || res.status >= 502)) {
                    console.warn('[ModelJob] stream attach answered by an intermediary (', res.status, '), retrying')
                    continue
                }
                streamRes = res
                break
            } catch (err) {
                if (signal?.aborted) {
                    detach()
                    throw err
                }
            }
        }
        if (streamRes === null) {
            detach()
            throw new ModelJobConnectionLostError()
        }
        const upstreamStatus = streamRes.headers.get('x-model-job-upstream-status')
        if (!streamRes.ok || upstreamStatus === null || !streamRes.body) {
            // Upstream never connected (or the stream endpoint failed) —
            // behave like a fetch network failure so the adapters' existing
            // network-error handling applies unchanged.
            detach()
            throw new TypeError('model job upstream connection failed')
        }

        // 3. Wrap the body: an ended HTTP stream does NOT prove completion
        //    (safety rule 1). On end, confirm with the job record and only
        //    close cleanly when the server says 'done'.
        //
        //    While the job is still RUNNING, an ended/broken tail is a lost
        //    connection, not a lost generation — the journal replays from byte
        //    0 on every attach, so this reattaches with backoff and skips the
        //    bytes already delivered. The consumer (adapter parser, and every
        //    await up the send pipeline) never sees the gap: a network blip
        //    mid-send resumes in place instead of failing the send. Only when
        //    reattach attempts are exhausted does the stream error with
        //    ModelJobConnectionLostError (recovery then takes over at the next
        //    return/boot for main jobs).
        let reader = streamRes.body.getReader()
        let bytesDelivered = 0
        let skipRemaining = 0
        let progressSinceAttach = true // first attach counts as progress
        let noProgressCycles = 0

        // Re-attach to the journal stream. True = a fresh reader is installed
        // (replay from 0; skip what was already delivered). False = job gone
        // (404), attempts exhausted, or aborted — caller gives up.
        const tryReattach = async (): Promise<boolean> => {
            if (progressSinceAttach) {
                noProgressCycles = 0
            } else if (++noProgressCycles >= RECONNECT_MAX_NO_PROGRESS_CYCLES) {
                return false
            }
            for (let attempt = 0; attempt < RECONNECT_MAX_ATTEMPTS; attempt++) {
                try {
                    await sleepAbortable(baseDelay * 2 ** attempt)
                    const res = await fetch(`/api/model-jobs/${jobId}/stream`, { headers: await authHeader(), signal })
                    if (res.status === 404) return false // job rotated/deleted
                    if (!res.ok || !res.body) continue
                    reader = res.body.getReader()
                    skipRemaining = bytesDelivered
                    progressSinceAttach = false
                    return true
                } catch {
                    if (signal?.aborted) return false
                }
            }
            return false
        }

        const claim = () => {
            void (async () => {
                await fetch(`/api/model-jobs/${jobId}/claim`, { method: 'POST', headers: await authHeader() })
            })().catch(() => {})
        }

        const wrapped = new ReadableStream<Uint8Array>({
            async pull(controller) {
                while (true) {
                    let read: ReadableStreamReadResult<Uint8Array>
                    try {
                        read = await reader.read()
                    } catch (err) {
                        if (signal?.aborted) { detach(); throw err }
                        // Mid-stream network error — same treatment as a
                        // premature end while running: reattach.
                        if (await tryReattach()) continue
                        detach()
                        if (signal?.aborted) throw abortError()
                        throw new ModelJobConnectionLostError()
                    }
                    if (!read.done) {
                        let chunk = read.value
                        if (skipRemaining > 0) {
                            // Replayed prefix we already handed out.
                            if (chunk.length <= skipRemaining) {
                                skipRemaining -= chunk.length
                                continue
                            }
                            chunk = chunk.subarray(skipRemaining)
                            skipRemaining = 0
                        }
                        bytesDelivered += chunk.length
                        progressSinceAttach = true
                        controller.enqueue(chunk)
                        return
                    }
                    // Stream ended.
                    if (signal?.aborted) {
                        // Local abort raced the stream end — surface the abort.
                        detach()
                        throw abortError()
                    }
                    let job: { status?: string, error?: string } | null = null
                    try {
                        const res = await fetch(`/api/model-jobs/${jobId}`, { headers: await authHeader() })
                        if (res.ok) job = await res.json()
                    } catch {
                        // Status check unreachable — same as a lost tail; the
                        // reattach path below covers it.
                    }
                    if (job?.status === 'done') {
                        detach()
                        controller.close()
                        // Claim fire-and-forget: marks the job as collected so
                        // Stage 4's discovery skips it. The tiny crash window
                        // before the claim lands is covered by genId idempotency.
                        claim()
                        return
                    }
                    if (job?.status === 'failed' || job?.status === 'aborted') {
                        detach()
                        if (job.status === 'failed') {
                            // The user sees this failure live — claim it so the
                            // next boot's discovery doesn't insert a duplicate
                            // error into the chat. ('aborted' is excluded from
                            // the unclaimed list; nothing to do.)
                            claim()
                        }
                        controller.error(new Error(job.error ?? `model job ${job.status}`))
                        return
                    }
                    // Still 'running' (or status unknown): the tail was lost,
                    // not the generation — reattach and resume in place.
                    if (await tryReattach()) continue
                    detach()
                    if (signal?.aborted) throw abortError()
                    controller.error(new ModelJobConnectionLostError())
                    return
                }
            },
            cancel(reason) {
                detach()
                return reader.cancel(reason)
            },
        })
        return new Response(wrapped, {
            status: Number(upstreamStatus),
            headers: { 'content-type': streamRes.headers.get('content-type') ?? 'application/octet-stream' },
        })
    }) as typeof fetch
}

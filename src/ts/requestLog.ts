// Client-side collection for the server request log (save/request-logs.db).
//
// Replaces the old in-memory `fetchLog` array in globalApi.svelte.ts, which
// held 20 entries, died on refresh, could not see the server-side job path at
// all, and recorded streamed responses as the literal string "Streamed Fetch".
//
// The collector wraps a `typeof fetch` — the same seam the model-preset path
// already uses for its transport (makeProxiedFetch / makeJobFetch), so direct
// requests and server-side job requests are recorded identically without
// either transport knowing about logging. The response body is tee'd and
// assembled as it streams, so a streamed response is logged with its real
// text and its real timings.
//
// One entry per outgoing fetch. Entries are held until the scope closes so
// the adapter's authoritative token usage (known only after the stream ends)
// lands on the same row, then all of them are POSTed in one batch.

import { getDatabase } from './storage/database.svelte'
import { getClientId } from './log'

export type RequestLogCategory = 'llm' | 'tts' | 'image' | 'translate' | 'embedding' | 'other'
export type RequestLogSource =
    | 'main' | 'translate' | 'memory' | 'emotion' | 'sub'
    | 'preview' | 'test' | 'tts' | 'image' | 'plugin' | 'other'
export type RequestLogRoute = 'direct' | 'proxy' | 'job'

export interface RequestLogUsage {
    inputTokens?: number
    outputTokens?: number
    cachedTokens?: number
    reasoningTokens?: number
}

export interface RequestLogScopeInit {
    category: RequestLogCategory
    source: RequestLogSource
    /** Message/generation key the per-message log viewer looks up. */
    chatId?: string
    generationId?: string
    model?: string
    provider?: string
    route?: RequestLogRoute
    streaming?: boolean
}

interface PendingEntry {
    timestamp: number
    category: RequestLogCategory
    source: RequestLogSource
    chatId?: string
    generationId?: string
    model?: string
    provider?: string
    url: string
    method?: string
    status?: number
    success: boolean
    aborted?: boolean
    route?: RequestLogRoute
    streaming?: boolean
    durationMs?: number
    firstTokenMs?: number
    inputTokens?: number
    outputTokens?: number
    cachedTokens?: number
    reasoningTokens?: number
    requestHeaders?: string
    requestBody?: string
    responseBody?: string
    responseType?: string
    errorMessage?: string
    clientId?: string
}

// Client-side ceiling on an assembled response. The server applies its own
// 2MB cap; this one just stops a runaway stream from growing the tab's heap.
const MAX_ASSEMBLED_CHARS = 4 * 1024 * 1024

// Only text-shaped responses are worth assembling. TTS returns audio, ComfyUI's
// /view returns a PNG, and decoding those into a JS string would store megabytes
// of noise and evict real request logs from the byte budget. When the response
// is not text-like the body is left alone entirely — no tee, so nothing is held
// in memory either.
function isTextLikeResponse(contentType: string | null | undefined): boolean {
    if (!contentType) return true // unknown: assume text, the size caps still apply
    const type = contentType.toLowerCase()
    if (type.startsWith('text/')) return true
    if (type.includes('event-stream')) return true
    if (type.startsWith('application/')) {
        return type.includes('json') || type.includes('xml') || type.includes('ndjson')
    }
    return false
}

export function requestLogEnabled(): boolean {
    try {
        return getDatabase()?.requestLogEnabled !== false
    } catch {
        return false
    }
}

// Inlined media turns a 300KB prompt into a multi-MB one and is worthless to
// read back, so it is replaced before the body ever leaves the browser.
function stripInlineMedia(body: string): string {
    return body.replace(
        /"data:([a-z]+)\/([a-z0-9.+-]+);base64,[A-Za-z0-9+/=]+"/gi,
        (match, type: string, subtype: string) =>
            `"[${type}/${subtype}: ${Math.round(match.length * 0.75 / 1024)} KB omitted]"`,
    )
}

function bodyToString(body: unknown): string | undefined {
    if (body == null) return undefined
    if (typeof body === 'string') return stripInlineMedia(body)
    if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
        try {
            return stripInlineMedia(new TextDecoder().decode(body as Uint8Array))
        } catch {
            return `[binary ${(body as Uint8Array).byteLength ?? 0} bytes]`
        }
    }
    try {
        return stripInlineMedia(JSON.stringify(body))
    } catch {
        return String(body)
    }
}

function headersToString(headers: unknown): string | undefined {
    if (!headers) return undefined
    try {
        if (headers instanceof Headers) {
            return JSON.stringify(Object.fromEntries(headers.entries()))
        }
        return JSON.stringify(headers)
    } catch {
        return undefined
    }
}

async function send(entries: PendingEntry[]): Promise<void> {
    if (entries.length === 0) return
    try {
        const { forageStorage } = await import('./globalApi.svelte')
        const auth = await forageStorage.createAuth()
        await fetch('/api/request-logs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'risu-auth': auth },
            body: JSON.stringify(entries),
        })
    } catch {
        // Same policy as the system log: a log that cannot be delivered is
        // dropped rather than retried — logging must never affect the app.
    }
}

/** Fire-and-forget single entry, for call sites that are not scope-shaped. */
export function recordRequestLog(entry: Omit<PendingEntry, 'clientId'>): void {
    if (!requestLogEnabled()) return
    void send([{ ...entry, clientId: getClientId() }])
}

// ─── Reading back ────────────────────────────────────────────────────────────
export interface RequestLogEntry {
    id: number
    timestamp: number
    category: RequestLogCategory
    source: RequestLogSource
    chatId?: string
    generationId?: string
    model?: string
    provider?: string
    url: string
    method?: string
    status?: number
    success: boolean
    aborted: boolean
    route?: RequestLogRoute
    streaming: boolean
    durationMs?: number
    firstTokenMs?: number
    inputTokens?: number
    outputTokens?: number
    cachedTokens?: number
    reasoningTokens?: number
    /** Only present on a single-entry fetch or when `bodies` was requested. */
    requestHeaders?: string
    requestBody?: string
    responseBody?: string
    responseType?: string
    errorMessage?: string
    truncated: boolean
    sizeBytes?: number
    clientId?: string
}

export interface UsageBucket {
    requests: number
    failed: number
    inputTokens: number
    outputTokens: number
    cachedTokens: number
    reasoningTokens: number
    avgDurationMs: number | null
}

export interface UsageReport {
    total: UsageBucket
    daily: (UsageBucket & { day: string })[]
    byModel: (UsageBucket & { model: string | null, provider: string | null })[]
    bySource: (UsageBucket & { source: string })[]
    dimensions: { models: string[], categories: string[], sources: string[] }
}

export interface RequestLogQuery {
    categories?: RequestLogCategory[]
    sources?: RequestLogSource[]
    chatId?: string
    successOnly?: boolean
    failedOnly?: boolean
    since?: number
    until?: number
    beforeId?: number
    limit?: number
    bodies?: boolean
}

async function authHeaders(): Promise<Record<string, string>> {
    const { forageStorage } = await import('./globalApi.svelte')
    return { 'risu-auth': await forageStorage.createAuth() }
}

function toQueryString(query: RequestLogQuery): string {
    const params = new URLSearchParams()
    if (query.categories?.length) params.set('categories', query.categories.join(','))
    if (query.sources?.length) params.set('sources', query.sources.join(','))
    if (query.chatId) params.set('chat_id', query.chatId)
    if (query.successOnly) params.set('success', '1')
    if (query.failedOnly) params.set('failed', '1')
    if (query.since !== undefined) params.set('since', String(query.since))
    if (query.until !== undefined) params.set('until', String(query.until))
    if (query.beforeId !== undefined) params.set('before_id', String(query.beforeId))
    if (query.limit !== undefined) params.set('limit', String(query.limit))
    if (query.bodies) params.set('bodies', '1')
    return params.toString()
}

export async function fetchRequestLogs(query: RequestLogQuery = {}): Promise<RequestLogEntry[]> {
    return (await fetchRequestLogPage(query)).content
}

export async function fetchRequestLogPage(
    query: RequestLogQuery = {},
): Promise<{ content: RequestLogEntry[], total: number }> {
    try {
        const res = await fetch(`/api/request-logs?${toQueryString(query)}`, { headers: await authHeaders() })
        if (!res.ok) return { content: [], total: 0 }
        const json = await res.json()
        return { content: json.content ?? [], total: json.total ?? 0 }
    } catch {
        return { content: [], total: 0 }
    }
}

/** Full entry including bodies — used when a list row is expanded. */
export async function fetchRequestLogEntry(id: number): Promise<RequestLogEntry | null> {
    try {
        const res = await fetch(`/api/request-logs/${id}`, { headers: await authHeaders() })
        if (!res.ok) return null
        return (await res.json()).content ?? null
    } catch {
        return null
    }
}

export interface UsageQuery {
    categories?: RequestLogCategory[]
    sources?: RequestLogSource[]
    models?: string[]
    since?: number
    until?: number
    successOnly?: boolean
}

export async function fetchUsage(query: UsageQuery = {}): Promise<UsageReport | null> {
    const params = new URLSearchParams()
    if (query.categories?.length) params.set('categories', query.categories.join(','))
    if (query.sources?.length) params.set('sources', query.sources.join(','))
    if (query.models?.length) params.set('models', query.models.join(','))
    if (query.since !== undefined) params.set('since', String(query.since))
    if (query.until !== undefined) params.set('until', String(query.until))
    if (query.successOnly) params.set('success', '1')
    try {
        const res = await fetch(`/api/request-logs/usage?${params.toString()}`, { headers: await authHeaders() })
        if (!res.ok) return null
        return await res.json()
    } catch {
        return null
    }
}

export interface RequestLogStorageStats {
    requestCount: number
    requestBytes: number
    usageCount: number
    maxTotalBytes: number
}

export async function fetchRequestLogStats(): Promise<RequestLogStorageStats | null> {
    try {
        const res = await fetch('/api/request-logs/stats', { headers: await authHeaders() })
        if (!res.ok) return null
        return await res.json()
    } catch {
        return null
    }
}

/** Clears stored request bodies. Usage statistics are kept unless `withUsage`. */
export async function clearRequestLogs(withUsage = false): Promise<boolean> {
    try {
        const res = await fetch(`/api/request-logs${withUsage ? '?usage=1' : ''}`, {
            method: 'DELETE',
            headers: await authHeaders(),
        })
        return res.ok
    } catch {
        return false
    }
}

export interface RequestLogScope {
    /** Wrap a transport so every fetch it performs is recorded. */
    wrap(base: typeof fetch): typeof fetch
    /** Authoritative token counts, known only after the adapter finishes. */
    setUsage(usage: RequestLogUsage | undefined): void
    /** The resolved model string, if it was not known when the scope opened. */
    setModel(model: string | undefined): void
    /** Overrides the recorded request body — used when the bytes actually put
     *  on the wire differ from what the caller handed in (body interceptors). */
    setRequestBody(body: string): void
    setRoute(route: RequestLogRoute): void
    /** Await in-flight body assembly, then POST every entry as one batch. */
    close(): Promise<void>
}

const NOOP_SCOPE: RequestLogScope = {
    wrap: (base) => base,
    setUsage: () => {},
    setModel: () => {},
    setRequestBody: () => {},
    setRoute: () => {},
    close: async () => {},
}

export function createRequestLogScope(init: RequestLogScopeInit): RequestLogScope {
    if (!requestLogEnabled()) return NOOP_SCOPE

    const entries: PendingEntry[] = []
    const settling: Promise<void>[] = []
    let closed = false

    const wrap = (base: typeof fetch): typeof fetch => {
        return (async (input: RequestInfo | URL, reqInit?: RequestInit): Promise<Response> => {
            const url = typeof input === 'string' ? input : input.toString()
            const started = Date.now()
            const entry: PendingEntry = {
                timestamp: started,
                category: init.category,
                source: init.source,
                chatId: init.chatId,
                generationId: init.generationId,
                model: init.model,
                provider: init.provider,
                url,
                method: reqInit?.method ?? 'POST',
                success: false,
                route: init.route,
                streaming: init.streaming,
                requestHeaders: headersToString(reqInit?.headers),
                requestBody: bodyToString(reqInit?.body),
                clientId: getClientId(),
            }
            entries.push(entry)

            let response: Response
            try {
                response = await base(input, reqInit)
            } catch (err) {
                entry.durationMs = Date.now() - started
                entry.success = false
                entry.aborted = (err as Error)?.name === 'AbortError'
                entry.errorMessage = (err as Error)?.message ?? String(err)
                throw err
            }

            // window.userScriptFetch is user-supplied and may return a
            // duck-typed object rather than a real Response. Logging must never
            // break the request, so anything unrecognizable passes straight
            // through unlogged.
            if (!(response instanceof Response)) {
                entry.durationMs = Date.now() - started
                entry.success = true
                return response
            }

            entry.status = response.status
            entry.success = response.ok
            entry.responseType = response.headers.get('content-type') ?? undefined

            if (!response.body) {
                entry.durationMs = Date.now() - started
                return response
            }

            // Audio, images and other binaries are recorded as metadata only.
            // Returning the original response also avoids the tee, so nothing
            // accumulates in memory while a large download runs.
            if (!isTextLikeResponse(entry.responseType)) {
                entry.durationMs = Date.now() - started
                entry.responseBody = `[${entry.responseType ?? 'binary'} response, not recorded]`
                return response
            }

            // Tee so the caller gets an untouched stream. Our branch must be
            // drained continuously — an unread branch applies backpressure and
            // would stall the caller's branch.
            const [forCaller, forLog] = response.body.tee()
            settling.push(assemble(forLog, entry, started, reqInit?.signal ?? undefined))
            return new Response(forCaller, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
            })
        }) as typeof fetch
    }

    // `signal` is the caller's abort signal. tee() only cancels the source when
    // BOTH branches cancel, so without watching it a user pressing stop would
    // leave this branch pulling the provider connection to completion — and the
    // entry would be filed as a success, since the HTTP response itself was 200.
    async function assemble(
        stream: ReadableStream<Uint8Array>,
        entry: PendingEntry,
        started: number,
        signal?: AbortSignal,
    ) {
        const reader = stream.getReader()
        const decoder = new TextDecoder()
        let text = ''
        let overflowed = false
        let onAbort: (() => void) | undefined
        try {
            if (signal) {
                if (signal.aborted) reader.cancel().catch(() => {})
                else {
                    onAbort = () => { reader.cancel().catch(() => {}) }
                    signal.addEventListener('abort', onAbort, { once: true })
                }
            }
            while (true) {
                const { done, value } = await reader.read()
                if (done) break
                if (entry.firstTokenMs === undefined) entry.firstTokenMs = Date.now() - started
                if (!overflowed) {
                    text += decoder.decode(value, { stream: true })
                    if (text.length > MAX_ASSEMBLED_CHARS) {
                        text = text.slice(0, MAX_ASSEMBLED_CHARS)
                        overflowed = true
                    }
                }
            }
            if (!overflowed) text += decoder.decode()
        } catch (err) {
            entry.errorMessage ??= (err as Error)?.message ?? String(err)
        } finally {
            if (onAbort) signal?.removeEventListener('abort', onAbort)
            reader.cancel().catch(() => {})
            // A generation the user cancelled mid-stream is not a success, even
            // though its HTTP response was 200 and partial text arrived.
            if (signal?.aborted) {
                entry.aborted = true
                entry.success = false
            }
            // Image providers return base64 payloads inside JSON, so the same
            // stripping the request body gets applies here — otherwise a single
            // generated image would occupy megabytes of the byte budget.
            const stripped = stripInlineMedia(text)
            entry.responseBody = overflowed ? stripped + '\n...[truncated by client]' : stripped
            entry.durationMs = Date.now() - started
        }
    }

    return {
        wrap,
        setUsage(usage) {
            if (!usage) return
            const last = entries[entries.length - 1]
            if (!last) return
            last.inputTokens = usage.inputTokens
            last.outputTokens = usage.outputTokens
            last.cachedTokens = usage.cachedTokens
            last.reasoningTokens = usage.reasoningTokens
        },
        setModel(model) {
            if (!model) return
            for (const e of entries) e.model ??= model
        },
        setRequestBody(body) {
            const last = entries[entries.length - 1]
            if (last) last.requestBody = stripInlineMedia(body)
        },
        setRoute(route) {
            for (const e of entries) e.route = route
        },
        async close() {
            if (closed) return
            closed = true
            // Wait for body assembly with NO timeout. close() is called
            // fire-and-forget the moment headers arrive on the classic path
            // (fetchNative's finally), so any deadline here would fire while a
            // normal generation is still streaming and post an empty response —
            // the exact defect this system exists to fix. assemble() always
            // settles: its read loop ends on done, on error, or on abort, and
            // its finally records whatever was collected.
            if (settling.length > 0) {
                await Promise.allSettled(settling)
            }
            await send(entries)
        },
    }
}

import { parseAnthropicMessage, type AdapterChatResponse, type AdapterPreparedRequest, type AdapterReasoningPart } from 'src/ts/preset/adapter'
import type { ProviderJobResult, ProviderJobStatus, ProviderRequestJob } from './providerJob'

export const DEFAULT_ANTHROPIC_BATCH_POLL_MS = 3_000
export const DEFAULT_ANTHROPIC_BATCH_TIMEOUT_MS = 24 * 60 * 60 * 1000 + 10 * 60 * 1000

interface AnthropicBatchJobOptions {
    pollMs?: number
    timeoutMs?: number
    sleep?: (ms: number) => Promise<void>
    now?: () => number
    logFetch?: (entry: AnthropicBatchFetchLogEntry) => void
    chatId?: string
}

export interface AnthropicBatchSubmitOptions extends AnthropicBatchJobOptions {
    prepared: AdapterPreparedRequest
    fetchImpl: typeof fetch
    signal?: AbortSignal
    customId: string
}

export type AnthropicBatchSubmitResult =
    | { ok: true; job: AnthropicBatchJob }
    | { ok: false; error: string }

export type AnthropicBatchMessageResult =
    | { type: 'success'; response: AdapterChatResponse }
    | { type: 'fail'; result: string }
    | { type: 'canceled'; result?: string }

export interface AnthropicBatchFetchLogEntry {
    body: unknown
    headers?: Record<string, string>
    response: unknown
    success: boolean
    url: string
    resType?: string
    chatId?: string
    status?: number
}

function defaultSleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function formatReasoning(reasoning?: AdapterReasoningPart[]): string {
    if (!reasoning || reasoning.length === 0) return ''
    let body = ''
    for (const part of reasoning) {
        if (part.redactedData !== undefined) body += '\n{{redacted_thinking}}\n'
        else if (part.text) body += part.text
    }
    if (body.trim().length === 0) return ''
    return `<Thoughts>\n${body}\n</Thoughts>\n\n`
}

function formatAnthropicResponse(response: AdapterChatResponse): string {
    return formatReasoning(response.reasoning) + response.text
}

export async function safeJson(response: Response): Promise<unknown> {
    try {
        return await response.json()
    } catch {
        return undefined
    }
}

export async function safeResponseText(response: Response): Promise<string> {
    try {
        return await response.text()
    } catch (e) {
        return e instanceof Error ? e.message : String(e)
    }
}

function requestUrl(input: RequestInfo | URL): string {
    return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
}

function requestBodyText(body: BodyInit | null | undefined): string {
    if (body === undefined || body === null) return ''
    if (typeof body === 'string') return body
    if (body instanceof URLSearchParams) return body.toString()
    if (body instanceof Uint8Array) return new TextDecoder().decode(body)
    if (body instanceof ArrayBuffer) return new TextDecoder().decode(body)
    return '[unlogged request body]'
}

function requestHeaders(headers: HeadersInit | undefined): Record<string, string> {
    if (!headers) return {}
    if (headers instanceof Headers) return Object.fromEntries(headers.entries())
    if (Array.isArray(headers)) return Object.fromEntries(headers)
    return headers as Record<string, string>
}

async function logAnthropicBatchFetch(
    logFetch: ((entry: AnthropicBatchFetchLogEntry) => void) | undefined,
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    response: Response,
    chatId: string | undefined,
): Promise<void> {
    if (!logFetch) return
    try {
        logFetch({
            body: requestBodyText(init?.body),
            headers: requestHeaders(init?.headers),
            response: await response.clone().text(),
            success: response.ok,
            url: requestUrl(input),
            resType: 'text',
            chatId,
            status: response.status,
        })
    } catch (e) {
        console.error('[ModelPreset] Anthropic batch logging failed', e)
    }
}

async function fetchAnthropicBatch(
    fetchImpl: typeof fetch,
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    logFetch: ((entry: AnthropicBatchFetchLogEntry) => void) | undefined,
    chatId?: string,
): Promise<Response> {
    try {
        const response = await fetchImpl(input, init)
        await logAnthropicBatchFetch(logFetch, input, init, response, chatId)
        return response
    } catch (e) {
        if (logFetch) {
            try {
                logFetch({
                    body: requestBodyText(init?.body),
                    headers: requestHeaders(init?.headers),
                    response: e instanceof Error ? e.message : String(e),
                    success: false,
                    url: requestUrl(input),
                    resType: 'text',
                    chatId,
                })
            } catch (logError) {
                console.error('[ModelPreset] Anthropic batch logging failed', logError)
            }
        }
        throw e
    }
}

export function anthropicBatchBaseUrl(messagesUrl: string): string {
    const clean = messagesUrl.replace(/\/?$/, '')
    return clean.endsWith('/messages') ? `${clean}/batches` : `${clean}/messages/batches`
}

export function toAnthropicBatchParams(body: AdapterPreparedRequest['body']): AdapterPreparedRequest['body'] {
    const params = { ...body }
    if (params.service_tier === 'batch') {
        delete params.service_tier
    }
    return params
}

export function previewAnthropicBatchRequest(prepared: AdapterPreparedRequest, customId = 'preview') {
    const params = toAnthropicBatchParams(prepared.body)
    delete params.stream
    return {
        url: anthropicBatchBaseUrl(prepared.url),
        body: { requests: [{ custom_id: customId, params }] },
        headers: prepared.headers,
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseBatchStatus(payload: unknown): string | undefined {
    if (!isRecord(payload)) return undefined
    return typeof payload.processing_status === 'string' ? payload.processing_status : undefined
}

export class AnthropicBatchJob implements ProviderRequestJob {
    readonly provider = 'anthropic'
    readonly kind = 'message-batch'
    readonly createdAt: number
    private status: ProviderJobStatus = { state: 'submitted', message: 'Batch submitted' }
    private cancelRequested = false
    private readonly pollMs: number
    private readonly timeoutMs: number
    private readonly sleep: (ms: number) => Promise<void>
    private readonly now: () => number
    private readonly logFetch?: (entry: AnthropicBatchFetchLogEntry) => void
    private readonly chatId?: string

    constructor(
        readonly id: string,
        private readonly prepared: AdapterPreparedRequest,
        private readonly batchId: string,
        private readonly fetchImpl: typeof fetch,
        options: AnthropicBatchJobOptions = {},
    ) {
        this.pollMs = options.pollMs ?? DEFAULT_ANTHROPIC_BATCH_POLL_MS
        this.timeoutMs = options.timeoutMs ?? DEFAULT_ANTHROPIC_BATCH_TIMEOUT_MS
        this.sleep = options.sleep ?? defaultSleep
        this.now = options.now ?? Date.now
        this.logFetch = options.logFetch
        this.chatId = options.chatId
        this.createdAt = this.now()
    }

    getStatus(): ProviderJobStatus {
        return this.status
    }

    private setStatus(status: ProviderJobStatus, onStatus?: (status: ProviderJobStatus) => void): void {
        this.status = status
        onStatus?.(status)
    }

    async cancel(): Promise<void> {
        if (this.cancelRequested) return
        this.cancelRequested = true
        this.setStatus({ state: 'cancel-requested', message: 'Cancel requested; waiting for final batch state' })
        try {
            await fetchAnthropicBatch(this.fetchImpl, this.cancelUrl(), {
                method: 'POST',
                headers: this.prepared.headers,
                body: '{}',
            }, undefined, this.chatId)
        } catch (e) {
            console.error('[ModelPreset] Anthropic batch cancel failed', e)
        }
    }

    async wait(options: { signal?: AbortSignal | null; onStatus?: (status: ProviderJobStatus) => void } = {}): Promise<ProviderJobResult> {
        const response = await this.waitForResponse(options)
        if (response.type !== 'success') return response
        return { type: 'success', result: formatAnthropicResponse(response.response) }
    }

    async waitForResponse(options: { signal?: AbortSignal | null; onStatus?: (status: ProviderJobStatus) => void } = {}): Promise<AnthropicBatchMessageResult> {
        const startedAt = this.now()
        const abortHandler = () => {
            this.setStatus({ state: 'cancel-requested', message: 'Cancel requested; waiting for final batch state' }, options.onStatus)
            void this.cancel()
        }
        options.signal?.addEventListener('abort', abortHandler, { once: true })
        try {
            while (true) {
                if (this.now() - startedAt > this.timeoutMs) {
                    this.setStatus({ state: 'failed', message: 'Anthropic batch request timed out after 24 hours' }, options.onStatus)
                    return { type: 'fail', result: 'Anthropic batch request timed out after 24 hours' }
                }

                if (options.signal?.aborted && !this.cancelRequested) {
                    await this.cancel()
                }

                await this.sleep(this.pollMs)

                let statusRes: Response
                try {
                    statusRes = await fetchAnthropicBatch(this.fetchImpl, this.statusUrl(), {
                        method: 'GET',
                        headers: this.prepared.headers,
                        signal: this.cancelRequested ? undefined : options.signal ?? undefined,
                    }, undefined, this.chatId)
                } catch (e) {
                    if (options.signal?.aborted || this.cancelRequested) continue
                    return { type: 'fail', result: e instanceof Error ? e.message : String(e) }
                }

                if (!statusRes.ok) {
                    const message = await safeResponseText(statusRes)
                    this.setStatus({ state: 'failed', message }, options.onStatus)
                    return { type: 'fail', result: message }
                }

                const processingStatus = parseBatchStatus(await safeJson(statusRes))
                if (!processingStatus) {
                    const message = 'Invalid Anthropic batch status response'
                    this.setStatus({ state: 'failed', message }, options.onStatus)
                    return { type: 'fail', result: message }
                }
                if (processingStatus !== 'ended') {
                    this.setStatus({
                        state: this.cancelRequested ? 'cancel-requested' : 'running',
                        message: `Anthropic batch ${processingStatus}`,
                    }, options.onStatus)
                    continue
                }

                try {
                    return await this.readResponseResult(options.onStatus)
                } catch (e) {
                    const message = e instanceof Error ? e.message : String(e)
                    this.setStatus({ state: 'failed', message }, options.onStatus)
                    return { type: 'fail', result: message }
                }
            }
        } finally {
            options.signal?.removeEventListener('abort', abortHandler)
        }
    }

    private async readResponseResult(onStatus?: (status: ProviderJobStatus) => void): Promise<AnthropicBatchMessageResult> {
        const batchRes = await fetchAnthropicBatch(this.fetchImpl, this.resultsUrl(), {
            method: 'GET',
            headers: this.prepared.headers,
        }, this.logFetch, this.chatId)
        if (!batchRes.ok) {
            const message = await safeResponseText(batchRes)
            this.setStatus({ state: 'failed', message }, onStatus)
            return { type: 'fail', result: message }
        }

        const lines = (await batchRes.text()).split('\n').filter((line) => line.trim().length > 0)
        for (const line of lines) {
            let batchData: unknown
            try {
                batchData = JSON.parse(line)
            } catch {
                continue
            }
            if (!isRecord(batchData) || !isRecord(batchData.result)) continue
            const result = batchData.result
            switch (result?.type) {
                case 'succeeded': {
                    const response = parseAnthropicMessage(result.message)
                    this.setStatus({ state: 'succeeded', message: 'Anthropic batch completed' }, onStatus)
                    return { type: 'success', response }
                }
                case 'errored': {
                    const error = isRecord(result.error) ? result.error : undefined
                    const innerError = error && isRecord(error.error) ? error.error : undefined
                    const message = typeof innerError?.message === 'string'
                        ? `${String(innerError.type)}: ${innerError.message}`
                        : JSON.stringify(error) ?? 'Anthropic batch errored'
                    this.setStatus({ state: 'failed', message }, onStatus)
                    return { type: 'fail', result: message }
                }
                case 'canceled':
                    this.setStatus({ state: 'canceled', message: 'Anthropic batch canceled' }, onStatus)
                    return { type: 'canceled', result: 'Anthropic batch canceled' }
                case 'expired':
                    this.setStatus({ state: 'expired', message: 'Anthropic batch expired' }, onStatus)
                    return { type: 'fail', result: 'Anthropic batch request expired' }
            }
        }
        const message = 'No Anthropic batch result found'
        this.setStatus({ state: 'failed', message }, onStatus)
        return { type: 'fail', result: message }
    }

    private batchBaseUrl(): string {
        return anthropicBatchBaseUrl(this.prepared.url)
    }

    private statusUrl(): string {
        return `${this.batchBaseUrl()}/${encodeURIComponent(this.batchId)}`
    }

    private resultsUrl(): string {
        return `${this.statusUrl()}/results`
    }

    private cancelUrl(): string {
        return `${this.statusUrl()}/cancel`
    }
}

export async function submitAnthropicBatchJob(options: AnthropicBatchSubmitOptions): Promise<AnthropicBatchSubmitResult> {
    const batchUrl = anthropicBatchBaseUrl(options.prepared.url)
    let response: Response
    try {
        response = await fetchAnthropicBatch(options.fetchImpl, batchUrl, {
            method: 'POST',
            headers: options.prepared.headers,
            body: JSON.stringify({
                requests: [{ custom_id: options.customId, params: toAnthropicBatchParams(options.prepared.body) }],
            }),
            signal: options.signal,
        }, options.logFetch, options.chatId)
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    if (!response.ok) {
        return { ok: false, error: await safeResponseText(response) }
    }
    const payload = await safeJson(response)
    if (!isRecord(payload) || typeof payload.id !== 'string' || payload.id.length === 0) {
        return { ok: false, error: 'No batch id returned from Anthropic batch request' }
    }
    return {
        ok: true,
        job: new AnthropicBatchJob(options.customId, options.prepared, payload.id, options.fetchImpl, options),
    }
}

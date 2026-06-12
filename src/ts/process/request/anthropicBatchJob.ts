import { parseAnthropicMessage, type AdapterPreparedRequest, type AdapterReasoningPart } from 'src/ts/preset/adapter'
import type { ProviderJobResult, ProviderJobStatus, ProviderRequestJob } from './providerJob'

export const DEFAULT_ANTHROPIC_BATCH_POLL_MS = 3_000
export const DEFAULT_ANTHROPIC_BATCH_TIMEOUT_MS = 24 * 60 * 60 * 1000 + 10 * 60 * 1000

interface AnthropicBatchJobOptions {
    pollMs?: number
    timeoutMs?: number
    sleep?: (ms: number) => Promise<void>
    now?: () => number
}

export interface AnthropicBatchSubmitOptions extends AnthropicBatchJobOptions {
    prepared: AdapterPreparedRequest
    fetchImpl: typeof fetch
    signal?: AbortSignal
    customId: string
}

export type AnthropicBatchSubmitResult =
    | { ok: true; job: ProviderRequestJob }
    | { ok: false; error: string }

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

export async function safeJson(response: Response): Promise<any> {
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

export function anthropicBatchBaseUrl(messagesUrl: string): string {
    const clean = messagesUrl.replace(/\/?$/, '')
    return clean.endsWith('/messages') ? `${clean}/batches` : `${clean}/messages/batches`
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
            await this.fetchImpl(this.cancelUrl(), {
                method: 'POST',
                headers: this.prepared.headers,
                body: '{}',
            })
        } catch (e) {
            console.error('[ModelPreset] Anthropic batch cancel failed', e)
        }
    }

    async wait(options: { signal?: AbortSignal | null; onStatus?: (status: ProviderJobStatus) => void } = {}): Promise<ProviderJobResult> {
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
                    statusRes = await this.fetchImpl(this.statusUrl(), {
                        method: 'GET',
                        headers: this.prepared.headers,
                        signal: this.cancelRequested ? undefined : options.signal ?? undefined,
                    })
                } catch (e) {
                    if (options.signal?.aborted || this.cancelRequested) continue
                    return { type: 'fail', result: e instanceof Error ? e.message : String(e) }
                }

                if (!statusRes.ok) {
                    const message = await safeResponseText(statusRes)
                    this.setStatus({ state: 'failed', message }, options.onStatus)
                    return { type: 'fail', result: message }
                }

                const statusData = await safeJson(statusRes)
                const processingStatus = typeof statusData?.processing_status === 'string'
                    ? statusData.processing_status
                    : undefined
                if (processingStatus !== 'ended') {
                    this.setStatus({
                        state: this.cancelRequested ? 'cancel-requested' : 'running',
                        message: processingStatus ? `Anthropic batch ${processingStatus}` : 'Anthropic batch running',
                    }, options.onStatus)
                    continue
                }

                try {
                    return await this.readResults(options.onStatus)
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

    private async readResults(onStatus?: (status: ProviderJobStatus) => void): Promise<ProviderJobResult> {
        const batchRes = await this.fetchImpl(this.resultsUrl(), {
            method: 'GET',
            headers: this.prepared.headers,
        })
        if (!batchRes.ok) {
            const message = await safeResponseText(batchRes)
            this.setStatus({ state: 'failed', message }, onStatus)
            return { type: 'fail', result: message }
        }

        const lines = (await batchRes.text()).split('\n').filter((line) => line.trim().length > 0)
        for (const line of lines) {
            let batchData: any
            try {
                batchData = JSON.parse(line)
            } catch {
                continue
            }
            const result = batchData?.result
            switch (result?.type) {
                case 'succeeded': {
                    const response = parseAnthropicMessage(result.message)
                    const text = formatReasoning(response.reasoning) + response.text
                    this.setStatus({ state: 'succeeded', message: 'Anthropic batch completed' }, onStatus)
                    return { type: 'success', result: text }
                }
                case 'errored': {
                    const error = result.error
                    const message = error?.error?.message
                        ? `${error.error.type}: ${error.error.message}`
                        : JSON.stringify(error)
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
        response = await options.fetchImpl(batchUrl, {
            method: 'POST',
            headers: options.prepared.headers,
            body: JSON.stringify({
                requests: [{ custom_id: options.customId, params: options.prepared.body }],
            }),
            signal: options.signal,
        })
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    if (!response.ok) {
        return { ok: false, error: await safeResponseText(response) }
    }
    const payload = await safeJson(response)
    if (typeof payload?.id !== 'string' || payload.id.length === 0) {
        return { ok: false, error: 'No batch id returned from Anthropic batch request' }
    }
    return {
        ok: true,
        job: new AnthropicBatchJob(options.customId, options.prepared, payload.id, options.fetchImpl, options),
    }
}

import { language } from '../../../lang'
import { addBadge, endStatus, markPhase } from 'src/ts/status/requestStatus'
import type { ProviderJobStatus, ProviderRequestJob } from './providerJob'
import { safeStatus } from './safeStatus'

export const ANTHROPIC_BATCH_STATUS_ABANDON_GRACE_MS = 5 * 60 * 1000

function requestStatusText(key: keyof typeof language.requestStatus, fallback: string): string {
    const text = language.requestStatus[key]
    return typeof text === 'string' ? text : fallback
}

function anthropicBatchBadgeText(status: ProviderJobStatus): string {
    switch (status.state) {
        case 'submitted':
        case 'queued':
            return requestStatusText('batchSubmitted', 'Anthropic batch submitted')
        case 'running':
            return status.message ?? requestStatusText('batchRunning', 'Anthropic batch running')
        case 'cancel-requested':
            return requestStatusText('batchCancelRequested', 'Anthropic batch cancel requested')
        case 'succeeded':
            return requestStatusText('batchSucceeded', 'Anthropic batch completed')
        case 'failed':
        case 'expired':
            return status.message ?? requestStatusText('batchFailed', 'Anthropic batch failed')
        case 'canceled':
            return status.message ?? requestStatusText('batchCanceled', 'Anthropic batch canceled')
    }
}

function publishAnthropicBatchStatus(genId: string, status: ProviderJobStatus): void {
    const now = Date.now()
    const text = anthropicBatchBadgeText(status)
    switch (status.state) {
        case 'submitted':
        case 'queued':
        case 'running':
            markPhase(genId, 'waiting', now)
            addBadge(genId, { key: 'batch', text, tone: 'info' })
            return
        case 'cancel-requested':
            markPhase(genId, 'waiting', now)
            addBadge(genId, { key: 'batch', text, tone: 'warn' })
            return
        case 'succeeded':
            addBadge(genId, { key: 'batch', text, tone: 'success' })
            return
        case 'failed':
        case 'expired':
            addBadge(genId, { key: 'batch', text, tone: 'warn' })
            endStatus(genId, 'failed', { now, error: text })
            return
        case 'canceled':
            addBadge(genId, { key: 'batch', text, tone: 'warn' })
            endStatus(genId, 'aborted', { now })
            return
    }
}

export function wrapAnthropicBatchStatusJob(job: ProviderRequestJob, genId: string): ProviderRequestJob {
    return {
        id: job.id,
        provider: job.provider,
        kind: job.kind,
        createdAt: job.createdAt,
        getStatus: () => job.getStatus(),
        cancel: async () => {
            safeStatus(() => publishAnthropicBatchStatus(genId, { state: 'cancel-requested' }))
            await job.cancel()
            safeStatus(() => publishAnthropicBatchStatus(genId, job.getStatus()))
        },
        wait: async (options) => {
            const shouldDeferAbortedTerminalStatus = (status: ProviderJobStatus) => (
                options?.signal?.aborted === true
                && (status.state === 'failed' || status.state === 'expired' || status.state === 'canceled')
            )
            const forwardStatus = (status: ProviderJobStatus) => {
                if (!shouldDeferAbortedTerminalStatus(status)) {
                    safeStatus(() => publishAnthropicBatchStatus(genId, status))
                }
                options?.onStatus?.(status)
            }
            const currentStatus = job.getStatus()
            if (!shouldDeferAbortedTerminalStatus(currentStatus)) {
                safeStatus(() => publishAnthropicBatchStatus(genId, currentStatus))
            }
            try {
                const result = await job.wait({ ...options, onStatus: forwardStatus })
                if (result.type === 'success') {
                    safeStatus(() => {
                        publishAnthropicBatchStatus(genId, { state: 'succeeded' })
                        endStatus(genId, 'done', { now: Date.now() })
                    })
                }
                else if (options?.signal?.aborted) {
                    safeStatus(() => {
                        addBadge(genId, { key: 'batch', text: requestStatusText('batchCanceled', 'Anthropic batch canceled'), tone: 'warn' })
                        endStatus(genId, 'aborted', { now: Date.now() })
                    })
                    return { type: 'canceled', result: 'Aborted' }
                }
                else if (result.type === 'canceled') {
                    safeStatus(() => publishAnthropicBatchStatus(genId, { state: 'canceled', message: result.result }))
                }
                else {
                    safeStatus(() => publishAnthropicBatchStatus(genId, { state: 'failed', message: result.result }))
                }
                return result
            } catch (err) {
                const outcome = options?.signal?.aborted ? 'aborted' : 'failed'
                safeStatus(() => endStatus(genId, outcome, {
                    now: Date.now(),
                    error: outcome === 'failed' ? (err instanceof Error ? err.message : String(err)) : undefined,
                }))
                if (outcome === 'aborted') {
                    return { type: 'canceled', result: 'Aborted' }
                }
                throw err
            }
        },
    }
}

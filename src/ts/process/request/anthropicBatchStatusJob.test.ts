import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { get } from 'svelte/store'
import { requestStatuses, startStatus, stopStatusTimer } from 'src/ts/status/requestStatus'
import { wrapAnthropicBatchStatusJob } from './anthropicBatchStatusJob'
import type { ProviderJobResult, ProviderJobStatus, ProviderJobWaitOptions, ProviderRequestJob } from './providerJob'

function makeJob(
    initialStatus: ProviderJobStatus,
    waitImpl: (options?: ProviderJobWaitOptions) => Promise<ProviderJobResult>,
    onCancel: () => void = () => {},
): ProviderRequestJob {
    let status = initialStatus
    return {
        id: 'batch_123',
        provider: 'anthropic',
        kind: 'message-batch',
        createdAt: 0,
        getStatus: () => status,
        cancel: async () => { onCancel(); status = { state: 'cancel-requested' } },
        wait: async (options) => waitImpl({
            ...options,
            onStatus: (next) => {
                status = next
                options?.onStatus?.(next)
            },
        }),
    }
}

describe('wrapAnthropicBatchStatusJob', () => {
    beforeEach(() => {
        requestStatuses.set(new Map())
    })

    afterEach(() => {
        requestStatuses.set(new Map())
        stopStatusTimer()
    })

    test('preserves a late successful batch result after abort', async () => {
        const controller = new AbortController()
        controller.abort()
        startStatus('g1', { kind: 'main', label: 'preset', phase: 'waiting', now: 0 })
        const forwarded: string[] = []
        const job = makeJob({ state: 'cancel-requested' }, async (options) => {
            options?.onStatus?.({ state: 'succeeded' })
            return { type: 'success', result: 'Late success' }
        })

        const result = await wrapAnthropicBatchStatusJob(job, 'g1').wait({
            signal: controller.signal,
            onStatus: (status) => forwarded.push(status.state),
        })

        const entry = get(requestStatuses).get('g1')!
        expect(result).toEqual({ type: 'success', result: 'Late success' })
        expect(forwarded).toEqual(['succeeded'])
        expect(entry.phase).toBe('done')
        expect(entry.badges).toContainEqual({ key: 'batch', text: 'Anthropic batch completed', tone: 'success' })
    })

    test('defers aborted terminal non-success statuses until abort reclassification', async () => {
        const controller = new AbortController()
        controller.abort()
        startStatus('g1', { kind: 'main', label: 'preset', phase: 'waiting', now: 0 })
        const forwarded: string[] = []
        const job = makeJob({ state: 'failed', message: 'Provider failed after abort' }, async (options) => {
            options?.onStatus?.({ state: 'expired', message: 'Provider expired after abort' })
            return { type: 'fail', result: 'Provider expired after abort' }
        })

        const result = await wrapAnthropicBatchStatusJob(job, 'g1').wait({
            signal: controller.signal,
            onStatus: (status) => forwarded.push(status.state),
        })

        const entry = get(requestStatuses).get('g1')!
        expect(result).toEqual({ type: 'canceled', result: 'Aborted' })
        expect(forwarded).toEqual(['expired'])
        expect(entry.phase).toBe('aborted')
        expect(entry.error).toBeUndefined()
        expect(entry.badges).toContainEqual({ key: 'batch', text: 'Anthropic batch canceled', tone: 'warn' })
    })

    test('requests provider cancellation when wait starts with an aborted signal', async () => {
        const controller = new AbortController()
        controller.abort()
        startStatus('g1', { kind: 'main', label: 'preset', phase: 'waiting', now: 0 })
        let cancelCalls = 0
        const job = makeJob(
            { state: 'submitted' },
            async () => ({ type: 'canceled', result: 'Aborted' }),
            () => { cancelCalls++ },
        )

        const result = await wrapAnthropicBatchStatusJob(job, 'g1').wait({ signal: controller.signal })

        expect(result).toEqual({ type: 'canceled', result: 'Aborted' })
        expect(cancelCalls).toBe(1)
        expect(get(requestStatuses).get('g1')!.badges).toContainEqual({
            key: 'batch',
            text: 'Anthropic batch canceled',
            tone: 'warn',
        })
    })
})

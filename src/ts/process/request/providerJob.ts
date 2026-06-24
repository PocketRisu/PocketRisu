export type ProviderJobState =
    | 'submitted'
    | 'queued'
    | 'running'
    | 'cancel-requested'
    | 'succeeded'
    | 'failed'
    | 'canceled'
    | 'expired'

export interface ProviderJobStatus {
    state: ProviderJobState
    message?: string
}

export type ProviderJobResult =
    | { type: 'success'; result: string }
    | { type: 'fail'; result: string }
    | { type: 'canceled'; result?: string }

export interface ProviderJobWaitOptions {
    signal?: AbortSignal | null
    onStatus?: (status: ProviderJobStatus) => void
    deferSuccessStatus?: boolean
}

export interface ProviderRequestJob {
    id: string
    provider: string
    kind: string
    createdAt: number
    getStatus(): ProviderJobStatus
    cancel(): Promise<void>
    wait(options?: ProviderJobWaitOptions): Promise<ProviderJobResult>
    finishMappedResult?(result: ProviderJobResult): void
}

export function decorateJob(
    base: ProviderRequestJob,
    overrides: Partial<Pick<ProviderRequestJob, 'getStatus' | 'cancel' | 'wait' | 'finishMappedResult'>>,
): ProviderRequestJob {
    return {
        id: base.id,
        provider: base.provider,
        kind: base.kind,
        createdAt: base.createdAt,
        getStatus: overrides.getStatus ?? (() => base.getStatus()),
        cancel: overrides.cancel ?? (() => base.cancel()),
        wait: overrides.wait ?? ((options) => base.wait(options)),
        finishMappedResult: overrides.finishMappedResult ?? base.finishMappedResult,
    }
}

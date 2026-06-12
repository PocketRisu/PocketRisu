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
}

export interface ProviderRequestJob {
    id: string
    provider: string
    kind: string
    createdAt: number
    getStatus(): ProviderJobStatus
    cancel(): Promise<void>
    wait(options?: ProviderJobWaitOptions): Promise<ProviderJobResult>
}

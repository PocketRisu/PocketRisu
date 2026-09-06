// Size of the database.bin payload the client sends on a full write (chats
// are stubbed out, so this is "everything except chat bodies"). Reverse
// proxies and tunnels cap request bodies — Cloudflare Quick Tunnel at 100 MB —
// and a full-write fallback above that cap fails permanently, so the UI warns
// once the payload approaches it. See .agent/notes/cloudflare-upload-limit.md.
//
// The value costs nothing to obtain: bootstrap already holds the encoded
// blob served by /api/read, and every save encodes the full payload before
// attempting a patch.
import { writable } from 'svelte/store'

export const TRANSFER_SIZE_RECOMMENDED_BYTES = 80 * 1024 * 1024
// Clear below a lower bound so a payload hovering around the limit does not
// flicker the warning on and off between saves.
export const TRANSFER_SIZE_CLEAR_BYTES = 70 * 1024 * 1024

/**
 * 'boot' — length of the blob /api/read served (server legacy encoder; runs
 *   ~1.5× larger than the client's block encoder, observed 12.4 MB vs 8.4 MB).
 *   A provisional estimate until the first save measures the real payload.
 * 'save' — length of the payload a full write would send. Authoritative.
 */
export type TransferSizeSource = 'boot' | 'save'

export interface DbTransferSizeState {
    bytes: number | null
    overLimit: boolean
    source: TransferSizeSource | null
}

export const dbTransferSizeStore = writable<DbTransferSizeState>({ bytes: null, overLimit: false, source: null })

/** Session-only dismissal of the main-menu banner; the dashboard row stays. */
export const transferSizeWarningDismissed = writable(false)

export function nextTransferSizeState(
    prev: DbTransferSizeState,
    bytes: number,
    source: TransferSizeSource,
): DbTransferSizeState {
    if (!Number.isFinite(bytes) || bytes < 0) return prev
    // A boot estimate never takes the store from 'save' back to 'boot'.
    if (source === 'boot' && prev.source === 'save') return prev
    // Hysteresis only between measurements of the same kind: the first real
    // save measurement replaces the boot estimate outright, otherwise an
    // overestimated boot value could pin the warning on.
    const carry = prev.source === source ? prev.overLimit : false
    const overLimit = bytes >= TRANSFER_SIZE_RECOMMENDED_BYTES
        ? true
        : bytes < TRANSFER_SIZE_CLEAR_BYTES ? false : carry
    return { bytes, overLimit, source }
}

export function recordDbTransferSize(bytes: number, source: TransferSizeSource) {
    dbTransferSizeStore.update(prev => nextTransferSizeState(prev, bytes, source))
}

import { requestStatuses, isTerminalPhase, clearStatus } from './requestStatus'

// How long a terminal entry lingers in the store before being reclaimed.
export const REQUEST_STATUS_RETENTION_MS = 4000

// Always-on entry-lifecycle janitor, independent of whatever (if anything) is
// currently rendering request-status entries. `RequestStatusToaster.svelte`
// used to own this as a side effect of showing/dismissing its 'modal' toast —
// but the toast is now only ONE possible renderer (see 'detailed' inline
// mode), and a renderer that isn't a toast has no natural reason to ever call
// `clearStatus`. Without a mode-independent reaper, terminal entries would
// leak in the store for the rest of the session whenever 'modal' isn't the
// active display mode. Call once (e.g. on app mount); returns an unsubscribe
// function.
export function startRequestStatusReaper(retentionMs: number = REQUEST_STATUS_RETENTION_MS): () => void {
    const timers = new Map<string, ReturnType<typeof setTimeout>>()

    const unsub = requestStatuses.subscribe((map) => {
        for (const [id, entry] of map) {
            if (isTerminalPhase(entry.phase)) {
                if (timers.has(id)) continue
                const t = setTimeout(() => {
                    timers.delete(id)
                    clearStatus(id)
                }, retentionMs)
                timers.set(id, t)
            } else if (timers.has(id)) {
                // Revived (e.g. a fallback/retry reusing the same id): the entry
                // went terminal, got a reap scheduled, then restarted. Cancel the
                // pending reap so the now-live entry isn't cleared mid-flight.
                clearTimeout(timers.get(id))
                timers.delete(id)
            }
        }
        // Entries removed from the store some other way (e.g. an explicit early
        // clearStatus elsewhere): drop any orphaned timer.
        for (const id of [...timers.keys()]) {
            if (!map.has(id)) {
                clearTimeout(timers.get(id))
                timers.delete(id)
            }
        }
    })

    return () => {
        unsub()
        for (const t of timers.values()) clearTimeout(t)
        timers.clear()
    }
}

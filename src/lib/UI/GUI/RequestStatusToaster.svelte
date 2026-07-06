<script lang="ts">
    // Driver that bridges the request-status store to sonner, for 'modal'
    // display mode only. Mounted once (next to <Toaster/> in App.svelte),
    // renders no DOM of its own. Entry-lifecycle cleanup (the terminal-entry
    // reaper) runs unconditionally here regardless of display mode — see
    // requestStatusReaper.ts — so switching away from 'modal' (or never using
    // it) can't leak entries in the store for the rest of the session.
    //
    // For each request entry it issues ONE persistent sonner custom toast
    // keyed by `req:<generationId>` and dismisses it after a short retention
    // once the request reaches a terminal phase. The toast body
    // (RequestStatusToast) subscribes to the store itself, so live updates
    // need no re-issue here — this driver only manages create / dismiss
    // lifecycle.
    //
    // The `req:` id namespace keeps these separate from confirm/error toasts
    // (notify*), so they never collide even on the same Toaster. See
    // .agent/notes/request-status-toast-infra.md §4-3.
    import { onDestroy } from 'svelte'
    import { toast } from 'svelte-sonner'
    import { requestStatuses, isTerminalPhase } from 'src/ts/status/requestStatus'
    import { startRequestStatusReaper, REQUEST_STATUS_RETENTION_MS } from 'src/ts/status/requestStatusReaper'
    import { DBState } from 'src/ts/stores.svelte'
    import RequestStatusToast from './RequestStatusToast.svelte'

    // genIds we've issued a VISIBLE toast for, and pending dismissal timers.
    // Store cleanup (clearStatus) is the reaper's job, not this driver's.
    const shown = new Set<string>()
    const dismissTimers = new Map<string, ReturnType<typeof setTimeout>>()

    function toastId(id: string): string {
        return `req:${id}`
    }

    function dismissToast(id: string): void {
        shown.delete(id)
        toast.dismiss(toastId(id))
    }

    function scheduleDismiss(id: string): void {
        if (dismissTimers.has(id)) return
        const t = setTimeout(() => {
            dismissTimers.delete(id)
            dismissToast(id)
        }, REQUEST_STATUS_RETENTION_MS)
        dismissTimers.set(id, t)
    }

    // Swipe-to-dismiss policy: sonner toasts are dismissible by default, so the
    // user can swipe/click a status toast away. We do NOT re-show it — `shown`
    // keeps the id, so subsequent store updates for the same request won't
    // re-issue the toast (it stays closed until the request ends and its store
    // entry is cleared). "Close = closed for good."
    const unsub = requestStatuses.subscribe((map) => {
        if (DBState.db.requestStatusDisplayMode !== 'modal') return
        for (const [id, entry] of map) {
            if (!shown.has(id)) {
                shown.add(id)
                toast.custom(RequestStatusToast, {
                    id: toastId(id),
                    duration: Number.POSITIVE_INFINITY,
                    componentProps: { id },
                })
            }
            if (isTerminalPhase(entry.phase)) {
                scheduleDismiss(id)
            } else if (dismissTimers.has(id)) {
                // Revived (e.g. fallback/retry reuses the same generationId): the
                // entry went terminal, scheduled a dismiss, then restarted. Cancel
                // the pending dismiss so the now-live toast isn't cleared mid-flight.
                clearTimeout(dismissTimers.get(id))
                dismissTimers.delete(id)
            }
        }
        // Entries removed from the store while still shown (e.g. reaped early):
        // dismiss their toasts.
        for (const id of [...shown]) {
            if (!map.has(id) && !dismissTimers.has(id)) {
                dismissToast(id)
            }
        }
    })

    // Mode switched away from 'modal' mid-flight: dismiss every currently
    // visible toast immediately (the store entries themselves are untouched —
    // the reaper reclaims them on its own schedule).
    $effect(() => {
        if (DBState.db.requestStatusDisplayMode !== 'modal') {
            for (const id of [...shown]) dismissToast(id)
            for (const t of dismissTimers.values()) clearTimeout(t)
            dismissTimers.clear()
        }
    })

    const stopReaper = startRequestStatusReaper()

    onDestroy(() => {
        unsub()
        stopReaper()
        for (const t of dismissTimers.values()) clearTimeout(t)
        dismissTimers.clear()
    })
</script>

<script lang="ts">
    // Driver that bridges the request-status store to sonner. Mounted once
    // (next to <Toaster/> in App.svelte), renders no DOM of its own. For each
    // request entry it issues ONE persistent sonner custom toast keyed by
    // `req:<generationId>` and dismisses it after a short retention once the
    // request reaches a terminal phase. The toast body (RequestStatusToast)
    // subscribes to the store itself, so live updates need no re-issue here —
    // this driver only manages create / dismiss lifecycle.
    //
    // The `req:` id namespace keeps these separate from confirm/error toasts
    // (notify*), so they never collide even on the same Toaster. See
    // .agent/notes/request-status-toast-infra.md §4-3.
    import { onDestroy } from 'svelte'
    import { toast } from 'svelte-sonner'
    import { requestStatuses, isTerminalPhase, clearStatus } from 'src/ts/status/requestStatus'
    import RequestStatusToast from './RequestStatusToast.svelte'

    // How long a finished toast lingers so the user can read the final
    // tokens / cache savings before it disappears.
    const RETENTION_MS = 4000

    // genIds we've issued a toast for, and pending dismissal timers.
    const shown = new Set<string>()
    const dismissTimers = new Map<string, ReturnType<typeof setTimeout>>()

    function toastId(id: string): string {
        return `req:${id}`
    }

    function scheduleDismiss(id: string): void {
        if (dismissTimers.has(id)) return
        const t = setTimeout(() => {
            dismissTimers.delete(id)
            shown.delete(id)
            toast.dismiss(toastId(id))
            // Drop the store entry too so the map doesn't grow unbounded.
            clearStatus(id)
        }, RETENTION_MS)
        dismissTimers.set(id, t)
    }

    // Swipe-to-dismiss policy: sonner toasts are dismissible by default, so the
    // user can swipe/click a status toast away. We do NOT re-show it — `shown`
    // keeps the id, so subsequent store updates for the same request won't
    // re-issue the toast (it stays closed until the request ends and its store
    // entry is cleared). "Close = closed for good."
    const unsub = requestStatuses.subscribe((map) => {
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
        // Entries removed from the store while still shown (e.g. cleared early):
        // dismiss their toasts.
        for (const id of [...shown]) {
            if (!map.has(id) && !dismissTimers.has(id)) {
                shown.delete(id)
                toast.dismiss(toastId(id))
            }
        }
    })

    onDestroy(() => {
        unsub()
        for (const t of dismissTimers.values()) clearTimeout(t)
        dismissTimers.clear()
    })
</script>

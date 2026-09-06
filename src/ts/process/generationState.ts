import { derived, get, writable, type Readable } from "svelte/store"

// Per-chat generation state, keyed by the REAL chat id (chat.id) — not the
// per-request generationId that flows through request args as `chatId` (see
// .agent/notes/generation-state-keying.md §1-bis). Keyed-Map pattern modeled
// on status/requestStatus.ts.
//
// Compatibility layer: the historical global stores `doingChat` /
// `chatProcessStage` live here (re-exported from process/index.svelte for
// existing consumers) and are fed from the map, so with a single active
// generation behavior is unchanged. All lifecycle writes go through the
// helpers below so the stores and the map never diverge.
//
// Non-persistent, memory only: never touches db/localStorage/.bin.

export interface GenState {
    generationId: string
    // 'live' = a send running in this client (feeds the global doingChat
    // compat store). 'background' = a server-side job reattached by
    // jobRecovery: it holds the per-chat send guard but must NOT flip the
    // global doingChat (that would lock every send UI and character switching
    // for up to the job-poll deadline).
    kind: 'live' | 'background'
    abortController?: AbortController
}

export const generationStates = writable<Map<string, GenState>>(new Map())

// Compat stores. Kept writable: Suggestion.svelte pulses doingChat true→false
// to retrigger its subscriber (only while nothing is generating, so the pulse
// cannot diverge from the map).
export const doingChat = writable(false)
export const chatProcessStage = writable(0)

export const isAnyGenerating: Readable<boolean> = derived(generationStates, (m) => m.size > 0)

// Abort controllers registered by the UI before sendChat creates the map entry
// (the screen creates the controller, then sendChat registers the generation).
// Entries are copied — not moved — into the generation and survive the
// end/restart churn of auto-continue/resend (those endGeneration calls pass
// keepPendingAbort) so the Stop button can still reach the controller
// mid-send. A terminal endGeneration deletes the entry so a later unrelated
// generation cannot adopt a stale controller. Overwritten by the next
// registerAbort for the chat.
const pendingAborts = new Map<string, AbortController>()

// Legacy chats can lack chat.id; those share one fallback key so the guard and
// cleanup still pair up (same single-generation behavior as before).
export function chatGenKey(chatId: string | undefined): string {
    return chatId ?? 'nochat'
}

// Global compat store = "any LIVE generation running". Background entries hold
// only the per-chat guard. Exported so the Suggestion.svelte pulse can
// re-converge the store with the map after its true→false toggle.
export function syncDoingChat(): void {
    let anyLive = false
    for (const entry of get(generationStates).values()) {
        if (entry.kind === 'live') {
            anyLive = true
            break
        }
    }
    doingChat.set(anyLive)
}

// Counts BOTH kinds: a chat with a background job must still block a new send.
export function isChatGenerating(chatKey: string): boolean {
    return get(generationStates).has(chatKey)
}

export function startGeneration(chatKey: string, generationId: string, kind: 'live' | 'background' = 'live'): void {
    const abortController = pendingAborts.get(chatKey)
    generationStates.update((m) => {
        const next = new Map(m)
        next.set(chatKey, { generationId, kind, abortController })
        return next
    })
    syncDoingChat()
}

// Thin wrapper over the global compat store (the per-key stage field had no
// consumers; last writer wins, same as the previous global-only behavior).
export function setGenerationStage(_chatKey: string, stage: number): void {
    chatProcessStage.set(stage)
}

// keepPendingAbort: the auto-continue/resend restart paths end and immediately
// restart the generation under the same key mid-send; they keep the pending
// controller so the restarted entry re-adopts it. Terminal ends (the default)
// drop it so it cannot be adopted by a later unrelated generation.
export function endGeneration(chatKey: string, opts?: { keepPendingAbort?: boolean }): void {
    if (!opts?.keepPendingAbort) {
        pendingAborts.delete(chatKey)
    }
    rebaseListeners.delete(chatKey)
    generationStates.update((m) => {
        if (!m.has(chatKey)) return m
        const next = new Map(m)
        next.delete(chatKey)
        return next
    })
    syncDoingChat()
}

// Blanket reset — replaces the old external `doingChat.set(false)` cleanup
// writes (multisend / hotkey preview / DevTool / plugin apiV3) so the map and
// the compat store clear together. Does not abort: neither did the old writes.
// Background entries (reattached server-side jobs) survive: these cleanup
// writes concern the live send pipeline and must not orphan a running job's
// guard (its poll loop still needs to release it).
export function endAllGenerations(): void {
    generationStates.update((m) => {
        const next = new Map<string, GenState>()
        for (const [key, entry] of m) {
            if (entry.kind === 'background') next.set(key, entry)
        }
        return next
    })
    const survivors = get(generationStates)
    for (const key of [...pendingAborts.keys()]) {
        if (!survivors.has(key)) pendingAborts.delete(key)
    }
    for (const key of [...rebaseListeners.keys()]) {
        if (!survivors.has(key)) rebaseListeners.delete(key)
    }
    syncDoingChat()
}

// A save conflict can replace the whole database (rebase on another device's
// revision) while a send is streaming into it. The send pipeline addresses
// its target by numeric character/chat index captured at start, so it must
// re-resolve those against the new database or it would write into whatever
// now sits at the old index. Listeners live as long as the generation entry.
const rebaseListeners = new Map<string, () => void>()

export function onDatabaseRebased(chatKey: string, listener: () => void): void {
    rebaseListeners.set(chatKey, listener)
}

export function notifyDatabaseRebased(): void {
    for (const listener of [...rebaseListeners.values()]) {
        try { listener() } catch (e) { console.error('[Save] rebase listener failed', e) }
    }
}

// Called by the UI right before sendChat, while the map entry does not exist
// yet; startGeneration adopts the pending controller into the entry.
export function registerAbort(chatKey: string, controller: AbortController): void {
    const entry = get(generationStates).get(chatKey)
    if (entry) {
        generationStates.update((m) => {
            const cur = m.get(chatKey)
            if (!cur) return m
            const next = new Map(m)
            next.set(chatKey, { ...cur, abortController: controller })
            return next
        })
    } else {
        pendingAborts.set(chatKey, controller)
    }
}

// Abort THIS chat's generation (registered or still pending). Returns whether
// a not-yet-aborted controller was actually aborted — false when nothing was
// wired (or everything reachable had already been aborted).
export function abortGeneration(chatKey: string): boolean {
    const entry = get(generationStates).get(chatKey)
    const pending = pendingAborts.get(chatKey)
    let aborted = false
    for (const controller of new Set([entry?.abortController, pending])) {
        if (controller && !controller.signal.aborted) {
            controller.abort()
            aborted = true
        }
    }
    return aborted
}

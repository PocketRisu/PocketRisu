import { forageStorage } from "../globalApi.svelte"

// Per-chat composer drafts. The unsent text in the message input is stored
// outside the chat content so that unmounting the chat view (e.g. opening
// Settings) does not lose it. Each draft is its own forage key (a single row in
// the server SQLite `kv` table), keyed by character + chat id, so it:
//   - syncs across devices (shared server backend),
//   - is isolated from the chat body (a draft write never re-uploads the chat),
//   - never touches the Chat schema (no data-compat concerns).
//
// Writes are debounced (each is a network round-trip) and flushed immediately on
// blur / chat switch / unmount / page hide. All writes run through one serialized
// queue so a delayed save can never land after a later remove (which would
// resurrect a sent draft). Drafts of deleted chats are NOT cleaned per-delete;
// sweepOrphanDrafts() clears them in a single boot pass instead.

export interface ChatDraft {
    /** Raw message input. */
    m: string
    /** Translate-input buffer (input-translation feature). */
    t: string
}

const PREFIX = 'drafts/'
const DEBOUNCE_MS = 800

export function chatDraftKey(chaId: string, chatId: string): string {
    return `${PREFIX}${chaId}/${chatId}`
}

// In-memory index of keys known to have a draft. Loaded once per session via a
// single prefix list, so opening a chat without a draft costs no server round
// trip. Stale only w.r.t. drafts another device creates mid-session (picked up
// on next load) — acceptable for drafts.
let draftKeys: Set<string> | null = null
let indexLoading: Promise<void> | null = null

async function ensureIndex(): Promise<void> {
    if (draftKeys) return
    if (!indexLoading) {
        indexLoading = forageStorage.keys(PREFIX)
            .then((keys) => { draftKeys = new Set(keys) })
            .catch(() => { draftKeys = new Set() })
    }
    await indexLoading
}

// Keys for which a server write was attempted. The server may hold the value
// even if the response was lost (so the key never made it into `draftKeys`); a
// later remove must still fire for these, or a sent draft could reappear next
// session. Keys never written stay out, so no needless remove round trips.
const maybeSaved = new Set<string>()

// Serialized write queue. Every persist runs after the previous one settles, so
// operations on the same key keep their submission order. Errors are swallowed:
// a failed draft write must never disrupt chatting.
let writeChain: Promise<void> = Promise.resolve()
function enqueue(op: () => Promise<void>): void {
    writeChain = writeChain.then(() => op().catch(() => {}))
}

async function persistSave(key: string, draft: ChatDraft): Promise<void> {
    if (!draft.m && !draft.t) { await persistRemove(key); return }
    await ensureIndex()
    const bytes = new TextEncoder().encode(JSON.stringify(draft))
    maybeSaved.add(key) // mark before the write: the server may keep it even if the response is lost
    await forageStorage.setItem(key, bytes)
    draftKeys!.add(key)
}

async function persistRemove(key: string): Promise<void> {
    await ensureIndex()
    // Skip only when nothing was ever written for this key; `maybeSaved` covers
    // a save whose response was lost (server has it, but it is not in the index).
    if (!draftKeys!.has(key) && !maybeSaved.has(key)) return
    await forageStorage.removeItem(key)
    draftKeys!.delete(key)
    maybeSaved.delete(key)
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

function cancelPending() {
    if (saveTimer) {
        clearTimeout(saveTimer)
        saveTimer = null
    }
}

/** Load a chat's draft, or null if none. No round trip when the index says none. */
export async function loadChatDraft(chaId: string, chatId: string): Promise<ChatDraft | null> {
    if (!chaId || !chatId) return null
    const key = chatDraftKey(chaId, chatId)
    await ensureIndex()
    // Let any in-flight writes land first so a quick leave→return reads the value
    // we just saved, not a stale one.
    await writeChain
    if (!draftKeys!.has(key)) return null
    try {
        const buf = await forageStorage.getItem(key)
        if (!buf || buf.length === 0) return null
        const obj = JSON.parse(new TextDecoder().decode(buf))
        return { m: obj.m ?? '', t: obj.t ?? '' }
    } catch {
        return null
    }
}

/** Debounced save while the user is typing. */
export function scheduleSaveChatDraft(chaId: string, chatId: string, draft: ChatDraft): void {
    if (!chaId || !chatId) return
    const key = chatDraftKey(chaId, chatId)
    cancelPending()
    saveTimer = setTimeout(() => {
        saveTimer = null
        enqueue(() => persistSave(key, draft))
    }, DEBOUNCE_MS)
}

/** Immediate save (blur / chat switch / unmount / page hide). Cancels any pending debounce. */
export function flushChatDraft(chaId: string, chatId: string, draft: ChatDraft): void {
    if (!chaId || !chatId) return
    cancelPending()
    enqueue(() => persistSave(chatDraftKey(chaId, chatId), draft))
}

/** Drop a chat's draft after its message is sent. The chat lives on, so the key stays writable. */
export function removeChatDraft(chaId: string, chatId: string): void {
    if (!chaId || !chatId) return
    cancelPending()
    enqueue(() => persistRemove(chatDraftKey(chaId, chatId)))
}

/**
 * Remove drafts whose chat no longer exists. One boot pass handles every way a
 * chat can disappear (chat/character deletion, trash purge, plugin/script
 * removal), so individual delete paths need no draft-cleanup wiring. `validKeys`
 * is the set of chatDraftKey() values for all currently existing chats.
 */
export async function sweepOrphanDrafts(validKeys: Set<string>): Promise<void> {
    try {
        const keys = await forageStorage.keys(PREFIX)
        for (const key of keys) {
            if (validKeys.has(key)) continue
            enqueue(async () => {
                await forageStorage.removeItem(key)
                draftKeys?.delete(key)
            })
        }
    } catch {
        // best-effort: orphan drafts are harmless until the next sweep
    }
}

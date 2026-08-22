import { forageStorage } from "../globalApi.svelte"
import { type Chat, type ChatStub, type ChatOrStub, isChatStub } from "./database.svelte"
import { tick } from "svelte"

// ── Stub ↔ Placeholder conversion ───────────────────────────────────────────

/**
 * Convert a ChatStub to a placeholder Chat with safe empty defaults.
 * The placeholder passes all Chat type checks so existing code works unchanged.
 * `_placeholder: true` marks it for hydration and dirty-tracking suppression.
 *
 * Key presence is preserved (mirroring chatToStub) so an explicit null from
 * the server — meaning "user cleared this field" — survives the placeholder
 * round-trip. Otherwise the next chatToStub call would emit a "remove" patch
 * op and the server merge would fall back to a stale fullChat value.
 */
export function stubToPlaceholder(stub: ChatStub): Chat {
    const placeholder: Chat = {
        message: [],
        note: '',
        name: stub.name,
        localLore: [],
        id: stub.id,
        fmIndex: -1,
        _placeholder: true,
    }
    if ('lastDate' in stub) placeholder.lastDate = stub.lastDate
    if ('folderId' in stub) placeholder.folderId = stub.folderId
    if ('modules' in stub) placeholder.modules = stub.modules
    return placeholder
}

/**
 * Convert a Chat (or placeholder) to a ChatStub for database.bin encoding.
 *
 * Key presence is preserved even when the value is null/undefined so the
 * stub round-trip distinguishes "user cleared" from "field absent". The
 * server merge layer relies on `in` semantics — see mergeChatStubWithFullChat.
 */
export function chatToStub(chat: Chat | ChatStub): ChatStub {
    if (isChatStub(chat)) return chat
    const stub: ChatStub = {
        id: chat.id ?? '',
        name: chat.name ?? '',
        _stub: true,
    }
    if ('lastDate' in chat) stub.lastDate = chat.lastDate
    if ('folderId' in chat) stub.folderId = chat.folderId
    if ('modules' in chat) stub.modules = chat.modules
    return stub
}

/**
 * Replace all ChatStubs in a character's chats array with placeholder Chats.
 * Call this once after decoding database.bin so runtime code only sees Chat objects.
 *
 * Self-healing for hybrid corruption: if a chat carries the `_stub: true`
 * flag *and* a real message array (legacy v1.4.x disk corruption), strip the
 * flag and keep the Chat as-is. Converting it to a placeholder would call
 * stubToPlaceholder, which resets `message` to `[]` — the corruption would
 * become real data loss the moment the user sees the chat list.
 */
export function convertStubsToPlaceholders(chats: ChatOrStub[]): Chat[] {
    return chats.map(c => {
        if (!c) return c as Chat
        if ((c as any)._stub === true && Array.isArray((c as any).message)) {
            const { _stub: _drop, ...rest } = c as any
            return rest as Chat
        }
        return isChatStub(c) ? stubToPlaceholder(c) : (c as Chat)
    })
}

// Classify a chat slot by shape. Used by the chat-data guard's diagnostic
// dump to surface hybrid corruption (the `_stub: true` + message pattern that
// caused widespread chat data loss in v1.4.x).
export type ChatShape = 'stub' | 'placeholder' | 'hybrid' | 'full' | 'empty' | 'neither'

export function classifyChat(c: any): ChatShape {
    if (!c) return 'empty'
    const isStub = c._stub === true
    const isPh = c._placeholder === true
    const hasMessage = Array.isArray(c.message)
    if (isStub && hasMessage) return 'hybrid'
    if (isStub) return 'stub'
    if (isPh) return 'placeholder'
    if (hasMessage) return 'full'
    return 'neither'
}

// ── Hydration state ──────────────────────────────────────────────────────────

function chatKey(chaId: string, chatId: string): string {
    return `${chaId}/${chatId}`
}

/** Hydration in progress — suppress dirty tracking */
export const hydrationInFlight = new Set<string>()

/** Hydration just applied to memory — suppress until next tick */
export const hydrationJustApplied = new Set<string>()

/** Track in-flight hydration promises to avoid duplicate fetches */
const hydrationPromises = new Map<string, Promise<Chat | null>>()

// ── Server fetch/save ───────────────────────────────────────────────────────

export async function fetchChatFromServer(chaId: string, chatIndex: number, chatId: string): Promise<Chat | null> {
    const storage = forageStorage.realStorage
    return storage.fetchChatContent(chaId, chatIndex, chatId)
}

export async function saveChatToServer(chaId: string, chatIndex: number, chatId: string, chat: Chat): Promise<void> {
    const storage = forageStorage.realStorage
    await storage.saveChatContent(chaId, chatIndex, chatId, chat)
}

// ── Hydration ───────────────────────────────────────────────────────────────

/**
 * Check if a specific chat is currently being hydrated (for dirty tracking suppression).
 */
export function isHydrating(chaId: string, chatId: string): boolean {
    const key = chatKey(chaId, chatId)
    return hydrationInFlight.has(key) || hydrationJustApplied.has(key)
}

/**
 * Hydrate a placeholder Chat in-place on the character's chats array.
 * If the slot is already a real Chat (not placeholder), returns it as-is.
 * Returns the hydrated Chat, or null if fetch failed.
 */
export async function ensureChatHydrated(
    chats: Chat[],
    index: number,
    chaId: string,
): Promise<Chat | null> {
    const slot = chats[index]
    if (!slot) return null
    if (!slot._placeholder) return slot

    const chatId = slot.id
    if (!chatId) return null
    const key = chatKey(chaId, chatId)

    // Deduplicate concurrent hydration for the same chat
    const existing = hydrationPromises.get(key)
    if (existing) return existing

    const promise = (async () => {
        hydrationInFlight.add(key)
        try {
            const full = await fetchChatFromServer(chaId, index, chatId)
            if (!full) {
                console.error(`[chatStorage] hydrate failed: chat not found on server (${key})`)
                return null
            }

            // Clear stale streaming flags: if the app died mid-stream after a
            // save, the server copy can carry isStreaming=true forever.
            // (setDatabase does the same for chats present at boot.)
            full.isStreaming = false
            full.activeStreamingDisplayOptimizationMode = undefined

            const currentIndex = chats.findIndex(chat => chat?.id === chatId)
            if (currentIndex === -1) {
                console.warn(`[chatStorage] hydrate skipped: chat removed before apply (${key})`)
                return null
            }

            const currentSlot = chats[currentIndex]
            if (!currentSlot?._placeholder) {
                return currentSlot
            }

            // Yield one frame so loading overlay dismissal paints before heavy DOM work
            await new Promise<void>(r => requestAnimationFrame(() => r()))

            // Apply to memory — mark JustApplied to suppress the reactive write-back
            hydrationJustApplied.add(key)
            chats[currentIndex] = full

            // Wait one tick so Svelte reactivity settles before allowing dirty tracking
            await tick()
            hydrationJustApplied.delete(key)

            return full
        } finally {
            hydrationInFlight.delete(key)
            hydrationPromises.delete(key)
        }
    })()

    hydrationPromises.set(key, promise)
    return promise
}

/**
 * Convenience: ensure the current active chat for a character is hydrated.
 */
export async function ensureCurrentChatReady(
    chats: Chat[],
    chatPage: number,
    chaId: string,
): Promise<Chat | null> {
    return ensureChatHydrated(chats, chatPage, chaId)
}

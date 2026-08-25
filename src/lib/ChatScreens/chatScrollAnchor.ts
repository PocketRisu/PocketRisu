const CHAT_MESSAGE_SELECTOR = '[data-chat-index]'
const POSITION_EPSILON = 0.5
const LATEST_SCROLL_EPSILON = 2
const USER_SCROLL_IDLE_MS = 200

type ChatScrollAnchorController = {
    rebase: () => void
    suspend: () => () => void
}

const controllers = new WeakMap<HTMLElement, ChatScrollAnchorController>()

export type ChatScrollAnchorSnapshot =
    | { atLatest: true }
    | {
        atLatest: false
        chatId: string | null
        chatIndex: string
        top: number
    }

function getChatMessages(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>(CHAT_MESSAGE_SELECTOR))
}

function containsChatMessage(node: Node): boolean {
    if (!(node instanceof Element)) return false
    return node.matches(CHAT_MESSAGE_SELECTOR) || node.querySelector(CHAT_MESSAGE_SELECTOR) !== null
}

function getRelativeTop(element: HTMLElement, container: HTMLElement): number {
    return element.getBoundingClientRect().top - container.getBoundingClientRect().top
}

function findSnapshotElement(
    container: HTMLElement,
    snapshot: Exclude<ChatScrollAnchorSnapshot, { atLatest: true }>,
): HTMLElement | null {
    const messages = getChatMessages(container)
    if (snapshot.chatId) {
        return messages.find((message) => message.dataset.chatId === snapshot.chatId) ?? null
    }
    return messages.find((message) => message.dataset.chatIndex === snapshot.chatIndex) ?? null
}

/**
 * Capture a stable message rather than scrollHeight. The chat uses
 * flex-direction: column-reverse, so scrollTop is negative away from the
 * latest message and scrollHeight deltas alone point in the wrong direction.
 */
export function captureChatScrollAnchor(container: HTMLElement): ChatScrollAnchorSnapshot | null {
    if (container.scrollTop >= -LATEST_SCROLL_EPSILON) {
        return { atLatest: true }
    }

    const containerRect = container.getBoundingClientRect()
    const visibleMessages = getChatMessages(container)
        .map((element) => ({ element, rect: element.getBoundingClientRect() }))
        .filter(({ rect }) => rect.bottom > containerRect.top && rect.top < containerRect.bottom)
        .sort((a, b) => a.rect.top - b.rect.top)

    const anchor = visibleMessages[0]?.element
    if (!anchor) return null

    return {
        atLatest: false,
        chatId: anchor.dataset.chatId || null,
        chatIndex: anchor.dataset.chatIndex ?? '',
        top: getRelativeTop(anchor, container),
    }
}

/** Restore a previously captured message to the same viewport-relative top. */
export function restoreChatScrollAnchor(
    container: HTMLElement,
    snapshot: ChatScrollAnchorSnapshot | null,
): ChatScrollAnchorSnapshot | null {
    if (!snapshot) return captureChatScrollAnchor(container)

    if (!('top' in snapshot)) {
        if (Math.abs(container.scrollTop) > POSITION_EPSILON) {
            container.scrollTop = 0
        }
        return snapshot
    }

    const anchor = findSnapshotElement(container, snapshot)
    if (!anchor) return captureChatScrollAnchor(container)

    const delta = getRelativeTop(anchor, container) - snapshot.top
    if (Math.abs(delta) > POSITION_EPSILON) {
        container.scrollTop += delta
    }

    // Scroll bounds can clamp the correction when messages are removed. In
    // that case, start from the new visible message instead of repeatedly
    // applying an impossible delta on every resize notification.
    if (Math.abs(getRelativeTop(anchor, container) - snapshot.top) > POSITION_EPSILON) {
        return captureChatScrollAnchor(container)
    }
    return snapshot
}

/** Rebase after an intentional application-driven scroll. */
export function rebaseChatScrollAnchor(container: HTMLElement) {
    controllers.get(container)?.rebase()
}

/**
 * Suspend layout correction during multi-step navigation. The returned resume
 * callback is nesting-safe and rebases on the resulting position.
 */
export function suspendChatScrollAnchor(container: HTMLElement): () => void {
    return controllers.get(container)?.suspend() ?? (() => {})
}

/**
 * Svelte action that keeps the reading position stable while module HTML and
 * asynchronously decoded images change existing message heights.
 */
export function preserveChatScrollAnchor(container: HTMLElement) {
    let snapshot = captureChatScrollAnchor(container)
    let lastScrollHeight = container.scrollHeight
    let scheduledFrame: number | null = null
    let resumeFrame: number | null = null
    let userScrollTimer: ReturnType<typeof setTimeout> | null = null
    let applyingCorrection = false
    let deferredLayoutChange = false
    let layoutChangePending = false
    let structuralChangePending = false
    let destroyed = false
    let suspendDepth = 0
    let userScrollActive = false
    const observedMessages = new Set<HTMLElement>()
    const observedMessageHeights = new Map<HTMLElement, number>()

    const cancelScheduledRestore = () => {
        if (scheduledFrame !== null) cancelAnimationFrame(scheduledFrame)
        scheduledFrame = null
        layoutChangePending = false
        structuralChangePending = false
    }

    const rebase = () => {
        cancelScheduledRestore()
        deferredLayoutChange = false
        snapshot = captureChatScrollAnchor(container)
        lastScrollHeight = container.scrollHeight
    }

    const armUserScrollIdle = () => {
        userScrollActive = true
        if (userScrollTimer !== null) clearTimeout(userScrollTimer)
        userScrollTimer = setTimeout(() => {
            userScrollTimer = null
            userScrollActive = false
            if (deferredLayoutChange) {
                deferredLayoutChange = false
                scheduleRestore()
            }
        }, USER_SCROLL_IDLE_MS)
    }

    const onUserScrollIntent = () => {
        if (suspendDepth > 0) return
        armUserScrollIdle()
        // A wheel/touch/scrollbar gesture owns the next position. Drop any
        // stale layout correction before the browser applies that gesture.
        rebase()
    }

    const onPointerDown = (event: PointerEvent) => {
        // Pointer events on descendants are ordinary chat interactions. A
        // pointerdown targeting the scroller itself covers scrollbar drags.
        if (event.target === container) onUserScrollIntent()
    }

    const onScrollKey = (event: KeyboardEvent) => {
        if (![' ', 'ArrowDown', 'ArrowUp', 'End', 'Home', 'PageDown', 'PageUp'].includes(event.key)) return
        const target = event.target
        if (target instanceof HTMLElement && (
            target.isContentEditable
            || target.matches('input, textarea, select, [role="textbox"]')
        )) return
        onUserScrollIntent()
    }

    const scheduleRestore = () => {
        if (suspendDepth > 0) return
        if (userScrollActive) {
            deferredLayoutChange = true
            return
        }
        layoutChangePending = true
        if (scheduledFrame !== null) return
        scheduledFrame = requestAnimationFrame(() => {
            scheduledFrame = null
            if (destroyed) return

            applyingCorrection = true
            snapshot = restoreChatScrollAnchor(container, snapshot)
            lastScrollHeight = container.scrollHeight
            applyingCorrection = false
            layoutChangePending = false
            structuralChangePending = false
        })
    }

    const suspend = () => {
        suspendDepth += 1
        cancelScheduledRestore()
        let resumed = false
        return () => {
            if (resumed) return
            resumed = true
            suspendDepth = Math.max(0, suspendDepth - 1)
            if (suspendDepth > 0 || destroyed) return
            if (resumeFrame !== null) cancelAnimationFrame(resumeFrame)
            resumeFrame = requestAnimationFrame(() => {
                resumeFrame = null
                if (!destroyed && suspendDepth === 0) rebase()
            })
        }
    }

    const resizeObserver = typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver((entries) => {
            let sizeChanged = false
            let changedOutsideAnchor = false
            const anchorElement = snapshot && 'top' in snapshot
                ? findSnapshotElement(container, snapshot)
                : null
            for (const entry of entries) {
                const message = entry.target as HTMLElement
                const height = message.getBoundingClientRect().height
                const previousHeight = observedMessageHeights.get(message)
                observedMessageHeights.set(message, height)
                if (previousHeight !== undefined && Math.abs(height - previousHeight) > POSITION_EPSILON) {
                    sizeChanged = true
                    if (message !== anchorElement) changedOutsideAnchor = true
                }
            }
            if (!sizeChanged) return

            // When content inside the currently read message grows, native
            // anchoring can keep the visible descendant stable even though the
            // wrapper's top moves. Restoring the wrapper top would introduce a
            // jump of our own. A whole-message remount already has a pending
            // MutationObserver correction, so only rebase the stable-root case.
            if (anchorElement && !changedOutsideAnchor && !structuralChangePending && suspendDepth === 0) {
                rebase()
                return
            }
            scheduleRestore()
        })

    const syncObservedMessages = () => {
        if (!resizeObserver) return
        const currentMessages = new Set(getChatMessages(container))
        for (const message of observedMessages) {
            if (!currentMessages.has(message)) {
                resizeObserver.unobserve(message)
                observedMessages.delete(message)
                observedMessageHeights.delete(message)
            }
        }
        for (const message of currentMessages) {
            if (!observedMessages.has(message)) {
                observedMessageHeights.set(message, message.getBoundingClientRect().height)
                resizeObserver.observe(message)
                observedMessages.add(message)
            }
        }
    }

    const mutationObserver = typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver((records) => {
            const messageTreeChanged = records.some((record) => (
                Array.from(record.addedNodes).some(containsChatMessage)
                || Array.from(record.removedNodes).some(containsChatMessage)
            ))

            if (messageTreeChanged) {
                syncObservedMessages()
                structuralChangePending = true
                scheduleRestore()
                return
            }

            // ResizeObserver handles internal module/markdown mutations without
            // rescanning all messages. Retain a fallback for older browsers.
            if (!resizeObserver && records.some((record) => (
                record.target instanceof Element
                && record.target.closest(CHAT_MESSAGE_SELECTOR) !== null
            ))) scheduleRestore()
        })

    const onScroll = () => {
        if (applyingCorrection || suspendDepth > 0) return

        if (userScrollActive) {
            rebase()
            armUserScrollIdle()
            return
        }

        if (layoutChangePending) return

        // Native scroll anchoring can emit a scroll event before the resize
        // observer runs. Do not overwrite the pre-layout snapshot in that gap.
        if (Math.abs(container.scrollHeight - lastScrollHeight) > POSITION_EPSILON) {
            scheduleRestore()
            return
        }
        snapshot = captureChatScrollAnchor(container)
    }

    syncObservedMessages()
    mutationObserver?.observe(container, { childList: true, subtree: true })
    container.addEventListener('scroll', onScroll, { passive: true })
    container.addEventListener('pointerdown', onPointerDown, { passive: true })
    container.addEventListener('touchmove', onUserScrollIntent, { passive: true })
    container.addEventListener('touchstart', onUserScrollIntent, { passive: true })
    container.addEventListener('wheel', onUserScrollIntent, { passive: true })
    window.addEventListener('keydown', onScrollKey, true)

    const controller = { rebase, suspend }
    controllers.set(container, controller)

    return {
        destroy() {
            destroyed = true
            cancelScheduledRestore()
            if (resumeFrame !== null) cancelAnimationFrame(resumeFrame)
            if (userScrollTimer !== null) clearTimeout(userScrollTimer)
            mutationObserver?.disconnect()
            resizeObserver?.disconnect()
            observedMessages.clear()
            observedMessageHeights.clear()
            container.removeEventListener('scroll', onScroll)
            container.removeEventListener('pointerdown', onPointerDown)
            container.removeEventListener('touchmove', onUserScrollIntent)
            container.removeEventListener('touchstart', onUserScrollIntent)
            container.removeEventListener('wheel', onUserScrollIntent)
            window.removeEventListener('keydown', onScrollKey, true)
            if (controllers.get(container) === controller) controllers.delete(container)
        },
    }
}

// Scroll isolation for open modals.
//
// The chat log is a scrolling <div>, not the document, so nothing about an open
// modal stopped it from scrolling underneath: a wheel or drag that landed on the
// backdrop went straight through to the chat, and one that landed on the modal's
// own scroll panel chained to the chat the moment the panel hit its top or
// bottom. That is why scrolling inside a modal only worked if you kept the
// pointer over the panel and away from its edges.
//
// `overscroll-behavior: contain` alone does not fix it: browsers pick the scroll
// chain starting from the nearest ancestor that can actually move, so a backdrop
// with nothing to scroll is skipped entirely and the property never applies.
//
// So: one document-level listener. While a modal is open, a scroll gesture is
// allowed only if some element between the event target and the modal root can
// still move in the requested direction. Otherwise it is cancelled outright.

/** The subset of scroll geometry the decision needs; injectable for tests. */
export interface ScrollMetrics {
    scrollTop: number
    scrollHeight: number
    clientHeight: number
    overflowY: string
}

// Selectors for "an overlay that owns the screen right now". Hand-rolled
// overlays opt in with data-risu-modal-scroll; bits-ui dialogs are matched by
// the role/state pair they already render.
const MODAL_ROOT_SELECTOR = [
    '[data-risu-modal-scroll]',
    '[role="dialog"][data-state="open"]',
    '[role="alertdialog"][data-state="open"]',
].join(',')

// Slack for sub-pixel scrollTop values (fractional zoom, device pixel ratios):
// without it a container sitting at its true bottom can read as 0.5px short and
// be treated as still scrollable, letting the gesture through.
const EDGE_EPSILON = 1

export function canScrollBy(metrics: ScrollMetrics, deltaY: number): boolean {
    if (deltaY === 0) return false
    if (metrics.overflowY === 'hidden' || metrics.overflowY === 'visible' || metrics.overflowY === 'clip') {
        return false
    }
    if (metrics.scrollHeight - metrics.clientHeight <= EDGE_EPSILON) return false
    if (deltaY < 0) return metrics.scrollTop > EDGE_EPSILON
    return metrics.scrollTop < metrics.scrollHeight - metrics.clientHeight - EDGE_EPSILON
}

export function readScrollMetrics(element: Element): ScrollMetrics {
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(element) : null
    return {
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        overflowY: style?.overflowY ?? 'visible',
    }
}

/**
 * Nearest element from `from` up to and including `boundary` that can still
 * scroll `deltaY`, or null when the gesture would escape the modal.
 */
export function findScrollableAncestor(
    from: Element | null,
    boundary: Element,
    deltaY: number,
    readMetrics: (element: Element) => ScrollMetrics = readScrollMetrics,
): Element | null {
    let node: Element | null = from
    while (node) {
        if (canScrollBy(readMetrics(node), deltaY)) return node
        if (node === boundary) return null
        node = node.parentElement
    }
    return null
}

/** Topmost open modal root, or null when no modal is open. */
export function getActiveModalRoot(doc: Document = document): Element | null {
    const roots = doc.querySelectorAll(MODAL_ROOT_SELECTOR)
    return roots.length === 0 ? null : roots[roots.length - 1]
}

/**
 * True when a scroll gesture at `target` must be cancelled: either it happened
 * outside the modal entirely (the backdrop, or the chat behind it), or nothing
 * inside the modal can absorb it.
 */
export function shouldBlockScroll(
    target: Element | null,
    deltaY: number,
    doc: Document = document,
    readMetrics: (element: Element) => ScrollMetrics = readScrollMetrics,
): boolean {
    const modalRoot = getActiveModalRoot(doc)
    if (!modalRoot) return false
    if (deltaY === 0) return false
    if (!target || !modalRoot.contains(target)) return true
    return findScrollableAncestor(target, modalRoot, deltaY, readMetrics) === null
}

let installed = false

/** Idempotent; safe to call from bootstrap on every start. */
export function initModalScrollLock(): void {
    if (installed || typeof document === 'undefined') return
    installed = true

    document.addEventListener('wheel', (event) => {
        if (event.ctrlKey) return // pinch-zoom
        if (shouldBlockScroll(event.target as Element | null, event.deltaY)) {
            event.preventDefault()
        }
    }, { passive: false })

    let touchStartY = 0
    let multiTouch = false

    document.addEventListener('touchstart', (event) => {
        multiTouch = event.touches.length > 1
        touchStartY = event.touches[0]?.clientY ?? 0
    }, { passive: true })

    document.addEventListener('touchmove', (event) => {
        if (multiTouch || event.touches.length > 1) return
        const currentY = event.touches[0]?.clientY ?? 0
        // Finger up (currentY < startY) reveals content further down, i.e. a
        // positive scroll delta — same sign convention as wheel deltaY.
        const deltaY = touchStartY - currentY
        if (shouldBlockScroll(event.target as Element | null, deltaY)) {
            event.preventDefault()
        }
    }, { passive: false })
}

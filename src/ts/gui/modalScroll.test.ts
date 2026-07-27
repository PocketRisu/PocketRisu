import { beforeEach, describe, expect, test } from 'vitest'
import {
    canScrollBy,
    findScrollableAncestor,
    getActiveModalRoot,
    shouldBlockScroll,
    type ScrollMetrics,
} from './modalScroll'

// happy-dom reports every layout metric as 0, so scroll geometry is supplied
// through the injectable reader instead of being faked onto the elements.
const metricsBySelector = new Map<Element, ScrollMetrics>()
const readMetrics = (element: Element): ScrollMetrics =>
    metricsBySelector.get(element) ?? { scrollTop: 0, scrollHeight: 0, clientHeight: 0, overflowY: 'visible' }

function scrollable(element: Element, scrollTop: number, scrollHeight = 1000, clientHeight = 400) {
    metricsBySelector.set(element, { scrollTop, scrollHeight, clientHeight, overflowY: 'auto' })
    return element
}

beforeEach(() => {
    metricsBySelector.clear()
    document.body.innerHTML = ''
})

describe('canScrollBy', () => {
    const base: ScrollMetrics = { scrollTop: 100, scrollHeight: 1000, clientHeight: 400, overflowY: 'auto' }

    test('allows movement while there is room in that direction', () => {
        expect(canScrollBy(base, 10)).toBe(true)
        expect(canScrollBy(base, -10)).toBe(true)
    })

    test('refuses at each edge', () => {
        expect(canScrollBy({ ...base, scrollTop: 0 }, -10)).toBe(false)
        expect(canScrollBy({ ...base, scrollTop: 0 }, 10)).toBe(true)
        expect(canScrollBy({ ...base, scrollTop: 600 }, 10)).toBe(false)
        expect(canScrollBy({ ...base, scrollTop: 600 }, -10)).toBe(true)
    })

    test('tolerates sub-pixel scroll offsets at the edges', () => {
        expect(canScrollBy({ ...base, scrollTop: 0.5 }, -10)).toBe(false)
        expect(canScrollBy({ ...base, scrollTop: 599.5 }, 10)).toBe(false)
    })

    test('refuses non-scrolling overflow and content that fits', () => {
        expect(canScrollBy({ ...base, overflowY: 'hidden' }, 10)).toBe(false)
        expect(canScrollBy({ ...base, overflowY: 'visible' }, 10)).toBe(false)
        expect(canScrollBy({ ...base, scrollHeight: 400 }, 10)).toBe(false)
        expect(canScrollBy(base, 0)).toBe(false)
    })
})

describe('findScrollableAncestor', () => {
    test('walks up to the boundary and stops there', () => {
        document.body.innerHTML = `
            <div id="outer"><div id="modal"><div id="panel"><span id="leaf"></span></div></div></div>`
        const modal = document.getElementById('modal')!
        const panel = document.getElementById('panel')!
        const leaf = document.getElementById('leaf')!
        const outer = document.getElementById('outer')!
        scrollable(panel, 100)
        scrollable(outer, 100)

        expect(findScrollableAncestor(leaf, modal, 10, readMetrics)).toBe(panel)

        // Panel pinned at its bottom: the outer scroller is past the boundary,
        // so the gesture has nowhere to go rather than escaping the modal.
        scrollable(panel, 600)
        expect(findScrollableAncestor(leaf, modal, 10, readMetrics)).toBe(null)
        expect(findScrollableAncestor(leaf, modal, -10, readMetrics)).toBe(panel)
    })

    test('returns the boundary itself when it is the scroller', () => {
        document.body.innerHTML = `<div id="modal"><span id="leaf"></span></div>`
        const modal = scrollable(document.getElementById('modal')!, 100)
        expect(findScrollableAncestor(document.getElementById('leaf'), modal, 10, readMetrics)).toBe(modal)
    })

    test('returns null for a null target', () => {
        document.body.innerHTML = `<div id="modal"></div>`
        expect(findScrollableAncestor(null, document.getElementById('modal')!, 10, readMetrics)).toBe(null)
    })
})

describe('getActiveModalRoot', () => {
    test('is null with no modal open', () => {
        document.body.innerHTML = `<div id="chat"></div>`
        expect(getActiveModalRoot(document)).toBe(null)
    })

    test('matches hand-rolled overlays and open bits-ui dialogs', () => {
        document.body.innerHTML = `<div id="a" data-risu-modal-scroll></div>`
        expect(getActiveModalRoot(document)?.id).toBe('a')

        document.body.innerHTML = `<div id="b" role="dialog" data-state="open"></div>`
        expect(getActiveModalRoot(document)?.id).toBe('b')

        document.body.innerHTML = `<div id="c" role="alertdialog" data-state="open"></div>`
        expect(getActiveModalRoot(document)?.id).toBe('c')
    })

    test('ignores closed dialogs and picks the last of several open ones', () => {
        document.body.innerHTML = `
            <div id="closed" role="dialog" data-state="closed"></div>
            <div id="first" data-risu-modal-scroll></div>
            <div id="last" role="dialog" data-state="open"></div>`
        expect(getActiveModalRoot(document)?.id).toBe('last')
    })
})

describe('shouldBlockScroll', () => {
    function setup() {
        document.body.innerHTML = `
            <div id="chat"><span id="behind"></span></div>
            <div id="modal" data-risu-modal-scroll>
                <div id="panel"><span id="leaf"></span></div>
            </div>`
        scrollable(document.getElementById('chat')!, 100)
        return {
            behind: document.getElementById('behind')!,
            panel: document.getElementById('panel')!,
            leaf: document.getElementById('leaf')!,
            modal: document.getElementById('modal')!,
        }
    }

    test('lets everything through when no modal is open', () => {
        document.body.innerHTML = `<div id="chat"><span id="behind"></span></div>`
        scrollable(document.getElementById('chat')!, 100)
        expect(shouldBlockScroll(document.getElementById('behind'), 10, document, readMetrics)).toBe(false)
    })

    test('blocks the chat behind the modal', () => {
        const { behind } = setup()
        expect(shouldBlockScroll(behind, 10, document, readMetrics)).toBe(true)
        expect(shouldBlockScroll(behind, -10, document, readMetrics)).toBe(true)
    })

    test('blocks the backdrop itself', () => {
        const { modal } = setup()
        expect(shouldBlockScroll(modal, 10, document, readMetrics)).toBe(true)
    })

    test('allows scrolling the panel inside the modal', () => {
        const { panel, leaf } = setup()
        scrollable(panel, 100)
        expect(shouldBlockScroll(leaf, 10, document, readMetrics)).toBe(false)
        expect(shouldBlockScroll(leaf, -10, document, readMetrics)).toBe(false)
    })

    test('blocks at the panel edge instead of chaining to the chat', () => {
        const { panel, leaf } = setup()
        scrollable(panel, 600)
        expect(shouldBlockScroll(leaf, 10, document, readMetrics)).toBe(true)
        expect(shouldBlockScroll(leaf, -10, document, readMetrics)).toBe(false)
    })

    test('ignores zero-delta events and null targets', () => {
        const { leaf } = setup()
        expect(shouldBlockScroll(leaf, 0, document, readMetrics)).toBe(false)
        expect(shouldBlockScroll(null, 10, document, readMetrics)).toBe(true)
    })
})

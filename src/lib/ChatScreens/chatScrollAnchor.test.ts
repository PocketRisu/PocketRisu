// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest'
import {
    captureChatScrollAnchor,
    preserveChatScrollAnchor,
    restoreChatScrollAnchor,
    suspendChatScrollAnchor,
} from './chatScrollAnchor'

type RectState = { bottom: number; top: number }

afterEach(() => {
    vi.unstubAllGlobals()
})

function createGeometryFixture(options: {
    messages: Array<{ chatId?: string; chatIndex: string; rect: RectState }>
    scrollTop: number
}) {
    const container = document.createElement('div')
    let currentScrollTop = options.scrollTop
    let currentScrollHeight = 4000
    const rects = new Map<HTMLElement, RectState>()

    Object.defineProperty(container, 'scrollTop', {
        configurable: true,
        get: () => currentScrollTop,
        set: (next: number) => {
            const delta = next - currentScrollTop
            currentScrollTop = next
            for (const rect of rects.values()) {
                rect.top -= delta
                rect.bottom -= delta
            }
        },
    })
    Object.defineProperty(container, 'scrollHeight', {
        configurable: true,
        get: () => currentScrollHeight,
    })
    container.getBoundingClientRect = () => ({
        bottom: 500,
        height: 500,
        left: 0,
        right: 600,
        top: 0,
        width: 600,
        x: 0,
        y: 0,
        toJSON: () => ({}),
    })

    const messages = options.messages.map(({ chatId, chatIndex, rect }) => {
        const element = document.createElement('div')
        element.dataset.chatIndex = chatIndex
        if (chatId) element.dataset.chatId = chatId
        const state = { ...rect }
        rects.set(element, state)
        element.getBoundingClientRect = () => ({
            bottom: state.bottom,
            height: state.bottom - state.top,
            left: 0,
            right: 600,
            top: state.top,
            width: 600,
            x: 0,
            y: state.top,
            toJSON: () => ({}),
        })
        container.appendChild(element)
        return element
    })

    return {
        container,
        messages,
        rects,
        setScrollHeight: (height: number) => { currentScrollHeight = height },
    }
}

function installObserverHarness() {
    let resizeCallback: ResizeObserverCallback = () => {}
    let mutationCallback: MutationCallback = () => {}
    let nextFrameId = 1
    const frames = new Map<number, FrameRequestCallback>()
    const observe = vi.fn()
    const unobserve = vi.fn()

    class ResizeObserverMock {
        constructor(callback: ResizeObserverCallback) {
            resizeCallback = callback
        }
        disconnect() {}
        observe = observe
        unobserve = unobserve
    }
    class MutationObserverMock {
        constructor(callback: MutationCallback) {
            mutationCallback = callback
        }
        disconnect() {}
        observe() {}
    }

    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    vi.stubGlobal('MutationObserver', MutationObserverMock)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        const id = nextFrameId++
        frames.set(id, callback)
        return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))

    return {
        fireMutation(records: MutationRecord[]) {
            mutationCallback(records, {} as MutationObserver)
        },
        fireResize(elements: HTMLElement[]) {
            resizeCallback(
                elements.map((target) => ({ target }) as unknown as ResizeObserverEntry),
                {} as ResizeObserver,
            )
        },
        flushFrames() {
            const pending = Array.from(frames.values())
            frames.clear()
            for (const frame of pending) frame(0)
        },
        observe,
        unobserve,
    }
}

describe('chat scroll anchoring', () => {
    test('captures the topmost visible message while reading older chat', () => {
        const { container } = createGeometryFixture({
            scrollTop: -900,
            messages: [
                { chatIndex: '12', rect: { top: 260, bottom: 460 } },
                { chatIndex: '11', rect: { top: -140, bottom: 260 } },
            ],
        })

        expect(captureChatScrollAnchor(container)).toEqual({
            atLatest: false,
            chatId: null,
            chatIndex: '11',
            top: -140,
        })
    })

    test('restores a remounted message by stable chat id', () => {
        const { container, messages, rects } = createGeometryFixture({
            scrollTop: -900,
            messages: [
                { chatId: 'stable-id', chatIndex: '11', rect: { top: -140, bottom: 260 } },
            ],
        })
        const snapshot = captureChatScrollAnchor(container)
        const oldMessage = messages[0]

        const replacement = document.createElement('div')
        replacement.dataset.chatId = 'stable-id'
        replacement.dataset.chatIndex = '12'
        const replacementRect = { top: 369, bottom: 769 }
        rects.set(replacement, replacementRect)
        replacement.getBoundingClientRect = () => ({
            bottom: replacementRect.bottom,
            height: replacementRect.bottom - replacementRect.top,
            left: 0,
            right: 600,
            top: replacementRect.top,
            width: 600,
            x: 0,
            y: replacementRect.top,
            toJSON: () => ({}),
        })
        oldMessage.replaceWith(replacement)
        rects.delete(oldMessage)

        restoreChatScrollAnchor(container, snapshot)

        expect(container.scrollTop).toBe(-391)
        expect(replacement.getBoundingClientRect().top).toBe(-140)
    })

    test('does not double-correct when native anchoring already preserved the message', () => {
        const { container } = createGeometryFixture({
            scrollTop: -900,
            messages: [{ chatIndex: '11', rect: { top: -140, bottom: 260 } }],
        })
        const snapshot = captureChatScrollAnchor(container)

        restoreChatScrollAnchor(container, snapshot)

        expect(container.scrollTop).toBe(-900)
    })

    test('pins the latest view to zero after existing-message growth', () => {
        const { container } = createGeometryFixture({
            scrollTop: 0,
            messages: [{ chatIndex: '20', rect: { top: 120, bottom: 480 } }],
        })
        const snapshot = captureChatScrollAnchor(container)

        container.scrollTop = -420
        restoreChatScrollAnchor(container, snapshot)

        expect(container.scrollTop).toBe(0)
    })

    test('uses the first resize delivery as a baseline instead of snapping a new user scroll', () => {
        const observers = installObserverHarness()

        const { container, messages } = createGeometryFixture({
            scrollTop: 0,
            messages: [{ chatIndex: '11', rect: { top: -800, bottom: -600 } }],
        })
        const controller = preserveChatScrollAnchor(container)

        observers.fireResize([messages[0]])
        container.scrollTop = -900
        container.dispatchEvent(new Event('scroll'))
        observers.flushFrames()

        expect(container.scrollTop).toBe(-900)
        controller.destroy()
    })

    test('restores the visible message when another message changes height', () => {
        const observers = installObserverHarness()
        const { container, messages, rects, setScrollHeight } = createGeometryFixture({
            scrollTop: -900,
            messages: [
                { chatId: 'stable-id', chatIndex: '11', rect: { top: -140, bottom: 260 } },
                { chatId: 'other-id', chatIndex: '12', rect: { top: 260, bottom: 460 } },
            ],
        })
        const controller = preserveChatScrollAnchor(container)
        const anchorRect = rects.get(messages[0])!
        const otherRect = rects.get(messages[1])!

        anchorRect.top += 180
        anchorRect.bottom += 180
        otherRect.bottom += 200
        setScrollHeight(4200)
        observers.fireResize([messages[1]])
        observers.flushFrames()

        expect(messages[0].getBoundingClientRect().top).toBe(-140)
        controller.destroy()
    })

    test('keeps a user wheel scroll made while a layout correction is pending', () => {
        const observers = installObserverHarness()
        const { container, messages, rects, setScrollHeight } = createGeometryFixture({
            scrollTop: 0,
            messages: [{ chatId: 'latest', chatIndex: '20', rect: { top: 120, bottom: 480 } }],
        })
        const controller = preserveChatScrollAnchor(container)
        const rect = rects.get(messages[0])!

        rect.bottom += 200
        setScrollHeight(4200)
        observers.fireResize([messages[0]])
        container.dispatchEvent(new WheelEvent('wheel', { deltaY: -200 }))
        container.scrollTop = -900
        container.dispatchEvent(new Event('scroll'))
        observers.flushFrames()

        expect(container.scrollTop).toBe(-900)
        controller.destroy()
    })

    test('tracks a stable message through remount and delayed image growth', () => {
        const observers = installObserverHarness()
        const { container, messages, rects, setScrollHeight } = createGeometryFixture({
            scrollTop: -900,
            messages: [{ chatId: 'stable-id', chatIndex: '11', rect: { top: -140, bottom: 260 } }],
        })
        const controller = preserveChatScrollAnchor(container)
        const oldMessage = messages[0]
        const replacement = document.createElement('div')
        replacement.dataset.chatId = 'stable-id'
        replacement.dataset.chatIndex = '12'
        const replacementRect = { top: 369, bottom: 769 }
        rects.set(replacement, replacementRect)
        replacement.getBoundingClientRect = () => ({
            bottom: replacementRect.bottom,
            height: replacementRect.bottom - replacementRect.top,
            left: 0,
            right: 600,
            top: replacementRect.top,
            width: 600,
            x: 0,
            y: replacementRect.top,
            toJSON: () => ({}),
        })
        const readingMarker = document.createElement('span')
        const readingMarkerRect = { top: 700, bottom: 720 }
        rects.set(readingMarker, readingMarkerRect)
        readingMarker.getBoundingClientRect = () => ({
            bottom: readingMarkerRect.bottom,
            height: readingMarkerRect.bottom - readingMarkerRect.top,
            left: 0,
            right: 600,
            top: readingMarkerRect.top,
            width: 600,
            x: 0,
            y: readingMarkerRect.top,
            toJSON: () => ({}),
        })
        replacement.appendChild(readingMarker)
        oldMessage.replaceWith(replacement)
        rects.delete(oldMessage)

        observers.fireMutation([{
            addedNodes: [replacement],
            removedNodes: [oldMessage],
            target: container,
        } as unknown as MutationRecord])
        observers.flushFrames()

        expect(replacement.getBoundingClientRect().top).toBe(-140)
        expect(observers.unobserve).toHaveBeenCalledWith(oldMessage)
        expect(observers.observe).toHaveBeenCalledWith(replacement)

        const markerTopBeforeGrowth = readingMarker.getBoundingClientRect().top
        replacementRect.top -= 300
        setScrollHeight(4710)
        observers.fireResize([replacement])
        observers.flushFrames()

        expect(readingMarker.getBoundingClientRect().top).toBe(markerTopBeforeGrowth)
        controller.destroy()
    })

    test('accepts native anchoring when scroll fires before current-message resize', () => {
        const observers = installObserverHarness()
        const { container, messages, rects, setScrollHeight } = createGeometryFixture({
            scrollTop: -900,
            messages: [{ chatId: 'stable-id', chatIndex: '11', rect: { top: -140, bottom: 260 } }],
        })
        const message = messages[0]
        const messageRect = rects.get(message)!
        const marker = document.createElement('span')
        const markerRect = { top: 100, bottom: 120 }
        rects.set(marker, markerRect)
        marker.getBoundingClientRect = () => ({
            bottom: markerRect.bottom,
            height: markerRect.bottom - markerRect.top,
            left: 0,
            right: 600,
            top: markerRect.top,
            width: 600,
            x: 0,
            y: markerRect.top,
            toJSON: () => ({}),
        })
        message.appendChild(marker)
        const controller = preserveChatScrollAnchor(container)

        // Content below the marker grows. Reverse layout first moves the
        // message/marker up, then native anchoring adjusts scrollTop so the
        // marker returns to its original visual position before RO fires.
        messageRect.top -= 300
        markerRect.top -= 300
        markerRect.bottom -= 300
        setScrollHeight(4300)
        container.scrollTop -= 300
        container.dispatchEvent(new Event('scroll'))
        observers.fireResize([message])
        observers.flushFrames()

        expect(container.scrollTop).toBe(-1200)
        expect(marker.getBoundingClientRect().top).toBe(100)
        controller.destroy()
    })

    test('rebases instead of restoring an old anchor after suspended navigation', () => {
        const observers = installObserverHarness()
        const { container } = createGeometryFixture({
            scrollTop: 0,
            messages: [{ chatId: 'latest', chatIndex: '20', rect: { top: 120, bottom: 480 } }],
        })
        const controller = preserveChatScrollAnchor(container)
        const resume = suspendChatScrollAnchor(container)

        container.scrollTop = -900
        container.dispatchEvent(new Event('scroll'))
        resume()
        observers.flushFrames()

        expect(container.scrollTop).toBe(-900)
        controller.destroy()
    })
})

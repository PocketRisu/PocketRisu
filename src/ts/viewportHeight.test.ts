import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { installDynamicViewportHeight } from './viewportHeight'

class FakeVisualViewport extends EventTarget {
    height: number
    scale = 1
    constructor(height: number) {
        super()
        this.height = height
    }
}

let vv: FakeVisualViewport
let innerHeight: number
let rafQueue: FrameRequestCallback[]

const heightVar = () => document.documentElement.style.getPropertyValue('--risu-height-size')
const flushFrames = () => {
    const queued = rafQueue
    rafQueue = []
    for (const cb of queued) cb(0)
}
// Toolbars move both viewports; the keyboard moves only the visual one.
const setViewport = (visual: number, layout = innerHeight) => {
    vv.height = visual
    innerHeight = layout
    vv.dispatchEvent(new Event('resize'))
    flushFrames()
}

describe('installDynamicViewportHeight', () => {
    let textarea: HTMLTextAreaElement

    beforeEach(() => {
        innerHeight = 640
        vv = new FakeVisualViewport(640)
        rafQueue = []
        vi.stubGlobal('visualViewport', vv)
        vi.spyOn(window, 'innerHeight', 'get').mockImplementation(() => innerHeight)
        vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => rafQueue.push(cb))
        document.documentElement.style.removeProperty('--risu-height-size')
        textarea = document.createElement('textarea')
        document.body.appendChild(textarea)
    })

    afterEach(() => {
        textarea.remove()
        vi.restoreAllMocks()
        vi.unstubAllGlobals()
    })

    test('catches up when the keyboard closes but focus stays in the composer', () => {
        installDynamicViewportHeight()
        setViewport(696, 696) // toolbars hidden
        textarea.focus()
        setViewport(400) // keyboard open
        expect(heightVar()).toBe('696px')
        setViewport(640, 640) // keyboard dismissed with Back, toolbars back, still focused
        expect(heightVar()).toBe('640px')
    })

    test('re-measures when focus leaves the composer', () => {
        installDynamicViewportHeight()
        textarea.focus()
        setViewport(400) // keyboard open, skipped
        vv.height = 600 // settled without a further resize event
        textarea.blur()
        flushFrames()
        expect(heightVar()).toBe('600px')
    })

    test('skips while pinch-zoomed', () => {
        installDynamicViewportHeight()
        vv.scale = 2
        setViewport(320)
        expect(heightVar()).toBe('640px')
    })
})

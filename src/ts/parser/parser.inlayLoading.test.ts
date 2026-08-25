// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../stores.svelte', () => ({
    DBState: {
        db: {
            hideAllImages: false,
            inlayImagePriority: true,
        },
    },
    selectedCharID: { subscribe: () => () => {} },
    selIdState: { selId: 0 },
}))

vi.mock('../process/files/inlays', () => ({
    getInlayInfosBatch: vi.fn(async () => ({})),
}))

import { parseInlayAssets, resolveInlayPlaceholders } from './parser.svelte'
import { DBState } from '../stores.svelte'

describe('inlay loading cache', () => {
    let intersectionCallbacks: IntersectionObserverCallback[]
    let createdImages: HTMLImageElement[]
    let createElementSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        DBState.db.hideAllImages = false
        intersectionCallbacks = []
        createdImages = []

        class IntersectionObserverMock {
            constructor(callback: IntersectionObserverCallback) {
                intersectionCallbacks.push(callback)
            }
            disconnect() {}
            observe() {}
            takeRecords() { return [] }
            unobserve() {}
        }
        vi.stubGlobal('IntersectionObserver', IntersectionObserverMock)

        const createElement = document.createElement.bind(document)
        createElementSpy = vi.spyOn(document, 'createElement').mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
            const element = createElement(tagName, options)
            if (tagName.toLowerCase() === 'img') {
                let assignedSrc = ''
                Object.defineProperty(element, 'src', {
                    configurable: true,
                    get: () => assignedSrc,
                    set: (value: string) => { assignedSrc = value },
                })
                createdImages.push(element as HTMLImageElement)
            }
            return element
        }) as typeof document.createElement)
    })

    afterEach(() => {
        vi.useRealTimers()
        createElementSpy.mockRestore()
        vi.unstubAllGlobals()
        document.body.replaceChildren()
    })

    test('keeps every rerender on a placeholder until one shared image probe is ready', async () => {
        const id = `loading-${crypto.randomUUID()}`
        const token = `{{inlayed::${id}}}`
        const roots = [document.createElement('div'), document.createElement('div')]

        roots[0].innerHTML = parseInlayAssets(token)
        document.body.appendChild(roots[0])
        resolveInlayPlaceholders(roots[0])
        const firstPlaceholder = roots[0].querySelector<HTMLElement>('[data-inlay-id]')!
        intersectionCallbacks[0]([
            { isIntersecting: true, target: firstPlaceholder } as unknown as IntersectionObserverEntry,
        ], {} as IntersectionObserver)

        await vi.waitFor(() => expect(createdImages).toHaveLength(1))
        expect(parseInlayAssets(token)).toContain('data-inlay-id')

        roots[1].innerHTML = parseInlayAssets(token)
        document.body.appendChild(roots[1])
        resolveInlayPlaceholders(roots[1])
        const secondPlaceholder = roots[1].querySelector<HTMLElement>('[data-inlay-id]')!
        intersectionCallbacks[1]([
            { isIntersecting: true, target: secondPlaceholder } as unknown as IntersectionObserverEntry,
        ], {} as IntersectionObserver)

        await Promise.resolve()
        expect(createdImages).toHaveLength(1)

        const probe = createdImages[0]
        Object.defineProperties(probe, {
            naturalHeight: { configurable: true, value: 360 },
            naturalWidth: { configurable: true, value: 1080 },
        })
        probe.onload?.(new Event('load'))

        await vi.waitFor(() => {
            expect(roots[0].querySelector('img')).not.toBeNull()
            expect(roots[1].querySelector('img')).not.toBeNull()
        })

        const rendered = parseInlayAssets(token)
        expect(rendered).toContain('<img')
        expect(rendered).toContain('width="1080" height="360"')
        expect(rendered).not.toContain('data-inlay-id')
    })

    test('shares the image error probe and caches the detected video type', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(null, {
            headers: { 'content-type': 'video/mp4' },
            status: 200,
        })))
        const id = `video-${crypto.randomUUID()}`
        const token = `{{inlay::${id}}}`
        const root = document.createElement('div')
        root.innerHTML = parseInlayAssets(token)
        document.body.appendChild(root)
        resolveInlayPlaceholders(root)
        const placeholder = root.querySelector<HTMLElement>('[data-inlay-id]')!
        intersectionCallbacks[0]([
            { isIntersecting: true, target: placeholder } as unknown as IntersectionObserverEntry,
        ], {} as IntersectionObserver)

        await vi.waitFor(() => expect(createdImages).toHaveLength(1))
        await createdImages[0].onerror?.(new Event('error'))

        await vi.waitFor(() => expect(root.querySelector('video')).not.toBeNull())
        expect(fetch).toHaveBeenCalledTimes(1)
        expect(parseInlayAssets(token)).toContain('<video controls>')
    })

    test('removes hidden image placeholders without starting a probe', async () => {
        DBState.db.hideAllImages = true
        const id = `hidden-${crypto.randomUUID()}`
        const root = document.createElement('div')
        root.innerHTML = parseInlayAssets(`{{inlay::${id}}}`)
        document.body.appendChild(root)
        resolveInlayPlaceholders(root)
        const placeholder = root.querySelector<HTMLElement>('[data-inlay-id]')!
        intersectionCallbacks[0]([
            { isIntersecting: true, target: placeholder } as unknown as IntersectionObserverEntry,
        ], {} as IntersectionObserver)

        await vi.waitFor(() => expect(root.querySelector('[data-inlay-id]')).toBeNull())
        expect(createdImages).toHaveLength(0)
    })

    test('retries a transient probe failure after a short backoff', async () => {
        vi.useFakeTimers()
        vi.stubGlobal('fetch', vi.fn(async () => new Response(null, {
            headers: { 'content-type': 'image/png' },
            status: 200,
        })))
        const id = `retry-${crypto.randomUUID()}`
        const root = document.createElement('div')
        root.innerHTML = parseInlayAssets(`{{inlay::${id}}}`)
        document.body.appendChild(root)
        resolveInlayPlaceholders(root)
        const placeholder = root.querySelector<HTMLElement>('[data-inlay-id]')!
        intersectionCallbacks[0]([
            { isIntersecting: true, target: placeholder } as unknown as IntersectionObserverEntry,
        ], {} as IntersectionObserver)

        await Promise.resolve()
        expect(createdImages).toHaveLength(1)
        await createdImages[0].onerror?.(new Event('error'))
        await Promise.resolve()

        expect(root.querySelector('[data-inlay-id]')).not.toBeNull()
        await vi.advanceTimersByTimeAsync(3000)
        expect(createdImages).toHaveLength(2)
    })

    test('stops automatic retries after the bounded exponential backoff', async () => {
        vi.useFakeTimers()
        vi.stubGlobal('fetch', vi.fn(async () => new Response(null, {
            headers: { 'content-type': 'image/png' },
            status: 200,
        })))
        const id = `retry-limit-${crypto.randomUUID()}`
        const root = document.createElement('div')
        root.innerHTML = parseInlayAssets(`{{inlay::${id}}}`)
        document.body.appendChild(root)
        resolveInlayPlaceholders(root)
        const placeholder = root.querySelector<HTMLElement>('[data-inlay-id]')!
        intersectionCallbacks[0]([
            { isIntersecting: true, target: placeholder } as unknown as IntersectionObserverEntry,
        ], {} as IntersectionObserver)
        await Promise.resolve()

        const retryDelays = [3000, 6000, 12000, 24000, 30000]
        for (let index = 0; index < retryDelays.length; index++) {
            await createdImages[index].onerror?.(new Event('error'))
            await Promise.resolve()
            await vi.advanceTimersByTimeAsync(retryDelays[index])
            expect(createdImages).toHaveLength(index + 2)
        }

        await createdImages[5].onerror?.(new Event('error'))
        await Promise.resolve()
        await vi.advanceTimersByTimeAsync(60000)

        expect(createdImages).toHaveLength(6)
        expect(root.querySelector('[data-missing-inlay-id]')).not.toBeNull()
    })
})

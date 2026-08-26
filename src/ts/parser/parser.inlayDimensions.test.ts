// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const { getInlayInfosBatchMock } = vi.hoisted(() => ({
    getInlayInfosBatchMock: vi.fn(),
}))

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
    getInlayInfosBatch: getInlayInfosBatchMock,
}))

import { parseInlayAssets, resolveInlayPlaceholders, trimMarkdown } from './parser.svelte'
import { DBState } from '../stores.svelte'

describe('inlay dimension loading', () => {
    let intersectionCallbacks: IntersectionObserverCallback[]

    beforeEach(() => {
        DBState.db.hideAllImages = false
        getInlayInfosBatchMock.mockReset()
        intersectionCallbacks = []

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
    })

    afterEach(() => {
        vi.unstubAllGlobals()
        document.body.replaceChildren()
    })

    test('applies pending dimensions to an inlay remounted before metadata resolves', async () => {
        const id = `remount-${crypto.randomUUID()}`
        const token = `{{inlay::${id}}}`
        let resolveInfo!: (value: Record<string, {
            height: number
            type: 'image'
            width: number
        }>) => void

        getInlayInfosBatchMock.mockReturnValueOnce(new Promise((resolve) => {
            resolveInfo = resolve
        }))

        const firstRoot = document.createElement('div')
        firstRoot.innerHTML = parseInlayAssets(token)
        document.body.appendChild(firstRoot)
        resolveInlayPlaceholders(firstRoot)

        const firstPlaceholder = firstRoot.querySelector<HTMLElement>('[data-inlay-id]')!
        intersectionCallbacks[0]([
            { isIntersecting: true, target: firstPlaceholder } as unknown as IntersectionObserverEntry,
        ], {} as IntersectionObserver)

        await vi.waitFor(() => expect(firstRoot.querySelector('img')).not.toBeNull())
        const detachedImage = firstRoot.querySelector('img')!
        firstRoot.remove()

        const remountedHTML = parseInlayAssets(token)
        expect(remountedHTML).toContain('data-inlay-image-id')

        const secondRoot = document.createElement('div')
        const sanitizedHTML = trimMarkdown(remountedHTML)
        expect(sanitizedHTML).toContain('data-inlay-image-id')
        secondRoot.innerHTML = sanitizedHTML
        document.body.appendChild(secondRoot)
        resolveInlayPlaceholders(secondRoot)
        resolveInfo({
            [id]: { height: 360, type: 'image', width: 1080 },
        })

        await vi.waitFor(() => {
            const image = secondRoot.querySelector('img')!
            expect(image.getAttribute('width')).toBe('1080')
            expect(image.getAttribute('height')).toBe('360')
            expect(image.hasAttribute('data-inlay-image-id')).toBe(false)
        })

        expect(detachedImage.hasAttribute('width')).toBe(false)
        expect(getInlayInfosBatchMock).toHaveBeenCalledTimes(1)
        expect(parseInlayAssets(token)).toContain('width="1080" height="360"')
    })

    test('does not apply late dimensions after images are hidden', async () => {
        const id = `hidden-${crypto.randomUUID()}`
        let resolveInfo!: (value: Record<string, {
            height: number
            type: 'image'
            width: number
        }>) => void

        getInlayInfosBatchMock.mockReturnValueOnce(new Promise((resolve) => {
            resolveInfo = resolve
        }))

        const root = document.createElement('div')
        root.innerHTML = parseInlayAssets(`{{inlay::${id}}}`)
        document.body.appendChild(root)
        resolveInlayPlaceholders(root)

        const placeholder = root.querySelector<HTMLElement>('[data-inlay-id]')!
        intersectionCallbacks[0]([
            { isIntersecting: true, target: placeholder } as unknown as IntersectionObserverEntry,
        ], {} as IntersectionObserver)

        await vi.waitFor(() => expect(root.querySelector('img')).not.toBeNull())
        const image = root.querySelector('img')!
        DBState.db.hideAllImages = true
        resolveInfo({
            [id]: { height: 360, type: 'image', width: 1080 },
        })
        await Promise.resolve()
        await Promise.resolve()

        expect(image.hasAttribute('width')).toBe(false)
        expect(image.hasAttribute('height')).toBe(false)
    })
})

import { describe, expect, test } from 'vitest'
import { findSafeBlockBoundary, getCommonPrefixLength } from './incrementalHtml'

// Every boundary the function hands back is used as a hard split: the prefix is
// rendered by its own `{@html}` block and never re-rendered. So the invariant
// that matters is "the prefix is balanced on its own", which this checks
// structurally rather than by pinning exact offsets.
function isBalanced(fragment: string): boolean {
    const void_ = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
    const stack: string[] = []
    const withoutComments = fragment.replace(/<!--[\s\S]*?-->/g, '')
    const withoutRawText = withoutComments.replace(/<(script|style|textarea|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    for (const m of withoutRawText.matchAll(/<(\/?)([a-zA-Z][^\s/>]*)([^>]*)>/g)) {
        const name = m[2].toLowerCase()
        if (void_.has(name) || m[3].trimEnd().endsWith('/')) continue
        if (m[1] === '/') {
            if (stack.pop() !== name) return false
        } else {
            stack.push(name)
        }
    }
    return stack.length === 0
}

describe('getCommonPrefixLength', () => {
    test('counts the shared leading run', () => {
        expect(getCommonPrefixLength('<p>abc</p>', '<p>abcd</p>')).toBe(6)
        expect(getCommonPrefixLength('', 'x')).toBe(0)
        expect(getCommonPrefixLength('same', 'same')).toBe(4)
    })
})

describe('findSafeBlockBoundary', () => {
    test('commits whole top-level blocks', () => {
        const html = '<p>one</p><p>two</p><p>thr'
        const boundary = findSafeBlockBoundary(html, html.length)
        expect(boundary).toBe('<p>one</p><p>two</p>'.length)
        expect(isBalanced(html.slice(0, boundary))).toBe(true)
    })

    test('never splits inside a wrapper element', () => {
        // The regression: the old boundary scan matched any block close tag, so
        // it cut after the inner </p> and orphaned the rest of the <div>.
        const html = '<div class="card"><p>one</p><p>two</p></div><p>next</p>'
        const boundary = findSafeBlockBoundary(html, html.length)
        expect(boundary).toBe('<div class="card"><p>one</p><p>two</p></div><p>next</p>'.length)
        expect(isBalanced(html.slice(0, boundary))).toBe(true)
    })

    test('commits nothing while the only wrapper is still open', () => {
        const html = '<div class="card"><p>one</p><p>tw'
        expect(findSafeBlockBoundary(html, html.length)).toBe(0)
    })

    test('respects the stable-prefix limit', () => {
        const html = '<p>one</p><p>two</p>'
        const boundary = findSafeBlockBoundary(html, '<p>one</p><p>tw'.length)
        expect(boundary).toBe('<p>one</p>'.length)
        expect(isBalanced(html.slice(0, boundary))).toBe(true)
    })

    test('treats void and self-closing tags as depth-neutral', () => {
        const html = '<hr><br/><img src="a.png"><p>after</p><p>partial'
        const boundary = findSafeBlockBoundary(html, html.length)
        expect(boundary).toBe('<hr><br/><img src="a.png"><p>after</p>'.length)
        expect(isBalanced(html.slice(0, boundary))).toBe(true)
    })

    test('does not read markup out of raw-text element bodies', () => {
        const html = '<style>.a::after{content:"<div>"}</style><p>after</p><p>x'
        const boundary = findSafeBlockBoundary(html, html.length)
        expect(boundary).toBe('<style>.a::after{content:"<div>"}</style><p>after</p>'.length)
        expect(isBalanced(html.slice(0, boundary))).toBe(true)
    })

    test('does not read markup out of comments', () => {
        const html = '<!-- <div> --><p>after</p><p>x'
        const boundary = findSafeBlockBoundary(html, html.length)
        expect(boundary).toBe('<!-- <div> --><p>after</p>'.length)
        expect(isBalanced(html.slice(0, boundary))).toBe(true)
    })

    test('stops at a stray closing tag instead of going negative', () => {
        const html = '<p>one</p></div><p>two</p>'
        const boundary = findSafeBlockBoundary(html, html.length)
        expect(boundary).toBe('<p>one</p>'.length)
        expect(isBalanced(html.slice(0, boundary))).toBe(true)
    })

    test('handles deep nesting and code blocks', () => {
        const html = '<blockquote><ul><li><pre><code>&lt;div&gt;</code></pre></li></ul></blockquote><p>tail'
        const boundary = findSafeBlockBoundary(html, html.length)
        expect(boundary).toBe('<blockquote><ul><li><pre><code>&lt;div&gt;</code></pre></li></ul></blockquote>'.length)
        expect(isBalanced(html.slice(0, boundary))).toBe(true)
    })

    test('returns 0 for empty or non-positive limits', () => {
        expect(findSafeBlockBoundary('<p>a</p>', 0)).toBe(0)
        expect(findSafeBlockBoundary('<p>a</p>', -5)).toBe(0)
        expect(findSafeBlockBoundary('', 10)).toBe(0)
    })

    test('every boundary over a growing stream keeps the prefix balanced', () => {
        const full = '<div class="w"><p>alpha</p><blockquote><p>beta</p></blockquote></div><hr><p>gamma</p><ul><li>a</li><li>b</li></ul>'
        let previous = ''
        let committed = ''
        for (let length = 1; length <= full.length; length++) {
            const html = full.slice(0, length)
            const limit = getCommonPrefixLength(previous, html)
            const boundary = findSafeBlockBoundary(html, limit)
            // Boundaries must be monotonic: already-committed HTML is never re-emitted.
            expect(boundary).toBeGreaterThanOrEqual(committed.length)
            committed = html.slice(0, boundary)
            expect(isBalanced(committed)).toBe(true)
            expect(full.startsWith(committed)).toBe(true)
            previous = html
        }
    })
})

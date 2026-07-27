// Incremental commit boundary for streamed message HTML.
//
// ChatBody re-parses the WHOLE message on every streaming tick, then splits the
// resulting HTML into an already-committed prefix (rendered once, never touched
// again) plus a live tail. Splitting is only safe at a point where the prefix is
// a self-contained fragment: each committed chunk is handed to its own `{@html}`
// block, so a chunk that ends inside an open element gets auto-closed by the
// browser and the remainder lands in a SIBLING subtree. For markdown that wraps
// blocks (`<div class="x"><p>a</p><p>b</p></div>` — common with custom chat
// HTML/CSS) that permanently breaks the message's structure and styling, during
// the stream and after it ends.
//
// So the boundary must be at element depth 0. `findSafeBlockBoundary` scans the
// stable prefix once, tracking open elements, and returns the furthest offset
// that closes back to depth 0. Returning 0 (nothing safely committable yet) is
// always correct — the caller just renders the whole thing as the live tail.

// Elements that never have a closing tag; they must not increment depth.
const VOID_ELEMENTS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr',
])

// Elements whose content is raw text, so `<` inside them is not markup and must
// not be scanned for tags (a `<` in a code block would otherwise desync depth).
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title'])

// Comments first, so `<!-- <div> -->` can't be mistaken for an open tag.
const NODE_PATTERN = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][^\s/>]*)([^>]*)>/g

/**
 * Largest offset `<= limit` at which `html` can be cut so the prefix contains
 * only balanced, top-level elements. Returns 0 when no such point exists.
 */
export function findSafeBlockBoundary(html: string, limit: number): number {
    if (limit <= 0) return 0

    const stablePart = html.slice(0, limit)
    const lowerPart = stablePart.toLowerCase()
    let boundary = 0
    let depth = 0

    NODE_PATTERN.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = NODE_PATTERN.exec(stablePart)) !== null) {
        const end = match.index + match[0].length

        // Comment: inert, but only a safe cut point at top level.
        if (match[2] === undefined) {
            if (depth === 0) boundary = end
            continue
        }

        const isClosing = match[1] === '/'
        const name = match[2].toLowerCase()

        if (isClosing) {
            // A stray close tag (depth already 0) means the prefix isn't a
            // fragment we understand; refuse to commit anything past it.
            if (depth === 0) return boundary
            depth--
            if (depth === 0) boundary = end
            continue
        }

        if (VOID_ELEMENTS.has(name) || match[3].trimEnd().endsWith('/')) {
            if (depth === 0) boundary = end
            continue
        }

        if (RAW_TEXT_ELEMENTS.has(name)) {
            const closeAt = lowerPart.indexOf(`</${name}`, end)
            if (closeAt === -1) return boundary
            const closeEnd = stablePart.indexOf('>', closeAt)
            if (closeEnd === -1) return boundary
            NODE_PATTERN.lastIndex = closeEnd + 1
            if (depth === 0) boundary = closeEnd + 1
            continue
        }

        depth++
    }

    return boundary
}

/** Length of the shared leading run of two strings. */
export function getCommonPrefixLength(left: string, right: string): number {
    const max = Math.min(left.length, right.length)
    let index = 0
    while (index < max && left.charCodeAt(index) === right.charCodeAt(index)) {
        index++
    }
    return index
}

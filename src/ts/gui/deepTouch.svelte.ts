/**
 * Subscribe an effect to every reactive dependency of a $state value WITHOUT
 * allocating a clone.
 *
 * The save-tracking effects use `$state.snapshot(x)` purely to establish a deep
 * reactive dependency — the returned clone is discarded. For a large value
 * (a character with a big lorebook, the whole modules array) that clone is the
 * dominant per-keystroke cost: it scales with the data size while the
 * dependency read does not. `deepTouch` reads the same things (which is what
 * registers the dependency) but builds nothing.
 *
 * It MUST subscribe to exactly what `$state.snapshot` subscribes to, or a change
 * could be missed and a save never triggered. To guarantee that:
 *  - Plain objects → own enumerable keys via `Object.keys` (NOT `for..in`, which
 *    would also read inherited getters that snapshot never touches and that
 *    could throw).
 *  - Arrays → `.length` (so push/pop/splice are tracked) then each index.
 *  - Anything non-plain (class instance, Date, Map/Set, an object with a
 *    `toJSON()` that reads reactive state, …) → defer to `$state.snapshot`,
 *    which establishes the EXACT same dependency it would in production
 *    (including the toJSON read). These are rare — only odd `pluginCustomStorage`
 *    values reach here; all normal DB data is plain objects/arrays/primitives,
 *    which take the clone-free fast path.
 *
 * `deepTouch.svelte.test.ts` pins the equivalence by running `deepTouch` and
 * `$state.snapshot` side-by-side across mutation kinds (incl. toJSON and an
 * inherited throwing getter).
 *
 * The WeakSet only guards plain-object recursion against cycles in non-proxy
 * data (tests / fallback inputs). Production DB data is acyclic — it is
 * JSON-serialised to save — so cycles do not occur there.
 */
function isPlainObject(value: object): boolean {
    const proto = Object.getPrototypeOf(value)
    return proto === Object.prototype || proto === null
}

export function deepTouch(value: any, seen?: WeakSet<object>): void {
    if (value === null || typeof value !== 'object') return
    if (!seen) seen = new WeakSet()
    if (seen.has(value)) return
    seen.add(value)
    if (Array.isArray(value)) {
        const len = value.length
        for (let i = 0; i < len; i++) deepTouch(value[i], seen)
    } else if (isPlainObject(value)) {
        for (const key of Object.keys(value)) deepTouch(value[key], seen)
    } else {
        $state.snapshot(value)
    }
}

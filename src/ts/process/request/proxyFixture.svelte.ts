// Test-only helpers compiled by the Svelte plugin so runes are available.
// They let tests reproduce the browser runtime's raw-vs-proxy write semantics
// (a plain-object fixture cannot fail the way the field does).

/** Wrap a plain object in a REAL Svelte 5 $state proxy. */
export function makeStateProxy<T extends object>(value: T): T {
    const proxied = $state(value)
    return proxied
}

/** Reactive observer — stands in for the UI and the save change-tracker.
 *  `read()` is tracked inside a real $effect: writes that go through the
 *  proxy re-run it; raw-object writes never do (the field failure mode). */
export function observeReactive<T>(read: () => T): { readonly current: T, readonly runs: number, stop: () => void } {
    let current = $state.raw(undefined as T)
    let runs = 0
    const stop = $effect.root(() => {
        $effect(() => {
            current = read()
            runs++
        })
    })
    return {
        get current() { return current },
        get runs() { return runs },
        stop,
    }
}

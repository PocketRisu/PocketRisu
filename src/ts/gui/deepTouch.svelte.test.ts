import { describe, test, expect } from 'vitest'
import { flushSync } from 'svelte'
import { deepTouch } from './deepTouch.svelte'

// Non-plain object whose toJSON() reads reactive state through a closure (not an
// own enumerable field), used by the P2 #1 regression below. Declared at module
// scope to avoid Svelte's nested-class perf warning.
class Mirror {
    constructor(private read: () => unknown) {}
    toJSON() { return { mirrored: this.read() } }
}

// Verify deepTouch establishes the SAME reactive subscription as $state.snapshot
// across every mutation kind. The dangerous direction is deepTouch firing FEWER
// times than snapshot (a missed dependency → a save that never triggers → data
// loss). We run both subscribers over a shared $state and assert their re-run
// counts stay equal step by step.
//
// snapshotEvery() forces $state.snapshot to actually read everything (it returns
// a discarded clone, same as production usage).

function run(mutations: Array<(s: any) => void>) {
    const state = $state({
        scalar: 1,
        nested: { a: { b: 1 }, c: 'x' },
        list: [{ v: 1 }, { v: 2 }],
        dict: { k1: 1 } as Record<string, any>,
    })

    let touchRuns = 0
    let snapRuns = 0
    const stop = $effect.root(() => {
        $effect(() => { deepTouch(state); touchRuns++ })
        $effect(() => { $state.snapshot(state); snapRuns++ })
    })
    flushSync()
    expect(touchRuns).toBe(1)
    expect(snapRuns).toBe(1)

    const steps: Array<{ touch: number; snap: number }> = []
    for (const m of mutations) {
        m(state)
        flushSync()
        steps.push({ touch: touchRuns, snap: snapRuns })
    }
    stop()
    return steps
}

describe('deepTouch subscribes identically to $state.snapshot', () => {
    test('deep value change fires both', () => {
        const s = run([(x) => { x.nested.a.b = 99 }])
        expect(s[0].touch).toBe(s[0].snap)
        expect(s[0].touch).toBe(2) // re-ran once
    })

    test('array push (length grow) fires both', () => {
        const s = run([(x) => { x.list.push({ v: 3 }) }])
        expect(s[0].touch).toBe(s[0].snap)
        expect(s[0].touch).toBeGreaterThan(1)
    })

    test('array element field change fires both', () => {
        const s = run([(x) => { x.list[0].v = 42 }])
        expect(s[0].touch).toBe(s[0].snap)
    })

    test('array splice (shrink) fires both', () => {
        const s = run([(x) => { x.list.splice(0, 1) }])
        expect(s[0].touch).toBe(s[0].snap)
    })

    test('object key ADD fires both (the subtle ownKeys case)', () => {
        const s = run([(x) => { x.dict.k2 = 5 }])
        expect(s[0].touch).toBe(s[0].snap)
        expect(s[0].touch).toBeGreaterThan(1)
    })

    test('object key DELETE fires both', () => {
        const s = run([(x) => { delete x.dict.k1 }])
        expect(s[0].touch).toBe(s[0].snap)
        expect(s[0].touch).toBeGreaterThan(1)
    })

    test('scalar change fires both', () => {
        const s = run([(x) => { x.scalar = 2 }])
        expect(s[0].touch).toBe(s[0].snap)
    })

    test('a sequence of mixed mutations keeps run-counts in lockstep', () => {
        const steps = run([
            (x) => { x.nested.c = 'y' },
            (x) => { x.list.push({ v: 9 }) },
            (x) => { x.dict.added = true },
            (x) => { x.nested.a.b = 7 },
            (x) => { delete x.dict.k1 },
            (x) => { x.list[1].v = 100 },
        ])
        for (const st of steps) expect(st.touch).toBe(st.snap)
    })

    test('no spurious extra runs: unrelated no-op re-assign of same value', () => {
        const steps = run([
            (x) => { x.scalar = x.scalar }, // same value — neither should fire
        ])
        expect(steps[0].touch).toBe(steps[0].snap)
    })
})

describe('deepTouch — non-plain / inherited edge cases (P2 regressions)', () => {
    // #1: a non-plain object whose toJSON() reads reactive state not reachable
    // by an own-enumerable walk. $state.snapshot calls toJSON (subscribing); the
    // old for..in deepTouch missed it (fired fewer times → missed save). The fix
    // defers non-plain values to $state.snapshot, so they must stay in lockstep.
    test('non-plain toJSON() reading reactive state fires deepTouch and snapshot equally', () => {
        const side = $state({ v: 1 })
        const state = $state({ box: new Mirror(() => side.v) })

        let touchRuns = 0
        let snapRuns = 0
        const stop = $effect.root(() => {
            $effect(() => { deepTouch(state); touchRuns++ })
            $effect(() => { $state.snapshot(state); snapRuns++ })
        })
        flushSync()
        const before = { t: touchRuns, s: snapRuns }

        side.v = 2 // change a value only toJSON() reaches
        flushSync()

        // Both must have re-run the same number of times (the invariant: deepTouch
        // never fires FEWER than snapshot).
        expect(touchRuns - before.t).toBe(snapRuns - before.s)
        stop()
    })

    // #2: an inherited enumerable getter that throws. for..in would read it and
    // throw (breaking the un-guarded plugins/pluginCustomStorage effects);
    // Object.keys (own only) — like snapshot — never reads it.
    test('inherited throwing getter does not make deepTouch throw', () => {
        const proto: any = {}
        Object.defineProperty(proto, 'boom', {
            get() { throw new Error('inherited getter should not be read') },
            enumerable: true,
        })
        const obj = Object.create(proto)
        obj.safe = { v: 1 }
        const state = $state({ storage: obj as any })

        let threw = false
        const stop = $effect.root(() => {
            $effect(() => {
                try { deepTouch(state) } catch { threw = true }
            })
        })
        flushSync()
        stop()
        expect(threw).toBe(false)
    })
})

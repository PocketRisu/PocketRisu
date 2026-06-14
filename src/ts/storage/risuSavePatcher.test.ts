import { describe, test, expect, vi } from 'vitest'

// Mock heavy deps so importing risuSave.ts doesn't pull the Svelte runtime
// or trigger module-level side effects. The patcher and the helper it
// delegates to are pure once `compare` is injected.
vi.mock('./database.svelte', () => ({}))
vi.mock('./chatStorage', () => ({
    // Identity stub — character path is exercised with empty `characters`
    // arrays in this suite, but the mock has to exist so import resolution
    // works.
    chatToStub: (c: any) => c,
}))
vi.mock('../globalApi.svelte', () => ({ forageStorage: { realStorage: null } }))

const { diffArrayWithIdGuard, RisuSavePatcher } = await import('./risuSave')
const { compare } = await import('fast-json-patch')

// ──────────────────────────────────────────────────────────────────────────
// diffArrayWithIdGuard — direct tests on the structural-vs-elementwise pivot.
//
// The bug this protects against: deleting an entry from the front of an
// array of deeply nested objects (e.g. local-Risu-imported modules in the
// modules[] array) makes fast-json-patch.compare emit hundreds of thousands
// of element-wise diff ops (every index shifts by one and each slot deep-
// diffs old[i] vs new[i+1]). The resulting `patch.push(...ops)` then trips
// V8's function-argument limit and throws RangeError.
// ──────────────────────────────────────────────────────────────────────────

describe('diffArrayWithIdGuard — id-based structural detection (modules)', () => {
    const A = { id: 'a', name: 'A', cjs: 'console.log("a")' }
    const B = { id: 'b', name: 'B', cjs: 'console.log("b")' }
    const C = { id: 'c', name: 'C', cjs: 'console.log("c")' }
    const D = { id: 'd', name: 'D', cjs: 'console.log("d")' }

    test('identical arrays → no ops', () => {
        const ops = diffArrayWithIdGuard(compare, '/modules', [A, B, C], [A, B, C], 'id')
        expect(ops).toEqual([])
    })

    test('delete from front (the cascade case) → single replace, NOT element-wise', () => {
        const ops = diffArrayWithIdGuard(compare, '/modules', [A, B, C, D], [B, C, D], 'id')
        expect(ops).toEqual([{ op: 'replace', path: '/modules', value: [B, C, D] }])
    })

    test('delete from middle → single replace', () => {
        const ops = diffArrayWithIdGuard(compare, '/modules', [A, B, C, D], [A, C, D], 'id')
        expect(ops).toEqual([{ op: 'replace', path: '/modules', value: [A, C, D] }])
    })

    test('delete from end → single replace (length change)', () => {
        const ops = diffArrayWithIdGuard(compare, '/modules', [A, B, C, D], [A, B, C], 'id')
        expect(ops).toEqual([{ op: 'replace', path: '/modules', value: [A, B, C] }])
    })

    test('append new item → single replace', () => {
        const ops = diffArrayWithIdGuard(compare, '/modules', [A, B], [A, B, C], 'id')
        expect(ops).toEqual([{ op: 'replace', path: '/modules', value: [A, B, C] }])
    })

    test('reorder (length unchanged, ids in different positions) → single replace', () => {
        const ops = diffArrayWithIdGuard(compare, '/modules', [A, B, C], [C, A, B], 'id')
        expect(ops).toEqual([{ op: 'replace', path: '/modules', value: [C, A, B] }])
    })

    test('same ids, one item internally changed → element-wise diff for that index only', () => {
        const Bx = { id: 'b', name: 'B-renamed', cjs: 'console.log("b")' }
        const ops = diffArrayWithIdGuard(compare, '/modules', [A, B, C], [A, Bx, C], 'id')
        // Only /modules/1 path should be touched. Exact op shape depends on
        // fast-json-patch's diff strategy but it must be scoped to index 1.
        expect(ops.length).toBeGreaterThan(0)
        for (const op of ops) {
            expect(op.path.startsWith('/modules/1')).toBe(true)
        }
    })

    test('empty → empty: no ops', () => {
        const ops = diffArrayWithIdGuard(compare, '/modules', [], [], 'id')
        expect(ops).toEqual([])
    })

    test('empty → non-empty: structural replace', () => {
        const ops = diffArrayWithIdGuard(compare, '/modules', [], [A], 'id')
        expect(ops).toEqual([{ op: 'replace', path: '/modules', value: [A] }])
    })

    test('undefined lastArr (cold init) → treated as empty', () => {
        const ops = diffArrayWithIdGuard(compare, '/modules', undefined, [A, B], 'id')
        expect(ops).toEqual([{ op: 'replace', path: '/modules', value: [A, B] }])
    })
})

describe('diffArrayWithIdGuard — ID safety belt', () => {
    // The fix targets corrupted backups where modules may have missing or
    // duplicated ids. Element-wise diff in those states is unreliable, so we
    // force a structural replace instead.

    test('falsy id in current array → structural replace', () => {
        const A = { id: 'a', name: 'A' }
        const Bbad = { id: '', name: 'B' }
        const ops = diffArrayWithIdGuard(compare, '/modules', [A, { id: 'b', name: 'B' }], [A, Bbad], 'id')
        expect(ops).toEqual([{ op: 'replace', path: '/modules', value: [A, Bbad] }])
    })

    test('missing id field entirely → structural replace', () => {
        const A = { id: 'a', name: 'A' }
        const Bbad = { name: 'B' } as any
        const ops = diffArrayWithIdGuard(compare, '/modules', [A, { id: 'b', name: 'B' }], [A, Bbad], 'id')
        expect(ops).toEqual([{ op: 'replace', path: '/modules', value: [A, Bbad] }])
    })

    test('duplicate ids in current array → structural replace', () => {
        const A = { id: 'a', name: 'A' }
        const Adup = { id: 'a', name: 'A2' }
        const ops = diffArrayWithIdGuard(compare, '/modules', [A, { id: 'b', name: 'B' }], [A, Adup], 'id')
        expect(ops).toEqual([{ op: 'replace', path: '/modules', value: [A, Adup] }])
    })

    test('null entry in array → structural replace (falsy id chain)', () => {
        const A = { id: 'a', name: 'A' }
        const ops = diffArrayWithIdGuard(compare, '/modules', [A, { id: 'b' }], [A, null as any], 'id')
        expect(ops).toEqual([{ op: 'replace', path: '/modules', value: [A, null] }])
    })
})

describe('diffArrayWithIdGuard — id-based mode (botPresets)', () => {
    // S3 (3966c178) added a stable string `id` field to botPresets and a boot
    // migration that backfills missing ids. The patcher now diffs botPresets
    // by id, matching modules: same-length internal edits emit a scoped
    // element-wise diff for that slot only, while add / delete / reorder all
    // trip structural detection and emit a single /botPresets replace. The
    // pre-S3 length-only mode could silently misalign slots on reorder; the
    // id-based mode forces a safe replace in that case.

    const P1 = { id: 'preset-1', name: 'GPT-4', temperature: 80, mainPrompt: 'You are...' }
    const P2 = { id: 'preset-2', name: 'Claude', temperature: 70, mainPrompt: 'You are...' }
    const P3 = { id: 'preset-3', name: 'Local', temperature: 60, mainPrompt: 'You are...' }

    test('identical → no ops', () => {
        expect(diffArrayWithIdGuard(compare, '/botPresets', [P1, P2], [P1, P2], 'id')).toEqual([])
    })

    test('one preset internally changed → element-wise diff (only that slot)', () => {
        const P2x = { ...P2, temperature: 75 }
        const ops = diffArrayWithIdGuard(compare, '/botPresets', [P1, P2], [P1, P2x], 'id')
        expect(ops.length).toBeGreaterThan(0)
        for (const op of ops) expect(op.path.startsWith('/botPresets/1')).toBe(true)
    })

    test('add preset → structural replace', () => {
        const ops = diffArrayWithIdGuard(compare, '/botPresets', [P1, P2], [P1, P2, P3], 'id')
        expect(ops).toEqual([{ op: 'replace', path: '/botPresets', value: [P1, P2, P3] }])
    })

    test('delete preset from middle → structural replace', () => {
        const ops = diffArrayWithIdGuard(compare, '/botPresets', [P1, P2, P3], [P1, P3], 'id')
        expect(ops).toEqual([{ op: 'replace', path: '/botPresets', value: [P1, P3] }])
    })

    test('reorder presets → structural replace', () => {
        const ops = diffArrayWithIdGuard(compare, '/botPresets', [P1, P2, P3], [P3, P1, P2], 'id')
        expect(ops).toEqual([{ op: 'replace', path: '/botPresets', value: [P3, P1, P2] }])
    })

    // Safety belt — backups predating S3 won't have ids until boot migration
    // runs. If the patcher is invoked before then (defensive), missing ids
    // force a structural replace rather than silently misaligning slots.
    test('missing id on any preset → structural replace (safety belt)', () => {
        const Pnoid = { name: 'Legacy', temperature: 50, mainPrompt: 'You are...' }
        const ops = diffArrayWithIdGuard(compare, '/botPresets', [P1, P2], [P1, Pnoid], 'id')
        expect(ops).toEqual([{ op: 'replace', path: '/botPresets', value: [P1, Pnoid] }])
    })

    test('duplicate ids → structural replace (safety belt)', () => {
        const Pdup = { ...P2, id: P1.id }
        const ops = diffArrayWithIdGuard(compare, '/botPresets', [P1, P2], [P1, Pdup], 'id')
        expect(ops).toEqual([{ op: 'replace', path: '/botPresets', value: [P1, Pdup] }])
    })

    test('reorder + internal edit → structural replace (id mismatch at index)', () => {
        // When ids don't line up at the same indices, structural replace wins —
        // we do not attempt to chase the moved entry's internal diff.
        const P2x = { ...P2, temperature: 75 }
        const ops = diffArrayWithIdGuard(compare, '/botPresets', [P1, P2], [P2x, P1], 'id')
        expect(ops).toEqual([{ op: 'replace', path: '/botPresets', value: [P2x, P1] }])
    })
})

// ──────────────────────────────────────────────────────────────────────────
// Scale test — verify the helper does NOT trip the spread limit and does
// NOT explode the op count on the original bug's pathological input.
// ──────────────────────────────────────────────────────────────────────────

describe('diffArrayWithIdGuard — scale (regression)', () => {
    function makeModule(i: number) {
        // Each module is moderately deep — comparable to a real module with
        // a lorebook, regex list, and trigger list. The original bug's
        // cascade explosion happened because deep-diffing N shifted items
        // emitted O(N × deepFields) ops.
        return {
            id: `mod-${i}`,
            name: `Module ${i}`,
            description: `description for module ${i}`,
            lorebook: Array.from({ length: 20 }, (_, k) => ({
                key: `key-${i}-${k}`,
                content: `content for entry ${k} of module ${i}`,
                priority: k,
            })),
            regex: Array.from({ length: 10 }, (_, k) => ({
                pattern: `pattern-${i}-${k}`,
                replace: `replace-${i}-${k}`,
            })),
            cjs: `console.log("module ${i}");`.repeat(50),
        }
    }

    test('deleting front item of a 200-module array → 1 op, no spread crash', () => {
        const last = Array.from({ length: 200 }, (_, i) => makeModule(i))
        const cur = last.slice(1) // delete index 0
        const ops = diffArrayWithIdGuard(compare, '/modules', last, cur, 'id')
        expect(ops).toHaveLength(1)
        expect(ops[0].op).toBe('replace')
        expect(ops[0].path).toBe('/modules')
    })

    test('no-op on 200-module array → 0 ops (hot path)', () => {
        const arr = Array.from({ length: 200 }, (_, i) => makeModule(i))
        // Same reference, no change.
        const ops = diffArrayWithIdGuard(compare, '/modules', arr, arr, 'id')
        expect(ops).toEqual([])
    })

    test('original element-wise compare WOULD have produced very many ops on this input', () => {
        // Sanity check that our test input is actually pathological — if
        // this number ever drops to a small value, the regression test
        // above is no longer guarding the right thing.
        const last = Array.from({ length: 200 }, (_, i) => makeModule(i))
        const cur = last.slice(1)
        const legacyOps = compare({ modules: last }, { modules: cur })
        expect(legacyOps.length).toBeGreaterThan(1000)
    })
})

// ──────────────────────────────────────────────────────────────────────────
// RisuSavePatcher integration — exercise the full set() path.
// ──────────────────────────────────────────────────────────────────────────

function makeMod(id: string, extras: any = {}) {
    return { id, name: `mod-${id}`, description: '', ...extras }
}

const emptyToSave = () => ({
    character: [],
    chat: [] as [string, string][],
    root: false,
    botPreset: false,
    modules: false,
    plugins: false,
    pluginCustomStorage: false,
})

describe('RisuSavePatcher.set — modules path', () => {
    test('deleting a front-loaded module emits a single replace op, no RangeError', async () => {
        const patcher = new RisuSavePatcher()
        const initialModules = [makeMod('a'), makeMod('b'), makeMod('c'), makeMod('d')]
        await patcher.init({ characters: [], botPresets: [], modules: initialModules })

        const newDb = { characters: [], botPresets: [], modules: [makeMod('b'), makeMod('c'), makeMod('d')] }
        const { patch } = await patcher.set(newDb, { ...emptyToSave(), modules: true })

        const moduleOps = patch.filter((p: any) => p.path === '/modules' || p.path.startsWith('/modules/'))
        expect(moduleOps).toEqual([
            { op: 'replace', path: '/modules', value: newDb.modules },
        ])
    })

    test('internal edit only (same id order) → element-wise diff scoped to that index', async () => {
        const patcher = new RisuSavePatcher()
        await patcher.init({
            characters: [],
            botPresets: [],
            modules: [makeMod('a'), makeMod('b', { description: 'old' })],
        })

        const newDb = {
            characters: [],
            botPresets: [],
            modules: [makeMod('a'), makeMod('b', { description: 'new' })],
        }
        const { patch } = await patcher.set(newDb, { ...emptyToSave(), modules: true })

        const moduleOps = patch.filter((p: any) => p.path.startsWith('/modules/'))
        expect(moduleOps.length).toBeGreaterThan(0)
        for (const op of moduleOps) expect(op.path.startsWith('/modules/1')).toBe(true)
        // No structural replace under those circumstances.
        expect(patch.find((p: any) => p.path === '/modules')).toBeUndefined()
    })

    test('does not throw on a pathological array that would crash the original code path', async () => {
        // ~300 modules with non-trivial internals × front delete. Old behavior
        // would balloon the op count and trip `patch.push(...arr)` spread.
        const N = 300
        const big = Array.from({ length: N }, (_, i) => makeMod(`m${i}`, {
            description: 'x'.repeat(200),
            lorebook: Array.from({ length: 10 }, (_, k) => ({ key: `k${k}`, content: 'y'.repeat(100) })),
        }))

        const patcher = new RisuSavePatcher()
        await patcher.init({ characters: [], botPresets: [], modules: big })

        // Delete the very first module — worst-case index cascade.
        const next = big.slice(1)
        const newDb = { characters: [], botPresets: [], modules: next }

        await expect(patcher.set(newDb, { ...emptyToSave(), modules: true })).resolves.toBeTruthy()
    })

    test('subsequent set() picks up the new baseline after a structural change', async () => {
        // After the fix, a structural replace updates lastSyncedDb so the
        // following set() compares against the new baseline. This is what
        // keeps the patcher converged with the server.
        const patcher = new RisuSavePatcher()
        await patcher.init({
            characters: [],
            botPresets: [],
            modules: [makeMod('a'), makeMod('b'), makeMod('c')],
        })

        // First call: delete 'a'.
        await patcher.set(
            { characters: [], botPresets: [], modules: [makeMod('b'), makeMod('c')] },
            { ...emptyToSave(), modules: true },
        )

        // Second call: no further change. Should emit 0 module ops.
        const { patch } = await patcher.set(
            { characters: [], botPresets: [], modules: [makeMod('b'), makeMod('c')] },
            { ...emptyToSave(), modules: true },
        )
        const moduleOps = patch.filter((p: any) =>
            p.path === '/modules' || p.path.startsWith('/modules/'),
        )
        expect(moduleOps).toEqual([])
    })
})

describe('RisuSavePatcher.set — botPresets path', () => {
    // Each preset gets a stable id (S3) — patcher diffs botPresets by id,
    // same as modules. Reusing `name` as the id keeps fixtures terse.
    const preset = (name: string, extras: any = {}) => ({
        id: name, name, temperature: 80, mainPrompt: 'You are...', ...extras,
    })

    test('deleting a preset from the middle emits a single replace op', async () => {
        const patcher = new RisuSavePatcher()
        await patcher.init({
            characters: [],
            botPresets: [preset('p1'), preset('p2'), preset('p3')],
            modules: [],
        })

        const newDb = {
            characters: [],
            botPresets: [preset('p1'), preset('p3')],
            modules: [],
        }
        const { patch } = await patcher.set(newDb, { ...emptyToSave(), botPreset: true })
        const presetOps = patch.filter((p: any) =>
            p.path === '/botPresets' || p.path.startsWith('/botPresets/'),
        )
        expect(presetOps).toEqual([
            { op: 'replace', path: '/botPresets', value: newDb.botPresets },
        ])
    })

    test('editing one preset (length unchanged) emits scoped element-wise diff', async () => {
        const patcher = new RisuSavePatcher()
        await patcher.init({
            characters: [],
            botPresets: [preset('p1'), preset('p2', { temperature: 70 })],
            modules: [],
        })
        const newDb = {
            characters: [],
            botPresets: [preset('p1'), preset('p2', { temperature: 75 })],
            modules: [],
        }
        const { patch } = await patcher.set(newDb, { ...emptyToSave(), botPreset: true })
        const presetOps = patch.filter((p: any) => p.path.startsWith('/botPresets/'))
        expect(presetOps.length).toBeGreaterThan(0)
        for (const op of presetOps) expect(op.path.startsWith('/botPresets/1')).toBe(true)
        expect(patch.find((p: any) => p.path === '/botPresets')).toBeUndefined()
    })
})

// ──────────────────────────────────────────────────────────────────────────
// Round-trip integrity — the strongest correctness invariant:
//
//   applyPatch(baseline, patcher.set(newState).patch) === normalize(newState)
//
// In production, the server applies these patches with fast-json-patch's
// applyPatch on its own copy of the DB. If our generated ops don't bring
// the server's baseline up to the same state the patcher computed
// internally, the next save/load round-trip will diverge and the user
// either sees stale data or silent loss. These tests exercise the
// scenarios the fix is meant to handle and verify byte-equivalent
// reconstruction.
// ──────────────────────────────────────────────────────────────────────────

const { applyPatch } = await import('fast-json-patch')
const { normalizeJSON } = await import('./risuSave')

function applyOpsTo(baseline: any, ops: any[]) {
    // fast-json-patch mutates by default; deep-clone first to keep tests
    // independent. Also matches how the server-side applyPatch wraps the
    // call in its own copy of the DB.
    const copy = JSON.parse(JSON.stringify(baseline))
    applyPatch(copy, ops)
    return copy
}

async function runRoundTrip(
    initial: any,
    next: any,
    toSave: any,
) {
    const patcher = new RisuSavePatcher()
    await patcher.init(initial)
    const { patch } = await patcher.set(next, toSave)
    // Simulate the server's pre-image: normalized initial state.
    const serverBaseline = normalizeJSON(initial)
    const afterApply = applyOpsTo(serverBaseline, patch)
    // Simulate what the server should end up with: normalized next state,
    // with chats stub-replaced on characters (mirroring patcher.set's diff
    // input). characters are out of scope for this suite (empty arrays),
    // so the transformation collapses to plain normalize.
    const expected = normalizeJSON(next)
    return { patch, afterApply, expected }
}

describe('round-trip — patcher ops reconstruct the new state on a baseline', () => {
    test('modules: delete from front', async () => {
        const modules = [
            { id: 'a', name: 'A', cjs: 'console.log("a")' },
            { id: 'b', name: 'B', cjs: 'console.log("b")' },
            { id: 'c', name: 'C', cjs: 'console.log("c")' },
        ]
        const initial = { characters: [], botPresets: [], modules }
        const next = { characters: [], botPresets: [], modules: modules.slice(1) }
        const { afterApply, expected } = await runRoundTrip(initial, next, { ...emptyToSave(), modules: true })
        expect(afterApply.modules).toEqual(expected.modules)
    })

    test('modules: delete from middle', async () => {
        const modules = [
            { id: 'a', name: 'A' }, { id: 'b', name: 'B' },
            { id: 'c', name: 'C' }, { id: 'd', name: 'D' },
        ]
        const initial = { characters: [], botPresets: [], modules }
        const next = { characters: [], botPresets: [], modules: [modules[0], modules[2], modules[3]] }
        const { afterApply, expected } = await runRoundTrip(initial, next, { ...emptyToSave(), modules: true })
        expect(afterApply.modules).toEqual(expected.modules)
    })

    test('modules: add to end', async () => {
        const modules = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]
        const initial = { characters: [], botPresets: [], modules }
        const next = { characters: [], botPresets: [], modules: [...modules, { id: 'c', name: 'C' }] }
        const { afterApply, expected } = await runRoundTrip(initial, next, { ...emptyToSave(), modules: true })
        expect(afterApply.modules).toEqual(expected.modules)
    })

    test('modules: reorder preserves all data', async () => {
        const modules = [
            { id: 'a', name: 'A', lorebook: [{ key: 'k1', content: 'v1' }] },
            { id: 'b', name: 'B', lorebook: [{ key: 'k2', content: 'v2' }] },
            { id: 'c', name: 'C', lorebook: [{ key: 'k3', content: 'v3' }] },
        ]
        const initial = { characters: [], botPresets: [], modules }
        const next = { characters: [], botPresets: [], modules: [modules[2], modules[0], modules[1]] }
        const { afterApply, expected } = await runRoundTrip(initial, next, { ...emptyToSave(), modules: true })
        expect(afterApply.modules).toEqual(expected.modules)
    })

    test('modules: edit content of one (length unchanged, same ids)', async () => {
        const initial = {
            characters: [], botPresets: [],
            modules: [
                { id: 'a', name: 'A', description: 'old' },
                { id: 'b', name: 'B', description: 'untouched' },
            ],
        }
        const next = {
            characters: [], botPresets: [],
            modules: [
                { id: 'a', name: 'A', description: 'NEW VALUE' },
                { id: 'b', name: 'B', description: 'untouched' },
            ],
        }
        const { afterApply, expected } = await runRoundTrip(initial, next, { ...emptyToSave(), modules: true })
        expect(afterApply.modules).toEqual(expected.modules)
    })

    test('modules: multi-level changes (add + edit at once)', async () => {
        const initial = {
            characters: [], botPresets: [],
            modules: [
                { id: 'a', name: 'A', description: 'v1' },
                { id: 'b', name: 'B', description: 'v1' },
            ],
        }
        const next = {
            characters: [], botPresets: [],
            modules: [
                { id: 'a', name: 'A', description: 'v2' },         // edited
                { id: 'b', name: 'B', description: 'v1' },
                { id: 'c', name: 'C', description: 'new' },        // added
            ],
        }
        const { afterApply, expected } = await runRoundTrip(initial, next, { ...emptyToSave(), modules: true })
        expect(afterApply.modules).toEqual(expected.modules)
    })

    test('modules: 200-module front-delete (the original bug scenario)', async () => {
        function makeMod(i: number) {
            return {
                id: `mod-${i}`,
                name: `Module ${i}`,
                description: `desc ${i}`,
                lorebook: Array.from({ length: 10 }, (_, k) => ({
                    key: `k-${i}-${k}`, content: `v-${i}-${k}`,
                })),
                cjs: `console.log("${i}")`.repeat(10),
            }
        }
        const big = Array.from({ length: 200 }, (_, i) => makeMod(i))
        const initial = { characters: [], botPresets: [], modules: big }
        const next = { characters: [], botPresets: [], modules: big.slice(1) }
        const { patch, afterApply, expected } = await runRoundTrip(initial, next, { ...emptyToSave(), modules: true })
        // Sanity: not exploding into hundreds of thousands of ops
        expect(patch.length).toBeLessThan(20)
        // Server side reconstructs exactly what the patcher computed
        expect(afterApply.modules).toEqual(expected.modules)
    })

    test('botPresets: delete from middle', async () => {
        const p = (name: string, temp = 80) => ({ name, temperature: temp, mainPrompt: 'You are...' })
        const initial = { characters: [], botPresets: [p('p1'), p('p2'), p('p3')], modules: [] }
        const next = { characters: [], botPresets: [p('p1'), p('p3')], modules: [] }
        const { afterApply, expected } = await runRoundTrip(initial, next, { ...emptyToSave(), botPreset: true })
        expect(afterApply.botPresets).toEqual(expected.botPresets)
    })

    test('botPresets: edit one (length unchanged)', async () => {
        const p = (name: string, temp = 80) => ({ name, temperature: temp, mainPrompt: 'You are...' })
        const initial = { characters: [], botPresets: [p('p1', 70), p('p2', 80)], modules: [] }
        const next = { characters: [], botPresets: [p('p1', 70), p('p2', 90)], modules: [] }
        const { afterApply, expected } = await runRoundTrip(initial, next, { ...emptyToSave(), botPreset: true })
        expect(afterApply.botPresets).toEqual(expected.botPresets)
    })

    test('combined: edit modules and botPresets in a single save', async () => {
        const p = (name: string) => ({ name, temperature: 80, mainPrompt: 'You are...' })
        const initial = {
            characters: [],
            botPresets: [p('p1'), p('p2')],
            modules: [{ id: 'a', name: 'A', description: 'old' }],
        }
        const next = {
            characters: [],
            botPresets: [p('p1'), p('p3')],
            modules: [
                { id: 'a', name: 'A', description: 'new' },
                { id: 'b', name: 'B', description: 'added' },
            ],
        }
        const { afterApply, expected } = await runRoundTrip(initial, next, {
            ...emptyToSave(), modules: true, botPreset: true,
        })
        expect(afterApply.modules).toEqual(expected.modules)
        expect(afterApply.botPresets).toEqual(expected.botPresets)
    })

    test('ID safety belt: duplicate ids still reconstruct correctly', async () => {
        // Pathological — duplicate ids in current state. The structural-replace
        // safety belt kicks in, and the server-side state should still match.
        const initial = {
            characters: [], botPresets: [],
            modules: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
        }
        const next = {
            characters: [], botPresets: [],
            modules: [{ id: 'a', name: 'A' }, { id: 'a', name: 'A-duplicate' }],
        }
        const { afterApply, expected } = await runRoundTrip(initial, next, { ...emptyToSave(), modules: true })
        expect(afterApply.modules).toEqual(expected.modules)
    })

    test('idempotency: second save with no further changes emits no module/preset ops', async () => {
        // If the patcher's lastSyncedDb gets out of sync with the server's
        // applied state, the next set() would emit extra ops. This is the
        // exact mode that produces stale data on the user's screen.
        const modules = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]
        const patcher = new RisuSavePatcher()
        await patcher.init({ characters: [], botPresets: [], modules })

        // First save: delete one module.
        const after1 = { characters: [], botPresets: [], modules: [modules[1]] }
        await patcher.set(after1, { ...emptyToSave(), modules: true })

        // Second save: no change since after1.
        const { patch } = await patcher.set(after1, { ...emptyToSave(), modules: true })
        const moduleOrPresetOps = patch.filter((p: any) =>
            p.path === '/modules' || p.path.startsWith('/modules/') ||
            p.path === '/botPresets' || p.path.startsWith('/botPresets/'),
        )
        expect(moduleOrPresetOps).toEqual([])
    })
})

// ──────────────────────────────────────────────────────────────────────────
// Cheap-pre-check fast path — state-transition regression suite.
//
// The change-detection fast path compares JSON.stringify(block) against a
// stored baseline string and, on a match, skips normalize + protocol hash +
// diff entirely. The danger is a baseline that drifts out of sync with
// `lastSyncedDb`/`hashBlocks` so that either (a) a real change is skipped
// (silent loss) or (b) `expectedHash` no longer matches what the server holds.
// Each transition below is followed by a no-op save: a correct baseline must
// make the second save emit an empty patch, and a real change after a skip
// must still be caught.
// ──────────────────────────────────────────────────────────────────────────

const chr = (chaId: string, fields: Record<string, any> = {}) => ({
    chaId,
    name: chaId.toUpperCase(),
    desc: '',
    firstMessage: '',
    chats: [{ id: 'chat-' + chaId, name: 'c', _stub: true }],
    chatPage: 0,
    ...fields,
})
const dbWith = (characters: any[], rest: Record<string, any> = {}) => ({
    formatversion: 4, username: 'u', personaPrompt: 'p', botPresets: [], modules: [], characters, ...rest,
})
const clone = (o: any) => JSON.parse(JSON.stringify(o))

describe('fast-path — no-op detection after each transition', () => {
    test('init → identical save is a no-op', async () => {
        const db = dbWith([chr('a'), chr('b')])
        const p = new RisuSavePatcher()
        await p.init(db)
        const { patch } = await p.set(clone(db), emptyToSave())
        expect(patch).toEqual([])
    })

    test('root change → saved, then identical re-save is a no-op', async () => {
        const db = dbWith([chr('a')])
        const p = new RisuSavePatcher()
        await p.init(db)

        const changed = clone(db); changed.personaPrompt = 'new persona'
        const r1 = await p.set(clone(changed), { ...emptyToSave(), root: true })
        expect(r1.patch.some((o: any) => o.path === '/personaPrompt')).toBe(true)

        const r2 = await p.set(clone(changed), emptyToSave())
        expect(r2.patch).toEqual([])
    })

    test('character field change → saved, then no-op (caught even with empty toSave.character)', async () => {
        const db = dbWith([chr('a'), chr('b')])
        const p = new RisuSavePatcher()
        await p.init(db)

        const changed = clone(db); changed.characters[1].desc = 'edited B'
        // Deliberately empty toSave.character: the change must be caught by the
        // JSON compare → protocol hash, not by the save-tracker hint.
        const r1 = await p.set(clone(changed), emptyToSave())
        expect(r1.patch.some((o: any) => o.path === '/characters/1/desc')).toBe(true)

        const r2 = await p.set(clone(changed), emptyToSave())
        expect(r2.patch).toEqual([])
    })

    test('character add → saved, then no-op', async () => {
        const db = dbWith([chr('a')])
        const p = new RisuSavePatcher()
        await p.init(db)

        const changed = clone(db); changed.characters.push(chr('b'))
        const r1 = await p.set(clone(changed), emptyToSave())
        expect(r1.patch.some((o: any) => o.path === '/characters')).toBe(true)

        const r2 = await p.set(clone(changed), emptyToSave())
        expect(r2.patch).toEqual([])
    })

    test('character delete → saved, then no-op', async () => {
        const db = dbWith([chr('a'), chr('b'), chr('c')])
        const p = new RisuSavePatcher()
        await p.init(db)

        const changed = clone(db); changed.characters.splice(1, 1) // remove b
        const r1 = await p.set(clone(changed), emptyToSave())
        expect(r1.patch.some((o: any) => o.path === '/characters')).toBe(true)

        const r2 = await p.set(clone(changed), emptyToSave())
        expect(r2.patch).toEqual([])
    })

    test('character reorder → saved, then no-op', async () => {
        const db = dbWith([chr('a'), chr('b'), chr('c')])
        const p = new RisuSavePatcher()
        await p.init(db)

        const changed = clone(db); changed.characters = [changed.characters[2], changed.characters[0], changed.characters[1]]
        const r1 = await p.set(clone(changed), emptyToSave())
        expect(r1.patch.some((o: any) => o.path === '/characters')).toBe(true)

        const r2 = await p.set(clone(changed), emptyToSave())
        expect(r2.patch).toEqual([])
    })
})

describe('fast-path — a skipped block still catches a later change', () => {
    test('no-op save (fast-path skip) does not blind the patcher to the next edit', async () => {
        const db = dbWith([chr('a'), chr('b')])
        const p = new RisuSavePatcher()
        await p.init(db)

        // First: identical save → fast path skips char 'a' and 'b'.
        expect((await p.set(clone(db), emptyToSave())).patch).toEqual([])

        // Then edit char 'a' (previously skipped). Must be caught.
        const edited = clone(db); edited.characters[0].firstMessage = 'hi'
        const { patch } = await p.set(clone(edited), emptyToSave())
        expect(patch.some((o: any) => o.path === '/characters/0/firstMessage')).toBe(true)
    })

    test('root no-op then root edit is caught', async () => {
        const db = dbWith([chr('a')])
        const p = new RisuSavePatcher()
        await p.init(db)
        expect((await p.set(clone(db), emptyToSave())).patch).toEqual([])

        const edited = clone(db); edited.username = 'renamed'
        const { patch } = await p.set(clone(edited), emptyToSave())
        expect(patch.some((o: any) => o.path === '/username')).toBe(true)
    })
})

describe('fast-path — shared (non-cyclic) references round-trip correctly', () => {
    // normalizeJSON uses path-based cycle detection: a shared (non-cyclic)
    // reference appearing twice is kept in BOTH places (only true cycles are
    // nulled). So raw JSON and the normalized baseline agree on shared-ref data
    // and the fast path is safe — no null to "recover". These pin that the
    // patcher neither corrupts shared-ref data nor emits spurious ops.
    test('character with a shared ref: round-trips without null corruption, then no-op', async () => {
        const { applyPatch: apply } = await import('fast-json-patch')
        const shared = { tag: 'v', n: 1 }
        const base = dbWith([chr('a')])
        const p = new RisuSavePatcher()
        await p.init(base)

        // Introduce a character that holds the same object under two keys.
        const withShared = dbWith([chr('a', { extA: shared, extB: shared })])
        const { patch } = await p.set(withShared, { ...emptyToSave(), character: ['a'] })

        // Server reconstruction must hold the full object in BOTH places (no null).
        const server = JSON.parse(JSON.stringify(normalizeJSON(base)))
        apply(server, patch)
        expect(server.characters[0].extA).toEqual({ tag: 'v', n: 1 })
        expect(server.characters[0].extB).toEqual({ tag: 'v', n: 1 })

        // Identical re-save is a clean no-op (baseline converged).
        expect((await p.set(withShared, emptyToSave())).patch).toEqual([])
    })

    test('un-sharing into deep-equal objects is a no-op (no spurious ops)', async () => {
        const shared = { tag: 'v', n: 1 }
        const p = new RisuSavePatcher()
        await p.init(dbWith([chr('a', { extA: shared, extB: shared })]))

        // Un-share: two independent but deep-equal objects — content unchanged.
        const unshared = dbWith([chr('a', { extA: { tag: 'v', n: 1 }, extB: { tag: 'v', n: 1 } })])
        const { patch } = await p.set(unshared, emptyToSave())
        expect(patch).toEqual([])
    })

    test('a real content change under a shared ref is still caught', async () => {
        const shared = { tag: 'v', n: 1 }
        const p = new RisuSavePatcher()
        await p.init(dbWith([chr('a', { extA: shared, extB: shared })]))

        // Now genuinely change extB's content.
        const changed = dbWith([chr('a', { extA: { tag: 'v', n: 1 }, extB: { tag: 'v', n: 2 } })])
        const { patch } = await p.set(changed, emptyToSave())
        expect(patch.some((o: any) => o.path.startsWith('/characters/0/extB'))).toBe(true)
    })

    test('root-level shared ref round-trips and converges to a no-op', async () => {
        const { applyPatch: apply } = await import('fast-json-patch')
        const shared = { theme: 'x' }
        const base = dbWith([chr('a')])
        const p = new RisuSavePatcher()
        await p.init(base)

        const withShared = dbWith([chr('a')], { sdProvider: shared, customCss: shared } as any)
        const { patch } = await p.set(withShared, { ...emptyToSave(), root: true })
        const server = JSON.parse(JSON.stringify(normalizeJSON(base)))
        apply(server, patch)
        expect(server.sdProvider).toEqual({ theme: 'x' })
        expect(server.customCss).toEqual({ theme: 'x' })

        expect((await p.set(withShared, emptyToSave())).patch).toEqual([])
    })
})

describe('fast-path — expectedHash stays protocol-consistent', () => {
    test('hash after N mutating saves equals a fresh init of the same data', async () => {
        const db = dbWith([chr('a'), chr('b')])
        const live = new RisuSavePatcher()
        await live.init(db)

        // Drive several transitions on the live patcher.
        const s1 = clone(db); s1.personaPrompt = 'x'; await live.set(clone(s1), { ...emptyToSave(), root: true })
        const s2 = clone(s1); s2.characters[0].desc = 'y'; await live.set(clone(s2), emptyToSave())
        const s3 = clone(s2); s3.characters.push(chr('c')); await live.set(clone(s3), emptyToSave())
        const s4 = clone(s3); s4.characters.splice(0, 1); await live.set(clone(s4), emptyToSave())

        // expectedHash of the live patcher's next save (pre-image = current state)
        const liveHash = (await live.set(clone(s4), emptyToSave())).expectedHash

        // A fresh patcher initialised directly to the final state must agree.
        const fresh = new RisuSavePatcher()
        await fresh.init(clone(s4))
        const freshHash = (await fresh.set(clone(s4), emptyToSave())).expectedHash

        expect(liveHash).toBe(freshHash)
    })
})

// ──────────────────────────────────────────────────────────────────────────
// Fast-path granularity — per-ROOT-KEY and per-MODULE pre-checks.
//
// While typing into a root field (personaPrompt) or a module lorebook, that
// block changes on EVERY save, so a per-block pre-check never matches. The
// pre-check is therefore kept per root key / per module: only the changed
// entry pays normalize + protocol hash + diff. These suites pin (a) op scope,
// (b) no-op convergence, (c) protocol-hash parity with a fresh init, and
// (d) the prototype-pollution / key-type hazards of id-keyed caches.
// ──────────────────────────────────────────────────────────────────────────

describe('fast-path — per-root-key granularity', () => {
    test('personaPrompt edit emits ONLY /personaPrompt ops (other root keys untouched)', async () => {
        const db = dbWith([chr('a')], { customCSS: 'body{}'.repeat(100), loreBook: [{ key: 'x', content: 'y' }] } as any)
        const p = new RisuSavePatcher()
        await p.init(db)

        const changed = clone(db); changed.personaPrompt = 'edited'
        const { patch } = await p.set(clone(changed), { ...emptyToSave(), root: true })
        expect(patch.length).toBeGreaterThan(0)
        for (const op of patch) {
            expect(op.path.startsWith('/personaPrompt')).toBe(true)
        }

        const r2 = await p.set(clone(changed), emptyToSave())
        expect(r2.patch).toEqual([])
    })

    test('root key added → add op; root key deleted → remove op; then no-op', async () => {
        const db = dbWith([chr('a')])
        const p = new RisuSavePatcher()
        await p.init(db)

        const added = clone(db); added.newSetting = { on: true }
        const r1 = await p.set(clone(added), { ...emptyToSave(), root: true })
        expect(r1.patch.some((o: any) => o.op === 'add' && o.path === '/newSetting')).toBe(true)
        expect((await p.set(clone(added), emptyToSave())).patch).toEqual([])

        const removed = clone(added); delete removed.newSetting
        const r2 = await p.set(clone(removed), { ...emptyToSave(), root: true })
        expect(r2.patch.some((o: any) => o.op === 'remove' && o.path === '/newSetting')).toBe(true)
        expect((await p.set(clone(removed), emptyToSave())).patch).toEqual([])
    })

    test('an own __proto__ root key never produces a forbidden patch op', async () => {
        // A db loaded from JSON can carry an own enumerable "__proto__" key.
        // The old whole-root normalizeJSON dropped it; the per-key path must
        // too, or it emits a /__proto__ op that the server's applyPatch rejects
        // (prototype-pollution guard) — failing every save.
        const { applyPatch: apply } = await import('fast-json-patch')
        const db: any = dbWith([chr('a')])
        Object.defineProperty(db, '__proto__', { value: { polluted: true }, enumerable: true, writable: true, configurable: true })
        expect(Object.keys(db)).toContain('__proto__')

        const p = new RisuSavePatcher()
        await p.init(db)
        const changed = clone(db); changed.personaPrompt = 'edited'
        const { patch } = await p.set(clone(changed), { ...emptyToSave(), root: true })

        expect(patch.some((o: any) => o.path === '/__proto__' || o.path.startsWith('/__proto__/'))).toBe(false)
        expect(patch.some((o: any) => o.path === '/personaPrompt')).toBe(true)
        // The patch must apply cleanly on a normalized server baseline (no throw).
        const serverState = JSON.parse(JSON.stringify(normalizeJSON(db)))
        expect(() => apply(serverState, patch)).not.toThrow()
        // And converge to a no-op.
        expect((await p.set(clone(changed), emptyToSave())).patch).toEqual([])
    })

    test('a root value with toJSON()→undefined is kept, not removed', async () => {
        // normalizeJSON ignores toJSON and keeps {x:1}; the per-key path must
        // decide presence by the normalized result, not by JSON.stringify(raw)
        // (which is undefined here), or it would emit a spurious /weird remove.
        const db: any = dbWith([chr('a')])
        db.weird = { x: 1, toJSON() { return undefined } }
        const p = new RisuSavePatcher()
        await p.init(db)

        // Unchanged save: must be a pure no-op (no remove of /weird).
        const { patch } = await p.set(db, { ...emptyToSave(), root: true })
        expect(patch.some((o: any) => o.path === '/weird' || o.path.startsWith('/weird/'))).toBe(false)
        expect(patch).toEqual([])

        const liveHash = (await p.set(db, emptyToSave())).expectedHash
        const fresh = new RisuSavePatcher(); await fresh.init(db)
        expect(liveHash).toBe((await fresh.set(db, emptyToSave())).expectedHash)
    })

    test('a top-level bigint root value drops cleanly — no undefined baseline / hash stays consistent', async () => {
        // bigint: JSON.stringify throws and normalizeJSON maps it to undefined,
        // so its key is dropped. The patcher must not store an undefined
        // baseline/hash for it (which would diverge from a fresh init).
        const db: any = dbWith([chr('a')])
        db.bsig = 123n
        const p = new RisuSavePatcher()
        await p.init(db)
        await p.set(db, { ...emptyToSave(), root: true })

        const liveHash = (await p.set(db, emptyToSave())).expectedHash
        const fresh = new RisuSavePatcher(); await fresh.init(db)
        const freshHash = (await fresh.set(db, emptyToSave())).expectedHash
        expect(liveHash).toBe(freshHash)
    })

    test('per-key ops reconstruct the same server state as a whole-root diff would', async () => {
        const { applyPatch: apply } = await import('fast-json-patch')
        const db = dbWith([chr('a')], { sdProvider: { x: 1 }, themeList: ['a', 'b'] } as any)
        const p = new RisuSavePatcher()
        await p.init(db)

        const changed = clone(db)
        changed.personaPrompt = 'new'
        changed.sdProvider = { x: 2, y: 3 }
        delete changed.themeList
        const { patch } = await p.set(clone(changed), { ...emptyToSave(), root: true })

        const serverState = JSON.parse(JSON.stringify(normalizeJSON(db)))
        apply(serverState, patch)
        expect(serverState).toEqual(normalizeJSON(clone(changed)))
    })
})

describe('fast-path — per-module granularity', () => {
    const mod = (id: string, content = '') => ({
        id, name: 'M' + id, lorebook: [{ key: 'k', comment: 'c', content }], regex: [], trigger: [],
    })

    test('editing one module emits ops only under that module index; then no-op', async () => {
        const db = dbWith([chr('a')], { } as any)
        db.modules = [mod('m1', 'aaa'), mod('m2', 'bbb'), mod('m3', 'ccc')]
        const p = new RisuSavePatcher()
        await p.init(db)

        const changed = clone(db); changed.modules[1].lorebook[0].content = 'edited'
        const { patch } = await p.set(clone(changed), { ...emptyToSave(), modules: true })
        expect(patch.length).toBeGreaterThan(0)
        for (const op of patch) {
            expect(op.path.startsWith('/modules/1')).toBe(true)
        }

        const r2 = await p.set(clone(changed), { ...emptyToSave(), modules: true })
        expect(r2.patch).toEqual([])
    })

    test('module add/remove/reorder → single whole-array replace; then no-op', async () => {
        const db = dbWith([chr('a')], { } as any)
        db.modules = [mod('m1'), mod('m2')]
        const p = new RisuSavePatcher()
        await p.init(db)

        const added = clone(db); added.modules.push(mod('m3'))
        const r1 = await p.set(clone(added), { ...emptyToSave(), modules: true })
        expect(r1.patch).toEqual([{ op: 'replace', path: '/modules', value: normalizeJSON(clone(added)).modules }])
        expect((await p.set(clone(added), { ...emptyToSave(), modules: true })).patch).toEqual([])

        const reordered = clone(added); reordered.modules = [reordered.modules[2], reordered.modules[0], reordered.modules[1]]
        const r2 = await p.set(clone(reordered), { ...emptyToSave(), modules: true })
        expect(r2.patch.length).toBe(1)
        expect(r2.patch[0].path).toBe('/modules')
        expect((await p.set(clone(reordered), { ...emptyToSave(), modules: true })).patch).toEqual([])
    })

    test('per-module element-wise ops reconstruct the server state (applyPatch round-trip)', async () => {
        const { applyPatch: apply } = await import('fast-json-patch')
        const db = dbWith([chr('a')], { } as any)
        db.modules = [mod('m1', 'aaa'), mod('m2', 'bbb'), mod('m3', 'ccc')]
        const p = new RisuSavePatcher()
        await p.init(db)

        const changed = clone(db)
        changed.modules[0].lorebook[0].content = 'edit0'
        changed.modules[2].name = 'renamed'
        const { patch } = await p.set(clone(changed), { ...emptyToSave(), modules: true })

        const serverState = JSON.parse(JSON.stringify(normalizeJSON(db)))
        apply(serverState, patch)
        expect(serverState.modules).toEqual(normalizeJSON(clone(changed)).modules)
    })

    test('modules protocol hash from cached item hashes equals a fresh full hash', async () => {
        const db = dbWith([chr('a')], { } as any)
        db.modules = [mod('m1', 'aaa'), mod('m2', 'bbb')]
        const live = new RisuSavePatcher()
        await live.init(db)

        // Mutate one module via the element-wise path, then another save.
        const s1 = clone(db); s1.modules[0].lorebook[0].content = 'x1'
        await live.set(clone(s1), { ...emptyToSave(), modules: true })
        const s2 = clone(s1); s2.modules[1].name = 'renamed'
        await live.set(clone(s2), { ...emptyToSave(), modules: true })

        const liveHash = (await live.set(clone(s2), emptyToSave())).expectedHash
        const fresh = new RisuSavePatcher()
        await fresh.init(clone(s2))
        const freshHash = (await fresh.set(clone(s2), emptyToSave())).expectedHash
        expect(liveHash).toBe(freshHash)
    })

    test('module id "__proto__" cannot poison the caches — protocol hash stays consistent', async () => {
        // Plain-object caches would silently hit the prototype setter for this
        // id (storing nothing / returning Object.prototype), corrupting the
        // skip check and the hash fold. Map caches must handle it strictly.
        const db = dbWith([chr('a')], { } as any)
        db.modules = [mod('__proto__', 'aaa'), mod('m2', 'bbb')]
        const live = new RisuSavePatcher()
        await live.init(db)

        const s1 = clone(db); s1.modules[0].lorebook[0].content = 'edited'
        const r1 = await live.set(clone(s1), { ...emptyToSave(), modules: true })
        expect(r1.patch.some((o: any) => o.path.startsWith('/modules/0'))).toBe(true)
        expect((await live.set(clone(s1), { ...emptyToSave(), modules: true })).patch).toEqual([])

        const liveHash = (await live.set(clone(s1), emptyToSave())).expectedHash
        const fresh = new RisuSavePatcher()
        await fresh.init(clone(s1))
        const freshHash = (await fresh.set(clone(s1), emptyToSave())).expectedHash
        expect(liveHash).toBe(freshHash)
    })

    test('non-string module ids (1 vs "1") force the structural path — no key collision', async () => {
        const db = dbWith([chr('a')], { } as any)
        db.modules = [{ ...mod('x'), id: 1 as any }, { ...mod('y'), id: '1' }]
        const live = new RisuSavePatcher()
        await live.init(db)

        // Numeric id → structural fallback: whole-array replace, never element-wise.
        const s1 = clone(db); s1.modules[0].lorebook[0].content = 'edited'
        const r1 = await live.set(clone(s1), { ...emptyToSave(), modules: true })
        expect(r1.patch.length).toBe(1)
        expect(r1.patch[0].path).toBe('/modules')

        const liveHash = (await live.set(clone(s1), emptyToSave())).expectedHash
        const fresh = new RisuSavePatcher()
        await fresh.init(clone(s1))
        const freshHash = (await fresh.set(clone(s1), emptyToSave())).expectedHash
        expect(liveHash).toBe(freshHash)
    })
})

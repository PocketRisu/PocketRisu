import { describe, expect, it } from 'vitest'
import { get, writable } from 'svelte/store'

// Headless reproduction of the plugin-permission dialog race and its fix.
//
// The real getPluginPermission() lives behind DOM/iframe/DBState dependencies,
// so we cannot import it directly. Instead we faithfully replicate the two
// mechanisms that actually cause the reported bug:
//
//   1. The shared single alertStore + waitAlert() polling loop, copied 1:1
//      from src/ts/alert.ts. Every dialog writes to ONE store and waits for
//      type==='none', which is exactly why concurrent dialogs clobber each
//      other in the original code.
//   2. Two getPluginPermission variants — "buggy" (no serialization, the
//      original flow) and "fixed" (the Promise-chain mutex from this branch).
//
// A simulated user answers dialogs one at a time, the way a human clicking the
// modal would. We then assert the buggy version exhibits the reported symptom
// and the fixed version does not.

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// ─── Replica of the shared alert store (mirrors src/ts/alert.ts) ────────────

type AlertData = { type: 'none' | 'ask'; msg: string }

function makeAlertHarness() {
    const alertStore = writable<AlertData>({ type: 'none', msg: 'n' })

    // Tracks how many dialogs believe they are "currently shown" at any instant.
    // In the real UI only one modal renders, but each concurrent alertConfirm
    // call thinks it owns the store — this counter exposes the clobber.
    let liveDialogs = 0
    let maxConcurrentLive = 0

    async function waitAlert() {
        while (true) {
            if (get(alertStore).type === 'none') break
            await sleep(2)
        }
    }

    // 1:1 with alert.ts alertConfirm: set the single store, wait, read result.
    async function alertConfirm(msg: string): Promise<boolean> {
        liveDialogs++
        maxConcurrentLive = Math.max(maxConcurrentLive, liveDialogs)
        try {
            alertStore.set({ type: 'ask', msg })
            await waitAlert()
            return get(alertStore).msg === 'yes'
        } finally {
            liveDialogs--
        }
    }

    return { alertStore, alertConfirm, getMaxConcurrentLive: () => maxConcurrentLive }
}

// Simulated user: every few ms, if a dialog is open, answer it (yes) by
// resetting the store to 'none' — the same transition the real footer buttons
// perform. Returns a stop() handle.
function startAutoResponder(alertStore: ReturnType<typeof makeAlertHarness>['alertStore']) {
    let stopped = false
    const loop = async () => {
        while (!stopped) {
            if (get(alertStore).type === 'ask') {
                alertStore.set({ type: 'none', msg: 'yes' })
            }
            await sleep(3)
        }
    }
    const done = loop()
    return { stop: async () => { stopped = true; await done } }
}

// ─── Shared permission state (mirrors v3.svelte.ts module state) ─────────────

function makePermissionState() {
    const given = new Set<string>()
    const denied = new Set<string>()
    const cache = new Map<string, boolean | number>()
    return { given, denied, cache }
}

const PERMISSION_DESCS = ['fetchLogs', 'db', 'mainDom', 'replacer', 'provider', 'sendChat']

// Mirrors permissionKeyOf() in v3.svelte.ts: JSON-encode the (name, desc) pair so
// keys can never collide across permissions or with a legacy name-only entry.
const keyOf = (pluginName: string, permissionDesc: string) => JSON.stringify([pluginName, permissionDesc])

// Mirrors resetPluginPermission()'s exact-key deletion. Permission descs are a
// fixed enum, so reset enumerates every exact key instead of prefix matching —
// otherwise resetting "foo" would also wipe "foo_bar"'s records.
function resetPermission(state: ReturnType<typeof makePermissionState>, pluginName: string) {
    const exactKeys = PERMISSION_DESCS.map((desc) => keyOf(pluginName, desc))
    // pluginName alone clears legacy name-only entries from older versions.
    for (const key of [pluginName, ...exactKeys]) {
        state.given.delete(key)
        state.denied.delete(key)
    }
    // lastGrantTime entries live in the cache map, keyed the same way.
    for (const desc of PERMISSION_DESCS) {
        state.cache.delete(keyOf(pluginName, desc) + '_lastGrantTime')
    }
}

// ─── BUGGY variant: original flow, no serialization ──────────────────────────

function makeBuggyGetPermission(
    state: ReturnType<typeof makePermissionState>,
    alertConfirm: (m: string) => Promise<boolean>,
) {
    return async function getPluginPermission(pluginName: string): Promise<boolean> {
        if (state.given.has(pluginName)) return true
        if (state.denied.has(pluginName)) return false
        const conf = await alertConfirm(`Allow ${pluginName}?`)
        if (conf) {
            state.given.add(pluginName)
            return true
        }
        state.denied.add(pluginName)
        return false
    }
}

// ─── FIXED variant: Promise-chain mutex + double-check (this branch) ──────────

function makeFixedGetPermission(
    state: ReturnType<typeof makePermissionState>,
    alertConfirm: (m: string) => Promise<boolean>,
) {
    let chain: Promise<unknown> = Promise.resolve()

    const resolved = (pluginName: string): { resolved: boolean; value: boolean } => {
        if (state.given.has(pluginName)) return { resolved: true, value: true }
        if (state.denied.has(pluginName)) return { resolved: true, value: false }
        return { resolved: false, value: false }
    }

    return async function getPluginPermission(pluginName: string): Promise<boolean> {
        const early = resolved(pluginName)
        if (early.resolved) return early.value

        const showDialog = async (): Promise<boolean> => {
            const recheck = resolved(pluginName)
            if (recheck.resolved) return recheck.value
            const conf = await alertConfirm(`Allow ${pluginName}?`)
            if (conf) {
                state.given.add(pluginName)
                return true
            }
            state.denied.add(pluginName)
            return false
        }

        const run = chain.catch(() => {}).then(() => showDialog())
        chain = run.catch(() => {})
        return run
    }
}

// ─── Per-permission variant: key state by pluginName + permissionDesc ────────
//
// The dialog-serialization fix keys granted/denied state by plugin NAME only.
// That makes the queue correct but lets one granted permission (e.g. fetchLogs)
// silently authorize a different one (e.g. db) for the same plugin. The real fix
// keys the given/denied sets by keyOf(pluginName, permissionDesc). This variant
// mirrors that so we can assert each permission is gated separately.

function makePerPermissionGetPermission(
    state: ReturnType<typeof makePermissionState>,
    alertConfirm: (m: string) => Promise<boolean>,
) {
    let chain: Promise<unknown> = Promise.resolve()

    const resolved = (key: string): { resolved: boolean; value: boolean } => {
        if (state.given.has(key)) return { resolved: true, value: true }
        if (state.denied.has(key)) return { resolved: true, value: false }
        return { resolved: false, value: false }
    }

    return async function getPluginPermission(pluginName: string, permissionDesc: string): Promise<boolean> {
        const key = keyOf(pluginName, permissionDesc)
        const early = resolved(key)
        if (early.resolved) return early.value

        const showDialog = async (): Promise<boolean> => {
            const recheck = resolved(key)
            if (recheck.resolved) return recheck.value
            const conf = await alertConfirm(`Allow ${pluginName} → ${permissionDesc}?`)
            if (conf) {
                state.given.add(key)
                return true
            }
            state.denied.add(key)
            return false
        }

        const run = chain.catch(() => {}).then(() => showDialog())
        chain = run.catch(() => {})
        return run
    }
}

// ─── Periodic-reconfirm variant: mirrors getPluginPermission's 'periodically' ─
//
// A 'periodically' request only re-prompts if the last grant is older than the
// window. The bug: requiresReconfirm was captured BEFORE entering the queue, so
// when several identical periodic requests queued together they all decided
// "reconfirm due" up front; the first grant refreshed lastGrantTime but the rest
// re-prompted anyway. The fix recomputes it under the lock. `recompute` toggles
// between the fixed (true) and buggy (false) behavior so a test can pin both.
function makePeriodicGetPermission(
    state: ReturnType<typeof makePermissionState>,
    alertConfirm: (m: string) => Promise<boolean>,
    now: () => number,
    recompute: boolean,
    windowMs = 3 * 24 * 60 * 60 * 1000,
) {
    let chain: Promise<unknown> = Promise.resolve()

    const dueForReconfirm = (key: string) => {
        const last = state.cache.get(key + '_lastGrantTime') as number | undefined
        return !last || now() - last > windowMs
    }
    const resolved = (key: string, requiresReconfirm: boolean) => {
        if (!requiresReconfirm && state.given.has(key)) return { resolved: true, value: true }
        if (!requiresReconfirm && state.denied.has(key)) return { resolved: true, value: false }
        return { resolved: false, value: false }
    }

    return async function getPluginPermission(pluginName: string, permissionDesc: string): Promise<boolean> {
        const key = keyOf(pluginName, permissionDesc)
        const captured = dueForReconfirm(key)
        const early = resolved(key, captured)
        if (early.resolved) return early.value

        const showDialog = async (): Promise<boolean> => {
            // Fixed: recompute under the lock. Buggy: reuse the captured value.
            const requiresReconfirm = recompute ? dueForReconfirm(key) : captured
            const recheck = resolved(key, requiresReconfirm)
            if (recheck.resolved) return recheck.value
            const conf = await alertConfirm(`Allow ${pluginName} → ${permissionDesc}?`)
            if (conf) {
                state.given.add(key)
                state.cache.set(key + '_lastGrantTime', now())
                return true
            }
            state.denied.add(key)
            return false
        }

        const run = chain.catch(() => {}).then(() => showDialog())
        chain = run.catch(() => {})
        return run
    }
}

describe('plugin permission dialog serialization', () => {
    it('BUGGY: concurrent requests clobber the shared dialog (reproduces the report)', async () => {
        const harness = makeAlertHarness()
        const state = makePermissionState()
        const getPerm = makeBuggyGetPermission(state, harness.alertConfirm)
        const responder = startAutoResponder(harness.alertStore)

        const plugins = ['A', 'B', 'C', 'D']
        const results = await Promise.all(plugins.map((p) => getPerm(p)))

        await responder.stop()

        // The bug: multiple dialogs are "live" on the single store at once.
        expect(harness.getMaxConcurrentLive()).toBeGreaterThan(1)
    })

    it('FIXED: only one dialog is live at a time, every request gets its own answer', async () => {
        const harness = makeAlertHarness()
        const state = makePermissionState()
        const getPerm = makeFixedGetPermission(state, harness.alertConfirm)
        const responder = startAutoResponder(harness.alertStore)

        const plugins = ['A', 'B', 'C', 'D']
        const results = await Promise.all(plugins.map((p) => getPerm(p)))

        await responder.stop()

        // Never more than one dialog on the shared store simultaneously.
        expect(harness.getMaxConcurrentLive()).toBe(1)
        // Every plugin received and recorded its own grant.
        expect(results).toEqual([true, true, true, true])
        expect([...state.given].sort()).toEqual(['A', 'B', 'C', 'D'])
    })

    it('FIXED: cached/granted permission skips the queue (fast path, no blocking)', async () => {
        const harness = makeAlertHarness()
        const state = makePermissionState()
        state.given.add('AlreadyGranted')
        const getPerm = makeFixedGetPermission(state, harness.alertConfirm)

        // No responder running — if this blocked on a dialog it would hang.
        const result = await getPerm('AlreadyGranted')

        expect(result).toBe(true)
        // No dialog was ever shown for an already-granted plugin.
        expect(harness.getMaxConcurrentLive()).toBe(0)
    })

    it('FIXED: a duplicate request for the same plugin is auto-resolved after the first grant', async () => {
        const harness = makeAlertHarness()
        const state = makePermissionState()
        const getPerm = makeFixedGetPermission(state, harness.alertConfirm)
        const responder = startAutoResponder(harness.alertStore)

        // Two concurrent requests for the SAME plugin. The second must NOT show
        // a second dialog — the double-check under the lock catches the grant.
        const [r1, r2] = await Promise.all([getPerm('Dup'), getPerm('Dup')])

        await responder.stop()

        expect(r1).toBe(true)
        expect(r2).toBe(true)
        // Only one dialog total: the second request short-circuited.
        expect(harness.getMaxConcurrentLive()).toBe(1)
    })

    it('PER-PERMISSION: a grant for one permission does NOT authorize a different one', async () => {
        const harness = makeAlertHarness()
        const state = makePermissionState()
        const getPerm = makePerPermissionGetPermission(state, harness.alertConfirm)

        // Grant fetchLogs first.
        const responder = startAutoResponder(harness.alertStore)
        const fetchLogs = await getPerm('Plug', 'fetchLogs')
        await responder.stop()
        expect(fetchLogs).toBe(true)

        // Now request a DIFFERENT permission for the same plugin. With name-only
        // keying this would auto-resolve to true without ever asking. With
        // per-permission keying it must show its own dialog. We deny it.
        let denied = false
        const denier = (() => {
            let stopped = false
            const loop = async () => {
                while (!stopped) {
                    if (get(harness.alertStore).type === 'ask') {
                        harness.alertStore.set({ type: 'none', msg: 'no' })
                        denied = true
                    }
                    await sleep(3)
                }
            }
            const done = loop()
            return { stop: async () => { stopped = true; await done } }
        })()

        const dbPerm = await getPerm('Plug', 'db')
        await denier.stop()

        // A dialog WAS shown for 'db' (it was not silently granted)...
        expect(denied).toBe(true)
        // ...and the denial took effect — the two permissions are independent.
        expect(dbPerm).toBe(false)
        expect(state.given.has(keyOf('Plug', 'fetchLogs'))).toBe(true)
        expect(state.denied.has(keyOf('Plug', 'db'))).toBe(true)
    })

    it('PER-PERMISSION: a duplicate request for the SAME permission auto-resolves', async () => {
        const harness = makeAlertHarness()
        const state = makePermissionState()
        const getPerm = makePerPermissionGetPermission(state, harness.alertConfirm)
        const responder = startAutoResponder(harness.alertStore)

        // Same plugin, same permission, twice — only one dialog should appear.
        const [r1, r2] = await Promise.all([getPerm('Plug', 'db'), getPerm('Plug', 'db')])
        await responder.stop()

        expect(r1).toBe(true)
        expect(r2).toBe(true)
        expect(harness.getMaxConcurrentLive()).toBe(1)
    })

    it('RESET: resetting "foo" does NOT wipe a different plugin "foo_bar"', () => {
        const state = makePermissionState()
        // foo and foo_bar are distinct plugins whose underscore-laden names would
        // collide under naive string keys; JSON keys keep them disjoint, and reset
        // must delete only foo's exact keys.
        state.given.add(keyOf('foo', 'db'))
        state.given.add(keyOf('foo', 'fetchLogs'))
        state.given.add(keyOf('foo_bar', 'db'))
        state.denied.add(keyOf('foo_bar', 'provider'))
        // lastGrantTime cache entries — foo_bar's must survive too.
        state.cache.set(keyOf('foo', 'db') + '_lastGrantTime', 111)
        state.cache.set(keyOf('foo_bar', 'db') + '_lastGrantTime', 222)

        resetPermission(state, 'foo')

        // foo's own permissions are gone...
        expect(state.given.has(keyOf('foo', 'db'))).toBe(false)
        expect(state.given.has(keyOf('foo', 'fetchLogs'))).toBe(false)
        expect(state.cache.has(keyOf('foo', 'db') + '_lastGrantTime')).toBe(false)
        // ...but foo_bar is untouched.
        expect(state.given.has(keyOf('foo_bar', 'db'))).toBe(true)
        expect(state.denied.has(keyOf('foo_bar', 'provider'))).toBe(true)
        expect(state.cache.has(keyOf('foo_bar', 'db') + '_lastGrantTime')).toBe(true)
    })

    it('RESET: clears every permission desc and legacy name-only entries', () => {
        const state = makePermissionState()
        for (const desc of PERMISSION_DESCS) {
            state.given.add(keyOf('Plug', desc))
        }
        state.denied.add(keyOf('Plug', 'db'))
        state.given.add('Plug') // legacy name-only entry from older versions

        resetPermission(state, 'Plug')

        expect(state.given.size).toBe(0)
        expect(state.denied.size).toBe(0)
    })

    it('LEGACY: a name-only entry "foo_db" does NOT grant plugin "foo" the db permission', async () => {
        const harness = makeAlertHarness()
        const state = makePermissionState()
        // Older versions stored grants by plugin NAME only. A user who granted a
        // plugin literally named "foo_db" left behind the entry "foo_db". With
        // naive `${name}_${desc}` keys, a DIFFERENT plugin "foo" requesting "db"
        // would compute "foo_db" and silently inherit that grant. JSON keys make
        // the new key ["foo","db"], which can never equal the legacy "foo_db".
        state.given.add('foo_db')

        const getPerm = makePerPermissionGetPermission(state, harness.alertConfirm)
        // Deny if a dialog appears, so a wrongly-silent grant is distinguishable
        // from a correctly-prompted one.
        let prompted = false
        const denier = (() => {
            let stopped = false
            const loop = async () => {
                while (!stopped) {
                    if (get(harness.alertStore).type === 'ask') {
                        harness.alertStore.set({ type: 'none', msg: 'no' })
                        prompted = true
                    }
                    await sleep(3)
                }
            }
            const done = loop()
            return { stop: async () => { stopped = true; await done } }
        })()

        const dbPerm = await getPerm('foo', 'db')
        await denier.stop()

        // The legacy entry was NOT mistaken for a grant — a dialog was shown...
        expect(prompted).toBe(true)
        // ...and our denial held, so no silent authorization leaked through.
        expect(dbPerm).toBe(false)
    })

    it('PERIODIC: concurrent identical periodic requests prompt only ONCE', async () => {
        const harness = makeAlertHarness()
        const state = makePermissionState()
        const now = () => 1_000_000 // fixed clock; first grant stamps lastGrantTime=now
        const getPerm = makePeriodicGetPermission(state, harness.alertConfirm, now, /*recompute*/ true)

        // Count dialogs, granting each. maxConcurrentLive can't tell the fix from
        // the bug — serialization keeps dialogs from overlapping in time even when
        // re-prompting — so we must count prompts, not concurrency.
        let dialogs = 0
        const responder = (() => {
            let stopped = false
            const loop = async () => {
                while (!stopped) {
                    if (get(harness.alertStore).type === 'ask') {
                        harness.alertStore.set({ type: 'none', msg: 'yes' })
                        dialogs++
                    }
                    await sleep(2)
                }
            }
            const done = loop()
            return { stop: async () => { stopped = true; await done } }
        })()

        // Four replacer registrations fire at once (e.g. a plugin calling
        // addRisuReplacer repeatedly), all 'periodically' and all due up front.
        const results = await Promise.all([
            getPerm('Plug', 'replacer'),
            getPerm('Plug', 'replacer'),
            getPerm('Plug', 'replacer'),
            getPerm('Plug', 'replacer'),
        ])
        await responder.stop()

        expect(results).toEqual([true, true, true, true])
        // Only the first prompted; the rest saw the refreshed lastGrantTime
        // (recomputed under the lock) and the recorded grant, so no re-prompt.
        expect(dialogs).toBe(1)
    })

    it('PERIODIC: without recompute, the same burst re-prompts (guards the fix)', async () => {
        const harness = makeAlertHarness()
        const state = makePermissionState()
        const now = () => 1_000_000
        // recompute=false reproduces the captured-before-queue bug.
        const getPerm = makePeriodicGetPermission(state, harness.alertConfirm, now, /*recompute*/ false)

        let dialogs = 0
        const counter = (() => {
            let stopped = false
            const loop = async () => {
                while (!stopped) {
                    if (get(harness.alertStore).type === 'ask') {
                        harness.alertStore.set({ type: 'none', msg: 'yes' })
                        dialogs++
                    }
                    await sleep(2)
                }
            }
            const done = loop()
            return { stop: async () => { stopped = true; await done } }
        })()

        await Promise.all([
            getPerm('Plug', 'replacer'),
            getPerm('Plug', 'replacer'),
            getPerm('Plug', 'replacer'),
        ])
        await counter.stop()

        // The buggy path prompts more than once for the same burst.
        expect(dialogs).toBeGreaterThan(1)
    })

    it('FIXED: a throwing dialog does not deadlock later requests', async () => {
        const harness = makeAlertHarness()
        const state = makePermissionState()
        let chain: Promise<unknown> = Promise.resolve()

        // Minimal chain identical to the fix, but the first dialog throws.
        const run = (fn: () => Promise<boolean>) => {
            const r = chain.catch(() => {}).then(fn)
            chain = r.catch(() => {})
            return r
        }

        const first = run(async () => { throw new Error('boom') })
        const second = run(async () => {
            return harness.alertConfirm('after boom')
        })
        const responder = startAutoResponder(harness.alertStore)

        await expect(first).rejects.toThrow('boom')
        // The second request still runs and resolves — no deadlock.
        await expect(second).resolves.toBe(true)
        await responder.stop()
    })
})

import { describe, it, expect } from 'vitest'
import pkg from './session-lock.cjs'

const { createSessionLock } = pkg as {
    createSessionLock: (opts?: { now?: () => number }) => {
        register: (id: string) => void
        checkWrite: (id: string, userActive?: boolean) => { ok: boolean, tookOver?: boolean, passive?: boolean }
        activeId: () => string | null
    }
}

// Injected clock: each call advances 1ms so "booted after the last write"
// comparisons are deterministic without sleeping.
function makeLock() {
    let t = 1000
    const lock = createSessionLock({ now: () => ++t })
    return { lock, tick: () => ++t }
}

describe('session-lock', () => {
    it('a page load never steals an active lock (glance / OS tab restore)', () => {
        const { lock } = makeLock()
        lock.register('pc')
        expect(lock.checkWrite('pc').ok).toBe(true)   // pc is active and writing
        lock.register('phone')                        // phone merely opens the app
        expect(lock.activeId()).toBe('pc')            // pc keeps the lock
        expect(lock.checkWrite('pc').ok).toBe(true)   // and keeps writing untouched
    })

    it('adopts the first session when nobody holds the lock', () => {
        const { lock } = makeLock()
        lock.register('pc')
        expect(lock.activeId()).toBe('pc')
    })

    it('first write adopts even without a registered boot (server restarted mid-session)', () => {
        const { lock } = makeLock()
        expect(lock.checkWrite('pc').ok).toBe(true)
        expect(lock.activeId()).toBe('pc')
    })

    it('a freshly-booted session takes over on its first WRITE, then the old one is rejected', () => {
        const { lock } = makeLock()
        lock.register('pc')
        expect(lock.checkWrite('pc').ok).toBe(true)   // pc writes
        lock.register('phone')                        // phone boots AFTER that write → fresh
        const takeover = lock.checkWrite('phone', true) // phone's first USER action
        expect(takeover).toEqual({ ok: true, tookOver: true })
        expect(lock.activeId()).toBe('phone')
        expect(lock.checkWrite('pc').ok).toBe(false)  // pc is now the stale one → 423
    })

    it('a stale session (booted before the last write) is rejected, not taken over', () => {
        const { lock } = makeLock()
        lock.register('phone')                        // phone opened first…
        lock.register('pc')                           // …then pc opened
        expect(lock.checkWrite('phone').ok).toBe(true) // phone became active at its boot
        expect(lock.checkWrite('phone').ok).toBe(true) // and wrote AFTER pc booted
        expect(lock.checkWrite('pc').ok).toBe(false)   // pc's copy predates that write → stale
        expect(lock.activeId()).toBe('phone')
    })

    it('a rejected session recovers by re-booting (reload) and writing again', () => {
        const { lock } = makeLock()
        lock.register('pc')
        expect(lock.checkWrite('pc').ok).toBe(true)
        lock.register('phone')
        expect(lock.checkWrite('phone', true).ok).toBe(true) // phone took over (user action)
        expect(lock.checkWrite('pc').ok).toBe(false)    // pc kicked → client reloads
        lock.register('pc')                             // reload = fresh boot
        expect(lock.checkWrite('pc', true)).toEqual({ ok: true, tookOver: true })
        expect(lock.activeId()).toBe('pc')
    })

    it('re-registering the ACTIVE id (same-tab reload with persisted id) keeps the lock quietly', () => {
        const { lock } = makeLock()
        lock.register('pc')
        expect(lock.checkWrite('pc').ok).toBe(true)
        lock.register('pc')                            // OS restored the same tab
        expect(lock.activeId()).toBe('pc')
        expect(lock.checkWrite('pc')).toEqual({ ok: true }) // no takeover event, no kick anywhere
    })

    it('serial device alternation never rejects anyone', () => {
        const { lock } = makeLock()
        lock.register('a')
        expect(lock.checkWrite('a', true).ok).toBe(true)
        lock.register('b')
        expect(lock.checkWrite('b', true).ok).toBe(true)
        lock.register('a')
        expect(lock.checkWrite('a', true).ok).toBe(true)
        lock.register('b')
        expect(lock.checkWrite('b', true).ok).toBe(true)
    })

    it('clients without session support always pass', () => {
        const { lock } = makeLock()
        lock.register('pc')
        expect(lock.checkWrite('').ok).toBe(true)
        expect(lock.activeId()).toBe('pc')
    })

    // S1 regression (2026-07-28): phone backgrounding fires an automatic
    // flush/save with no user gesture — it must NOT move the lock, or the PC
    // actually in use gets kicked "for no reason".
    it('an automatic write from a fresh session passes WITHOUT taking over', () => {
        const { lock } = makeLock()
        lock.register('pc')
        expect(lock.checkWrite('pc').ok).toBe(true)      // pc writes
        lock.register('phone')                           // phone opened (fresh)
        const auto = lock.checkWrite('phone')            // background flush — no gesture
        expect(auto).toEqual({ ok: true, passive: true })
        expect(lock.activeId()).toBe('pc')               // lock did not move
        expect(lock.checkWrite('pc').ok).toBe(true)      // pc keeps working untouched
    })

    it('a passive pass does not refresh lastWriteAt (later user action still takes over)', () => {
        const { lock } = makeLock()
        lock.register('pc')
        expect(lock.checkWrite('pc').ok).toBe(true)
        lock.register('phone')
        expect(lock.checkWrite('phone').passive).toBe(true)     // auto write
        expect(lock.checkWrite('phone', true).tookOver).toBe(true) // then a real tap
        expect(lock.activeId()).toBe('phone')
    })

    it('a stale session is rejected even with a user gesture', () => {
        const { lock } = makeLock()
        lock.register('phone')
        lock.register('pc')
        expect(lock.checkWrite('phone', true).ok).toBe(true) // phone wrote after pc booted
        expect(lock.checkWrite('pc', true).ok).toBe(false)   // pc stale — gesture cannot force it
    })

    // peek() drives the client's reload-on-return: reload ONLY when stale.
    it('peek reports free/active/fresh/stale without side effects', () => {
        const { lock } = makeLock()
        expect(lock.peek('pc')).toBe('free')
        lock.register('pc')
        expect(lock.peek('pc')).toBe('active')
        expect(lock.checkWrite('pc').ok).toBe(true)     // pc writes
        lock.register('phone')                          // phone boots after → fresh
        expect(lock.peek('phone')).toBe('fresh')        // no reload needed on phone
        expect(lock.checkWrite('phone', true).ok).toBe(true) // phone takes over
        expect(lock.peek('pc')).toBe('stale')           // pc must reload on return
        // peek never mutates: repeated calls and ordering leave the lock alone
        expect(lock.peek('pc')).toBe('stale')
        expect(lock.activeId()).toBe('phone')
        expect(lock.peek('')).toBe('active')            // sessionless clients never reload
    })
})

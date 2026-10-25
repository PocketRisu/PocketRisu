import { describe, it, expect, vi } from 'vitest'
import pkg from './session-lock.cjs'

const { createSessionLock } = pkg as {
    createSessionLock: (opts?: { now?: () => number }) => {
        register: (id: string, missedWrites?: boolean) => void
        checkWrite: (id: string, userActive?: boolean) => { ok: boolean, tookOver?: boolean, passive?: boolean }
        peek: (id: string) => string
        revokeAll: () => void
        claim: (id: string) => boolean
        unclaim: (id: string) => void
        writeStarted: () => void
        writeEnded: () => void
        isIdle: () => boolean
        whenIdle: (timeoutMs: number) => Promise<boolean>
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

    // Reload-loop guard (2026-08-24): a session whose boot registration never
    // reached the server (flaky mobile/VPN link) must not be judged 'stale' —
    // the client would auto-reload on every focus with no way to break out.
    it('peek reports unknown, not stale, for an unregistered session', () => {
        const { lock } = makeLock()
        lock.register('pc')
        expect(lock.checkWrite('pc').ok).toBe(true)     // pc holds the lock
        expect(lock.checkWrite('phone', true).ok).toBe(false) // writes still 423 — data stays safe
        expect(lock.peek('phone')).toBe('unknown')      // phone's register never arrived
        lock.register('phone')                          // registration finally lands
        expect(lock.peek('phone')).toBe('fresh')        // normal judgment resumes
    })

    // After an account import replaced all data, no page loaded before it
    // may write its old copy back, the lock holder included.
    it('revokeAll makes every earlier page stale and lets a new page take over', () => {
        const { lock } = makeLock()
        lock.register('pc')
        lock.register('phone')
        expect(lock.checkWrite('pc').ok).toBe(true)
        lock.revokeAll()
        expect(lock.peek('pc')).toBe('stale')
        expect(lock.checkWrite('pc', true).ok).toBe(false)
        expect(lock.checkWrite('phone', true).ok).toBe(false)
        lock.register('pc-reloaded')
        expect(lock.checkWrite('pc-reloaded')).toEqual({ ok: true, passive: true })
        expect(lock.checkWrite('pc-reloaded', true)).toEqual({ ok: true, tookOver: true })
        expect(lock.activeId()).toBe('pc-reloaded')
    })

    // Reload-loop report (2026-10-25): a home PC tab the launcher opened holds
    // the lock and keeps saving on its own, so the phone is stale again after
    // every reload before its first action can take over.
    it('claim takes the lock from a holder that keeps saving on its own', () => {
        const { lock } = makeLock()
        lock.register('home')
        expect(lock.checkWrite('home').ok).toBe(true)
        lock.register('phone')                                // phone opens…
        expect(lock.checkWrite('home').ok).toBe(true)         // …the unattended tab saves again
        expect(lock.checkWrite('phone', true).ok).toBe(false) // phone is stale → 423
        lock.register('phone')                                // reload: fresh again…
        expect(lock.checkWrite('home').ok).toBe(true)         // …until the next automatic save
        expect(lock.checkWrite('phone', true).ok).toBe(false) // the loop
        lock.claim('phone-next')                              // OK on the dialog, before reloading
        expect(lock.activeId()).toBe('phone-next')
        expect(lock.checkWrite('home').ok).toBe(false)        // the unattended tab is locked out
        expect(lock.checkWrite('home', true).ok).toBe(false)
        lock.register('phone-next')                           // the reload boots with the claimed id
        expect(lock.activeId()).toBe('phone-next')
        expect(lock.checkWrite('phone-next')).toEqual({ ok: true })
    })

    it('the claiming page keeps its old id and stays locked out until it reloads', () => {
        const { lock } = makeLock()
        lock.register('home')
        lock.register('phone')
        expect(lock.checkWrite('home').ok).toBe(true)
        lock.claim('phone-next')
        expect(lock.checkWrite('phone', true).ok).toBe(false) // its outdated copy cannot write
        expect(lock.peek('phone')).toBe('stale')
        expect(lock.peek('phone-next')).toBe('active')
    })

    it('after a claim the normal rules continue: a later page takes over with its first action', () => {
        const { lock } = makeLock()
        lock.register('home')
        lock.claim('phone-next')
        lock.register('phone-next')
        expect(lock.checkWrite('phone-next', true).ok).toBe(true)
        lock.register('pc-room')                              // opened after the phone's last write
        expect(lock.checkWrite('pc-room', true)).toEqual({ ok: true, tookOver: true })
        expect(lock.checkWrite('phone-next', true).ok).toBe(false)
    })

    it('claim ignores an empty id', () => {
        const { lock } = makeLock()
        lock.register('pc')
        expect(lock.claim('')).toBe(false)
        expect(lock.activeId()).toBe('pc')
    })

    // A page that booted with the id loaded its copy before the claim (a tab
    // duplicated while the claim was on its way).
    it('claim refuses an id a page already booted with', () => {
        const { lock } = makeLock()
        lock.register('home')
        lock.register('phone-next')
        expect(lock.checkWrite('home').ok).toBe(true)
        expect(lock.claim('phone-next')).toBe(false)
        expect(lock.activeId()).toBe('home')
    })

    it('reloads under the claimed id keep the lock without claiming again', () => {
        const { lock } = makeLock()
        lock.register('home')
        expect(lock.claim('phone-next')).toBe(true)
        lock.register('phone-next')                           // the reload after the claim
        lock.register('phone-next')                           // F5
        expect(lock.activeId()).toBe('phone-next')
        expect(lock.checkWrite('phone-next')).toEqual({ ok: true })
        expect(lock.claim('phone-next')).toBe(false)          // booted now, so no second claim
        expect(lock.peek('home')).toBe('stale')
    })

    it('an account import after a claim revokes the claimed id too', () => {
        const { lock } = makeLock()
        lock.register('home')
        expect(lock.claim('phone-next')).toBe(true)
        lock.register('phone-next')
        expect(lock.checkWrite('phone-next').ok).toBe(true)
        lock.revokeAll()
        expect(lock.checkWrite('phone-next', true).ok).toBe(false)
        expect(lock.peek('phone-next')).toBe('stale')
    })

    // A page boots only once accepted writes still under way have landed,
    // since it reads its data right after (server.cjs whenSessionWritesIdle).
    it('whenIdle waits until every write under way has ended', async () => {
        const { lock } = makeLock()
        await expect(lock.whenIdle(1000)).resolves.toBe(true) // nothing under way
        lock.writeStarted()
        lock.writeStarted()
        expect(lock.isIdle()).toBe(false)
        let idle: boolean | undefined
        const waiting = lock.whenIdle(1000).then((value) => { idle = value })
        lock.writeEnded()
        await Promise.resolve()
        expect(idle).toBeUndefined()                          // one still under way
        lock.writeEnded()
        await waiting
        expect(idle).toBe(true)
        expect(lock.isIdle()).toBe(true)
        lock.writeEnded()                                     // an extra end never goes below zero
        lock.writeStarted()
        expect(lock.isIdle()).toBe(false)
    })

    it('whenIdle gives up after its timeout', async () => {
        vi.useFakeTimers()
        try {
            const { lock } = makeLock()
            lock.writeStarted()
            const waiting = lock.whenIdle(10_000)
            vi.advanceTimersByTime(10_000)
            await expect(waiting).resolves.toBe(false)
            lock.writeEnded()                                 // a later end does not reach it
            await expect(lock.whenIdle(10_000)).resolves.toBe(true)
        } finally {
            vi.useRealTimers()
        }
    })

    // Its wait ran out: the page may have read the data before those writes
    // landed, so it must not pass as booted after them.
    it('a page registered with missedWrites is stale until it boots again', () => {
        const { lock } = makeLock()
        lock.register('home')
        expect(lock.checkWrite('home').ok).toBe(true)
        lock.register('phone', true)
        expect(lock.peek('phone')).toBe('stale')
        expect(lock.checkWrite('phone', true).ok).toBe(false)
        expect(lock.checkWrite('phone').ok).toBe(false)       // no passive pass either
        lock.register('phone')                                // the reload, once nothing was under way
        expect(lock.peek('phone')).toBe('fresh')
        expect(lock.checkWrite('phone', true)).toEqual({ ok: true, tookOver: true })
    })

    // A reload of the holder's tab, or a tab duplicated from it, boots with
    // the holder's id: being the holder must not let its outdated copy write.
    it('a missedWrites boot under the holder id takes the lock from that id', () => {
        const { lock } = makeLock()
        lock.register('home')
        expect(lock.checkWrite('home').ok).toBe(true)
        lock.register('home', true)
        expect(lock.activeId()).toBe(null)
        expect(lock.peek('home')).toBe('stale')
        expect(lock.checkWrite('home').ok).toBe(false)
        expect(lock.checkWrite('home', true).ok).toBe(false)
        lock.register('home')                                 // reloads once nothing is under way
        expect(lock.checkWrite('home', true)).toEqual({ ok: true, tookOver: true })
    })

    it('a missedWrites boot does not adopt a free lock, not even by writing', () => {
        const { lock } = makeLock()
        lock.register('phone', true)
        expect(lock.activeId()).toBe(null)
        expect(lock.peek('phone')).toBe('stale')
        expect(lock.checkWrite('phone').ok).toBe(false)
        expect(lock.checkWrite('phone', true).ok).toBe(false)
        lock.register('pc')
        expect(lock.activeId()).toBe('pc')
    })

    // A claim the server refused (503) leaves no lock with an id nobody will
    // ever boot with: the holder it replaced gets it back.
    it('unclaim hands the lock back to the holder the claim replaced', () => {
        const { lock } = makeLock()
        lock.register('home')
        expect(lock.checkWrite('home').ok).toBe(true)
        lock.register('phone')
        expect(lock.checkWrite('home').ok).toBe(true)         // phone is stale
        expect(lock.claim('phone-next')).toBe(true)
        expect(lock.checkWrite('home').ok).toBe(false)        // locked out while the claim waits
        lock.unclaim('phone-next')
        expect(lock.activeId()).toBe('home')
        expect(lock.checkWrite('home')).toEqual({ ok: true })
        expect(lock.peek('phone')).toBe('stale')              // the asking page is no better off
        lock.unclaim('phone-next')                            // a second call changes nothing
        expect(lock.activeId()).toBe('home')
    })

    it('unclaim leaves a lock that has moved on since', () => {
        const { lock } = makeLock()
        lock.register('home')
        expect(lock.claim('phone-next')).toBe(true)
        lock.register('pc-room')                              // opened after the claim
        expect(lock.checkWrite('pc-room', true).tookOver).toBe(true)
        lock.unclaim('phone-next')
        expect(lock.activeId()).toBe('pc-room')

        expect(lock.claim('tablet-next')).toBe(true)
        lock.register('tablet-next')                          // the claim completed
        lock.unclaim('tablet-next')
        expect(lock.activeId()).toBe('tablet-next')
    })

    it('unclaim of an earlier claim passes its holder on to a later one', () => {
        const { lock } = makeLock()
        lock.register('home')
        expect(lock.claim('a-next')).toBe(true)
        expect(lock.claim('b-next')).toBe(true)
        lock.unclaim('a-next')                                // b holds: nothing to hand back yet
        expect(lock.activeId()).toBe('b-next')
        lock.unclaim('b-next')
        expect(lock.activeId()).toBe('home')                  // not a-next, which nobody will boot
    })
})

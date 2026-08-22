'use strict';

// Cross-device single-writer session lock.
//
// The app's data model allows exactly one writing client (the in-memory DB is
// synced coarsely — concurrent writers would silently clobber each other).
// This module decides WHICH session holds that write lock, replacing the old
// rule of "the last page load steals it", which produced spurious kicks: a
// phone tab resurrected by the OS (= a page load) would silently take the lock
// from a PC mid-session, and merely glancing at a second device would kick the
// one actually being used.
//
// Rules:
//  - register(id): called at page load. Records the session's boot time but
//    does NOT steal an active lock — opening the app must never kick the
//    device being used. Adopts the lock only when nobody holds it.
//  - checkWrite(id, userActive): called on every data write. The active
//    session passes and refreshes its lastWriteAt. A non-active session takes
//    over IFF BOTH hold:
//      · fresh — it booted AFTER the active session's last accepted write, so
//        its boot loaded the state including that write (cannot clobber), AND
//      · userActive — the client reports a recent user gesture. The app also
//        writes WITHOUT the user doing anything (boot housekeeping, the
//        flush-on-hide keepalive), and an automatic write must never move the
//        lock: a phone tab going to background fires a flush, and that used
//        to steal the lock from the PC actually in use.
//    Fresh but NOT user-active → the write passes WITHOUT taking over (it is
//    fresh, so applying it cannot clobber; rejecting it instead would set off
//    reload loops on boot-time auto-saves). lastWriteAt is not bumped — the
//    lock holder did not write.
//    Stale → rejected (423 → the client reloads; after the reload its boot is
//    recent, so its next user action takes over cleanly).
//
// Serial device switching (the single-user pattern) therefore never shows a
// block: you stop writing on A, open B (booted after A's last write), and B's
// first action takes the lock. A only ever sees a 423 if it writes again
// afterwards — the one genuinely necessary kick.
//
// State is in-memory: a server restart clears it and the first write adopts.
function createSessionLock(opts = {}) {
    const now = opts.now || Date.now;
    const MAX_TRACKED_BOOTS = 50;

    let active = null; // { id, lastWriteAt } | null
    const boots = new Map(); // sessionId -> boot timestamp (insertion-ordered)

    function register(id) {
        if (typeof id !== 'string' || id === '') return;
        // Delete-then-set refreshes insertion order so pruning drops the
        // longest-unseen sessions (bounded memory; single-user scale anyway).
        boots.delete(id);
        boots.set(id, now());
        if (boots.size > MAX_TRACKED_BOOTS) {
            boots.delete(boots.keys().next().value);
        }
        if (!active) {
            active = { id, lastWriteAt: now() };
        }
        // A re-register of the CURRENT active id (same-tab reload / OS tab
        // restore, with the client persisting its id) keeps the lock as-is.
    }

    function checkWrite(id, userActive = false) {
        if (typeof id !== 'string' || id === '') {
            return { ok: true }; // client without session support
        }
        if (!active) {
            active = { id, lastWriteAt: now() };
            return { ok: true };
        }
        if (active.id === id) {
            active.lastWriteAt = now();
            return { ok: true };
        }
        const boot = boots.get(id);
        const fresh = boot !== undefined && boot > active.lastWriteAt;
        if (fresh && userActive) {
            active = { id, lastWriteAt: now() };
            return { ok: true, tookOver: true };
        }
        if (fresh) {
            // Automatic write from a freshly-booted session: apply it, but the
            // lock stays where the user actually is.
            return { ok: true, passive: true };
        }
        return { ok: false };
    }

    function activeId() {
        return active ? active.id : null;
    }

    // Side-effect-free view for the client's reload-on-return check.
    // 'stale' is the only state that requires a reload: another session wrote
    // AFTER this one booted, so this one's in-memory copy is outdated.
    // 'fresh' needs nothing — the copy includes every accepted write, and the
    // next user action simply takes the lock over.
    function peek(id) {
        if (typeof id !== 'string' || id === '') return 'active';
        if (!active) return 'free';
        if (active.id === id) return 'active';
        const boot = boots.get(id);
        if (boot !== undefined && boot > active.lastWriteAt) return 'fresh';
        return 'stale';
    }

    return { register, checkWrite, peek, activeId };
}

module.exports = { createSessionLock };

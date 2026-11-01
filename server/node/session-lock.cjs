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
//    device being used. Adopts the lock only when nobody holds it. The
//    server calls it once accepted writes still under way have ended
//    (isIdle), since the page reads its data right after.
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
//  - claim(id): the user confirmed on a locked-out page that they want to
//    keep working there. Moves the lock at once, without the fresh-boot
//    condition: the holder may be a page nobody is looking at that keeps
//    saving on its own (a home PC tab the launcher opened), and each of its
//    writes would turn the other device stale again before its first action
//    — a 423 → reload loop the gesture takeover alone never escapes.
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
    let running = 0;
    const idleWaiters = new Set();
    const claimedFrom = new Map(); // claimed id -> the holder it replaced

    function register(id, missedWrites = false) {
        if (typeof id !== 'string' || id === '') return;
        // Delete-then-set refreshes insertion order so pruning drops the
        // longest-unseen sessions (bounded memory; single-user scale anyway).
        boots.delete(id);
        claimedFrom.delete(id); // a claim the page now boots with is done
        // 0: booted before every write (see writeStarted).
        boots.set(id, missedWrites ? 0 : now());
        if (boots.size > MAX_TRACKED_BOOTS) {
            boots.delete(boots.keys().next().value);
        }
        if (missedWrites) {
            // Its copy may lack those writes, so it must not write as the
            // holder either: a reload of the holder's tab, or a tab
            // duplicated from it, boots with the holder's id. Nobody holds
            // the lock then, and it does not adopt a free one.
            if (active && active.id === id) revokeAll();
            return;
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
            // A free lock is not for a page whose boot missed writes.
            if (boots.get(id) === 0) return { ok: false };
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

    // After all data was replaced (RisuAI account import): every page loaded
    // before now holds the old data, so all of them become stale, the lock
    // holder included. A page loaded afterwards takes the lock with its first
    // user action.
    function revokeAll() {
        active = { id: null, lastWriteAt: now() };
    }

    // Every page loaded before now becomes stale, the previous holder
    // included. The id is the one the claiming tab boots with AFTER its
    // reload, not its current one: the page that asked still holds its old
    // copy and must stay locked out until the reload loads the latest state.
    // An id that already booted is refused for the same reason: whatever page
    // booted with it loaded its copy before the claim.
    function claim(id) {
        if (typeof id !== 'string' || id === '' || boots.has(id)) return false;
        claimedFrom.set(id, active);
        if (claimedFrom.size > MAX_TRACKED_BOOTS) {
            claimedFrom.delete(claimedFrom.keys().next().value);
        }
        active = { id, lastWriteAt: now() };
        return true;
    }

    // The claim of id was refused after all (server.cjs answers 503 when
    // earlier writes do not land in time): the page keeps its old id, so
    // nothing will ever boot with this one. Hand the lock back to the holder
    // it replaced, unless the lock has moved on since; that holder lost
    // nothing meanwhile, as no write was accepted under an id nobody booted.
    function unclaim(id) {
        if (!claimedFrom.has(id)) return;
        const replaced = claimedFrom.get(id);
        claimedFrom.delete(id);
        if (active && active.id === id) {
            active = replaced;
            return;
        }
        // A later claim replaced this one: it hands back further.
        for (const [later, holder] of claimedFrom) {
            if (holder && holder.id === id) claimedFrom.set(later, replaced);
        }
    }

    // Writes checkWrite accepted whose requests are still under way. Each is
    // stamped when accepted, but it lands later (the body still uploading,
    // the storage queue): a page booting meanwhile would read the state
    // without it and still count as booted after it. So a boot is registered
    // only in a step where isIdle() holds; a page whose wait ran out
    // registers with missedWrites and is stale from the start.
    function writeStarted() {
        running++;
    }
    function writeEnded() {
        if (running > 0) running--;
        if (running === 0) {
            for (const wake of [...idleWaiters]) wake();
        }
    }
    function isIdle() {
        return running === 0;
    }
    // True once nothing is under way, false after timeoutMs. A write can
    // start again before the caller resumes: check isIdle() then. A wait
    // that gives up leaves no waiter behind, since overlapping writes may
    // keep the count above zero for long.
    function whenIdle(timeoutMs) {
        if (running === 0) return Promise.resolve(true);
        return new Promise((resolve) => {
            const wake = () => {
                idleWaiters.delete(wake);
                clearTimeout(timer);
                resolve(true);
            };
            const timer = setTimeout(() => {
                idleWaiters.delete(wake);
                resolve(false);
            }, timeoutMs);
            idleWaiters.add(wake);
        });
    }

    function activeId() {
        return active ? active.id : null;
    }

    // Side-effect-free view for the client's reload-on-return check.
    // 'stale' is the only state that requires a reload: another session wrote
    // AFTER this one booted, so this one's in-memory copy is outdated.
    // 'fresh' needs nothing — the copy includes every accepted write, and the
    // next user action simply takes the lock over.
    // An id with no recorded boot is 'unknown', NOT 'stale': the boot
    // registration is a separate request that can fail alone on a flaky link
    // (mobile + VPN), and judging such a session stale turns every focus into
    // an automatic reload — a reload loop the client cannot break. The write
    // path still 423s a genuinely stale session, so no data is at risk.
    function peek(id) {
        if (typeof id !== 'string' || id === '') return 'active';
        if (!active) return boots.get(id) === 0 ? 'stale' : 'free';
        if (active.id === id) return 'active';
        const boot = boots.get(id);
        if (boot === undefined) return 'unknown';
        if (boot > active.lastWriteAt) return 'fresh';
        return 'stale';
    }

    return { register, checkWrite, peek, revokeAll, claim, unclaim, writeStarted, writeEnded, isIdle, whenIdle, activeId };
}

module.exports = { createSessionLock };

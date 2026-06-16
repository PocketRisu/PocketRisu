import { writable, get } from "svelte/store"

// Request Status Channel — a surface-agnostic store that request producers
// publish to (phase/tokens/badges) and a renderer subscribes to. Decouples the
// request pipeline from how status is shown (sonner toast today, a dedicated
// region tomorrow). See .agent/notes/request-status-toast-infra.md.
//
// Non-persistent, memory only: never touches db/localStorage/.bin.

export type RequestPhase =
    | 'connecting'   // request sent, awaiting first byte
    | 'thinking'     // receiving reasoning
    | 'responding'   // receiving answer body
    | 'retrying'     // fallback / retry
    | 'stalled'      // chunks stopped arriving for a while
    | 'done' | 'failed' | 'aborted'

// Request kind = the chip shown after the phase, so the toast says "what" the
// request is in every state (including done/failed). Maps from the request
// pipeline's ModelModeExtended: model→main, translate→translate, memory→memory,
// emotion→emotion, submodel/otherAx→sub. The renderer maps these to localized
// chip labels (메인 / 번역 / 메모리 / 감정 / 보조).
export type RequestKind = 'main' | 'translate' | 'memory' | 'emotion' | 'sub'

// A phase is terminal when the request has finished one way or another; the
// renderer uses this to decide dismissal/retention.
export function isTerminalPhase(phase: RequestPhase): boolean {
    return phase === 'done' || phase === 'failed' || phase === 'aborted'
}

// Extension point for cache-keeper / web-search / tool badges, etc.
export interface StatusBadge {
    key: string                            // 'cache' | 'grounding' | 'tool' | 'fallback' ...
    text: string
    tone?: 'info' | 'success' | 'warn'
}

export interface RequestStatusEntry {
    id: string                             // per-request key = generationId (issued upstream; we only consume)
    chatId?: string
    kind: RequestKind                      // chip: main / translate / memory / emotion / sub
    label: string                          // model / preset name
    phase: RequestPhase
    thinkingTokens: number
    responseTokens: number
    tokPerSec: number
    startedAt: number
    lastChunkAt: number                    // for stall detection
    endedAt?: number                       // set by endStatus; freezes total elapsed time
    retryAttempt?: number
    badges: StatusBadge[]
    error?: string
    // Accumulated raw text per kind. The render tick tokenizes these with the
    // injected tokenizer (native, language-accurate) — NOT a char/N estimate —
    // once per tick instead of per chunk, so cost stays O(text) per tick rather
    // than O(text) per chunk (which would be O(n²) over a stream). See
    // .agent/notes/request-status-toast-infra.md §8.3.
    thinkingText: string
    responseText: string
    // Marks the texts as changed since the last tokenize so the tick can skip
    // re-tokenizing idle entries.
    textDirty: boolean
    // Sliding-window samples of total token count for tok/s. Trimmed to the
    // window on each recompute; kept on the entry so the timer is stateless.
    tokenSamples: { at: number, tokens: number }[]
}

export const requestStatuses = writable<Map<string, RequestStatusEntry>>(new Map())

// --- tuning ---------------------------------------------------------------

// Injected token counter. request.ts registers the native tokenizer
// (tokenizeNum) here; kept injected so this store stays free of the tokenizer's
// heavy import graph (WASM + getDatabase) and remains unit-testable. When unset
// (e.g. in tests, or before registration) the tick falls back to a rough
// char/4 estimate — accurate for English, but poor for CJK, which is exactly
// why the native counter is preferred at runtime.
let tokenCounter: ((text: string) => Promise<number>) | null = null
export function setStatusTokenCounter(fn: ((text: string) => Promise<number>) | null): void {
    tokenCounter = fn
}
function estimateTokenCount(text: string): number {
    if (!text) return 0
    return Math.max(1, Math.round(text.length / 4))
}

// chunks quiet longer than this → 'stalled' (matches GCK/CPM's ~3s heuristic).
export const STALL_THRESHOLD_MS = 3000
// tok/s averaged over this trailing window (Yumi uses 3s).
export const TOK_PER_SEC_WINDOW_MS = 3000
// how often the render timer recomputes derived fields.
export const STATUS_TICK_MS = 400
// hard cap on a non-terminal entry's lifetime — a request that never ends is
// dropped past this so it can't leak the entry or the render timer. Generous
// (> the 600s fetch timeout) so it never culls a real in-flight request.
export const STATUS_ABANDON_MS = 20 * 60 * 1000

// --- pure helpers (injected clock; unit-testable without real timers) -----

// tok/s from the trailing window: (latest tokens − oldest-in-window tokens) /
// elapsed seconds. Returns 0 until there are two samples spanning real time.
export function computeTokPerSec(
    samples: { at: number, tokens: number }[],
    now: number,
    windowMs: number = TOK_PER_SEC_WINDOW_MS,
): number {
    const cutoff = now - windowMs
    const inWindow = samples.filter((s) => s.at >= cutoff)
    if (inWindow.length < 2) return 0
    const first = inWindow[0]
    const last = inWindow[inWindow.length - 1]
    const elapsedSec = (last.at - first.at) / 1000
    if (elapsedSec <= 0) return 0
    const delta = last.tokens - first.tokens
    if (delta <= 0) return 0
    return delta / elapsedSec
}

// Drop samples older than the window so the array can't grow unbounded on long
// streams. Always keeps the most recent sample so a quiet stream still has a
// reference point.
export function trimSamples(
    samples: { at: number, tokens: number }[],
    now: number,
    windowMs: number = TOK_PER_SEC_WINDOW_MS,
): { at: number, tokens: number }[] {
    const cutoff = now - windowMs
    const trimmed = samples.filter((s) => s.at >= cutoff)
    if (trimmed.length === 0 && samples.length > 0) {
        return [samples[samples.length - 1]]
    }
    return trimmed
}

// Recompute the derived fields (tokPerSec, stalled phase) for one entry given
// the current time. Returns a new entry; never mutates the input. Pure so the
// timer below stays trivial and this is the part covered by tests.
export function recomputeEntry(entry: RequestStatusEntry, now: number): RequestStatusEntry {
    // Terminal entries are frozen — no tok/s decay, no stall flip.
    if (isTerminalPhase(entry.phase)) return entry

    const tokenSamples = trimSamples(entry.tokenSamples, now)
    const tokPerSec = computeTokPerSec(tokenSamples, now)

    let phase = entry.phase
    const quietFor = now - entry.lastChunkAt
    if (quietFor > STALL_THRESHOLD_MS) {
        // Only flip live receiving phases to stalled; connecting/retrying keep
        // their own meaning (no chunk expected yet).
        if (phase === 'thinking' || phase === 'responding') {
            phase = 'stalled'
        }
    }
    return { ...entry, tokenSamples, tokPerSec, phase }
}

// --- publish API (thin, harmless) -----------------------------------------
//
// All publishers are wrapped harmlessly at the call site (try/catch in
// request.ts): status display must never break a request. These helpers are
// no-ops when the id is unknown (except startStatus), so out-of-order or
// duplicate calls can't throw.

function update(id: string, fn: (e: RequestStatusEntry) => RequestStatusEntry): void {
    requestStatuses.update((m) => {
        const cur = m.get(id)
        if (!cur) return m
        const next = new Map(m)
        next.set(id, fn(cur))
        return next
    })
}

export interface StartStatusInit {
    kind: RequestKind
    label: string
    chatId?: string
    phase?: RequestPhase
    now: number
}

export function startStatus(id: string, init: StartStatusInit): void {
    requestStatuses.update((m) => {
        const next = new Map(m)
        next.set(id, {
            id,
            chatId: init.chatId,
            kind: init.kind,
            label: init.label,
            phase: init.phase ?? 'connecting',
            thinkingTokens: 0,
            responseTokens: 0,
            tokPerSec: 0,
            startedAt: init.now,
            lastChunkAt: init.now,
            badges: [],
            thinkingText: '',
            responseText: '',
            textDirty: false,
            tokenSamples: [{ at: init.now, tokens: 0 }],
        })
        return next
    })
    // Self-start the recompute timer; it self-stops once entries go terminal.
    startStatusTimer()
}

export function markPhase(id: string, phase: RequestPhase, now: number): void {
    update(id, (e) => {
        // Don't regress out of a terminal phase.
        if (isTerminalPhase(e.phase)) return e
        const retryAttempt = phase === 'retrying' ? (e.retryAttempt ?? 0) + 1 : e.retryAttempt
        return { ...e, phase, lastChunkAt: now, retryAttempt }
    })
}

// Accumulate raw streamed text per kind. Token COUNTS are not computed here —
// the render tick tokenizes the accumulated text (once per tick, native
// tokenizer) so per-chunk cost is just string concat. tok/s still gets a
// per-chunk sample using the running char estimate so the rate updates
// smoothly between ticks; the tick overwrites the authoritative counts.
export function appendText(
    id: string,
    delta: { thinking?: string, response?: string },
    now: number,
): void {
    update(id, (e) => {
        if (isTerminalPhase(e.phase)) return e
        const thinkingText = e.thinkingText + (delta.thinking ?? '')
        const responseText = e.responseText + (delta.response ?? '')
        const estTotal = estimateTokenCount(thinkingText) + estimateTokenCount(responseText)
        // A chunk arriving means we're live: set the phase from which kind of
        // text it is. Response wins when a delta carries both. This also RECOVERS
        // from 'stalled' (the tick flips live→stalled on a quiet gap; the next
        // chunk flips it back here) — the caller no longer tracks phase itself.
        const phase: RequestPhase = delta.response ? 'responding'
            : delta.thinking ? 'thinking'
            : e.phase
        return {
            ...e,
            phase,
            thinkingText,
            responseText,
            textDirty: true,
            lastChunkAt: now,
            tokenSamples: trimSamples([...e.tokenSamples, { at: now, tokens: estTotal }], now),
        }
    })
}

export function addBadge(id: string, badge: StatusBadge): void {
    update(id, (e) => {
        // Replace a badge with the same key (e.g. cache hit updates its saving).
        const badges = e.badges.filter((b) => b.key !== badge.key).concat(badge)
        return { ...e, badges }
    })
}

export interface EndStatusUsage {
    thinkingTokens?: number
    responseTokens?: number
}

export function endStatus(
    id: string,
    outcome: 'done' | 'failed' | 'aborted',
    opts: { now: number, usage?: EndStatusUsage, error?: string } = { now: 0 },
): void {
    let needFinalCount = false
    update(id, (e) => {
        // Idempotent: a request can end through more than one path (e.g.
        // decoupledStreaming, where the pump's onFinish fires AND the drained
        // stream rethrows into the outer catch). First terminal write wins.
        if (isTerminalPhase(e.phase)) return e
        // Provider usage is authoritative when present (non-streaming paths and
        // streams whose last chunk carried usageMetadata). Otherwise the last
        // per-tick tokenization may be up to one tick stale, so flag a final
        // recount of the accumulated text below.
        needFinalCount = opts.usage?.responseTokens === undefined && (!!e.thinkingText || !!e.responseText)
        return {
            ...e,
            phase: outcome,
            endedAt: opts.now,
            thinkingTokens: opts.usage?.thinkingTokens ?? e.thinkingTokens,
            responseTokens: opts.usage?.responseTokens ?? e.responseTokens,
            error: opts.error ?? e.error,
            tokPerSec: 0,
        }
    })
    if (needFinalCount) void finalRecount(id)
}

// One last native tokenization of the accumulated text after a request ends
// without provider usage, so the frozen final counts are accurate (not up to
// one tick stale). The only token write allowed onto a terminal entry.
async function finalRecount(id: string): Promise<void> {
    const e = get(requestStatuses).get(id)
    if (!e) return
    const thinkingText = e.thinkingText
    const responseText = e.responseText
    try {
        const count = tokenCounter
            ? (text: string) => (text ? tokenCounter!(text) : Promise.resolve(0))
            : (text: string) => Promise.resolve(estimateTokenCount(text))
        const [thinkingTokens, responseTokens] = await Promise.all([
            count(thinkingText),
            count(responseText),
        ])
        update(id, (cur) => {
            // Don't clobber a restarted request (same id reused by a retry): only
            // write if still the same terminal entry with the text we counted.
            if (!isTerminalPhase(cur.phase)) return cur
            if (cur.thinkingText !== thinkingText || cur.responseText !== responseText) return cur
            return { ...cur, thinkingTokens, responseTokens }
        })
    } catch {
        // keep last counts
    }
}

// Remove an entry outright (renderer calls this after the retention window for
// terminal entries; also used to clear aborted/failed immediately if desired).
export function clearStatus(id: string): void {
    requestStatuses.update((m) => {
        if (!m.has(id)) return m
        const next = new Map(m)
        next.delete(id)
        return next
    })
}

// --- render timer ---------------------------------------------------------
//
// A single timer recomputes derived fields for all live entries while any
// exist, instead of recomputing per chunk (mobile jank avoidance — same
// philosophy as STREAM_FLUSH_INTERVAL_MS). It self-stops when the store
// empties and self-starts on the next startStatus, so there's no leak.

let tickTimer: ReturnType<typeof setInterval> | null = null

function hasLiveEntries(m: Map<string, RequestStatusEntry>): boolean {
    for (const e of m.values()) {
        if (!isTerminalPhase(e.phase)) return true
    }
    return false
}

// genIds currently being tokenized, so overlapping ticks don't re-tokenize the
// same entry concurrently (tokenize is async and may outlast a tick interval).
const tokenizing = new Set<string>()

// Re-count tokens for entries whose text changed since the last pass. Async and
// fire-and-forget: failures are swallowed (counts simply keep their last value)
// so tokenization can never disrupt the request or the timer.
async function tokenizeDirty(): Promise<void> {
    const snapshot = get(requestStatuses)
    for (const [id, e] of snapshot) {
        if (!e.textDirty || tokenizing.has(id) || isTerminalPhase(e.phase)) continue
        if (!e.thinkingText && !e.responseText) {
            update(id, (cur) => (cur.textDirty ? { ...cur, textDirty: false } : cur))
            continue
        }
        tokenizing.add(id)
        const thinkingText = e.thinkingText
        const responseText = e.responseText
        try {
            const count = tokenCounter
                ? (text: string) => (text ? tokenCounter!(text) : Promise.resolve(0))
                : (text: string) => Promise.resolve(estimateTokenCount(text))
            const [thinkingTokens, responseTokens] = await Promise.all([
                count(thinkingText),
                count(responseText),
            ])
            update(id, (cur) => {
                // If the request finished while we were tokenizing, endStatus has
                // already written the authoritative usage — don't clobber it.
                if (isTerminalPhase(cur.phase)) return cur
                // Clear dirty only if no new text arrived during tokenization;
                // otherwise leave it set so the next tick re-counts.
                const stillCurrent = cur.thinkingText === thinkingText && cur.responseText === responseText
                return {
                    ...cur,
                    thinkingTokens,
                    responseTokens,
                    textDirty: stillCurrent ? false : cur.textDirty,
                }
            })
        } catch {
            // keep previous counts; leave textDirty so a later tick retries
        } finally {
            tokenizing.delete(id)
        }
    }
}

function tick(): void {
    const now = Date.now()
    let changed = false
    requestStatuses.update((m) => {
        if (m.size === 0) return m
        const next = new Map<string, RequestStatusEntry>()
        for (const [id, e] of m) {
            // Safety net: a request that never ends (no chunk, no finish, no
            // abort — e.g. a promise that never settles) would keep a
            // non-terminal entry alive forever, and with it this 400ms timer.
            // Drop entries that have outlived any realistic request. Normal
            // requests end via endStatus well before this; the fetch timeout
            // (localNetworkTimeoutSec, default 600s) fires the catch path first.
            if (!isTerminalPhase(e.phase) && now - e.startedAt > STATUS_ABANDON_MS) {
                changed = true
                continue // omit from next → removed, timer can stop
            }
            const re = recomputeEntry(e, now)
            if (re !== e) changed = true
            next.set(id, re)
        }
        return changed ? next : m
    })
    // Authoritative token recount (async, off the sync path).
    void tokenizeDirty()
    if (!hasLiveEntries(get(requestStatuses))) {
        stopStatusTimer()
    }
}

export function startStatusTimer(): void {
    if (tickTimer !== null) return
    if (typeof setInterval !== 'function') return
    tickTimer = setInterval(tick, STATUS_TICK_MS)
}

export function stopStatusTimer(): void {
    if (tickTimer !== null) {
        clearInterval(tickTimer)
        tickTimer = null
    }
}

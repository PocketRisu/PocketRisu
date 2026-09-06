import { changeFullscreen, checkNullish, sleep } from "./util"
import { v4 as uuidv4, v4 } from 'uuid';
import { tick } from "svelte";
import { get } from "svelte/store";
import streamSaver from 'streamsaver';
import { setDatabase, type Database, defaultSdDataFunc, getDatabase, appVer, nodeOnlyVer, getCurrentCharacter, loadTogglesFromChat } from "./storage/database.svelte";
import { checkRisuUpdate } from "./update";
import { MobileGUI, botMakerMode, selectedCharID, loadedStore, DBState, LoadingStatusState, selIdState, ReloadGUIPointer, bodyIntercepterStore, loadingOverlayStore, chatDeselected } from "./stores.svelte";
import { recordDbTransferSize } from "./transferSize";
import { loadPlugins } from "./plugins/plugins.svelte";
import { alertConfirm, alertError, alertMd, alertNormalWait, alertSelect, alertTOS, waitAlert, notifySuccess, notifyError, notifyInfo } from "./alert";
import { hasher } from "./parser/parser.svelte";
import { characterURLImport, hubURL } from "./characterCards";
import { defaultJailbreak, defaultMainPrompt, oldJailbreak, oldMainPrompt } from "./storage/defaultPrompts";
import { decodeRisuSave, encodeRisuSaveLegacy, findDangerousChatOps, normalizeJSON, RisuSaveEncoder, RisuSavePatcher, type toSaveType } from "./storage/risuSave";
import { isHydrating, saveChatToServer, ensureChatHydrated, chatToStub, classifyChat, convertStubsToPlaceholders } from "./storage/chatStorage";
import { AutoStorage } from "./storage/autoStorage";
import {
    ConflictError,
    type PersistWarning,
    type AssetManifestDescriptor,
    type AssetManifestOperation,
    type AssetManifestTuple,
} from "./storage/nodeStorage";
import { supportsPatchSync } from "./platform";
import { updateAnimationSpeed } from "./gui/animation";
import { updateColorScheme, updateTextThemeAndCSS } from "./gui/colorscheme";
import { language } from "src/lang";
import { startObserveDom } from "./observer.svelte";
import { updateGuisize } from "./gui/guisize";
import { deepTouch } from "./gui/deepTouch.svelte";
import { pruneHiddenCharacterIds } from "./characterOrder";
import { updateLorebooks, deselectCharacter } from "./characters";
import { mergeServerDbWithTrackedLocalChanges, withTrackedCharacters, hasAmbiguousCharacterIds } from "./storage/rebaseMerge";
import { generationStates, chatGenKey, notifyDatabaseRebased, abortGeneration } from "./process/generationState";

/** A save the server will keep refusing in this state (or one that keeps
 *  conflicting after repeated rebases). Not transient: retrying re-downloads
 *  the whole DB for the same answer, so triggerSave surfaces it at once
 *  instead of feeding it to the generic retry/backoff path. */
export class SaveRejectedError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'SaveRejectedError'
    }
}
import { initMobileGesture } from "./hotkey";
import { moduleUpdate } from "./process/modules";
import { isLocalNetworkUrl } from "./network/localNetwork";
import { decodeProxyJobWsChunk, formatProxyStreamErrorMessage, parseProxyJobWsEvent } from "./network/proxyJobWs";
import {
    createRequestLogScope, recordRequestLog, fetchRequestLogs,
    extractLegacyUsage,
    type RequestLogCategory, type RequestLogSource, type RequestLogRoute,
} from "./requestLog";
import { cacheFullAssetManifest, getCachedFullAssetManifest } from './storage/assetManifestCache';
import { resolveNamesLocally } from './storage/assetNameLocalResolver';
import { createAssetNameResolver, type AssetNameHit } from './storage/assetNameResolver'
import { addLog } from './log'

export const forageStorage = new AutoStorage()

let lastBaselineResyncAt = 0
const BASELINE_RESYNC_MIN_INTERVAL_MS = 5 * 60_000

// One line for the system log: counts and flags first, because the message
// is the dedupe key and gets truncated, so the stable discriminator must
// survive the cut ahead of the (possibly long) id lists.
function summarizeHashMismatch(report: ReturnType<RisuSavePatcher['describeHashMismatch']>): string {
    const keySetDiffs = report.roots.onlyLocal.length + report.roots.onlyRemote.length
        + report.characters.onlyLocal.length + report.characters.onlyRemote.length
    const duplicates = report.duplicateCharIds.length + report.serverDuplicateCharIds.length
    return [
        `roots:${report.roots.mismatched.length} chars:${report.characters.mismatched.length} keyset:${keySetDiffs} dup:${duplicates}`,
        report.compositionOnly ? 'composition-only' : '',
        report.roots.mismatched.length ? `[${report.roots.mismatched.join(',')}]` : '',
        report.characters.mismatched.length ? `[${report.characters.mismatched.join(',')}]` : '',
    ].filter(Boolean).join(' ')
}

function errorMessage(error: unknown): string {
    if (error instanceof Error && error.message) return error.message
    if (typeof error === 'string') return error
    try {
        return JSON.stringify(error) ?? String(error)
    } catch {
        return String(error)
    }
}

export async function loadAssetManifestItems(manifest?: AssetManifestDescriptor): Promise<AssetManifestTuple[]> {
    if (!manifest) return []
    const items = await forageStorage.getAllAssetManifestItems(manifest)
    cacheFullAssetManifest(manifest.id, items)
    return items
}

// One call for character + modules, answers remembered per manifest set —
// see assetNameResolver.ts for why (module names lost to character fuzzy
// matches, and a round trip per parsed message).
//
// Local first: when every referenced manifest is in the full-manifest cache
// (prefetched at chat entry), the names match client-side and the chat
// render path touches no network — the v1.10 behavior. The server route is
// only the cold-cache fallback.
const resolveAssetNamesCached = createAssetNameResolver(async (owners, names, maxDistance) => {
    const local = resolveNamesLocally(owners, names, maxDistance)
    if (local) return local
    return forageStorage.resolveAssetManifestNames(owners, names, maxDistance)
})

// Manifest ids (and descriptor objects — a 404 refresh rewrites the id in
// place mid-load) already being fetched, so overlapping prefetch calls (chat
// entry effect + every parse) never duplicate a download.
const manifestPrefetchesInFlight = new Set<string>()
const manifestDescriptorsInFlight = new WeakSet<AssetManifestDescriptor>()

// Fire-and-forget: warm the full-manifest cache so name resolution and the
// CBS list functions run locally. Ids are content-addressed, so a cached
// manifest is never stale and a fetched one never needs refreshing.
export function prefetchAssetManifests(manifests: Array<AssetManifestDescriptor | undefined>): void {
    for (const manifest of manifests) {
        const id = manifest?.id
        if (!id) continue
        if (getCachedFullAssetManifest(id) || manifestPrefetchesInFlight.has(id) || manifestDescriptorsInFlight.has(manifest)) continue
        manifestPrefetchesInFlight.add(id)
        manifestDescriptorsInFlight.add(manifest)
        void loadAssetManifestItems(manifest)
            .catch((error) => console.warn('[Assets] asset manifest prefetch failed', error))
            .finally(() => {
                manifestPrefetchesInFlight.delete(id)
                manifestDescriptorsInFlight.delete(manifest)
            })
    }
}

export async function resolvePrioritizedAssetManifestNames(
    characterManifest: AssetManifestDescriptor | undefined,
    moduleManifests: AssetManifestDescriptor[],
    names: string[],
    { fuzzy = true }: { fuzzy?: boolean } = {},
): Promise<Record<string, AssetNameHit>> {
    // Start the resolve first: on a cold cache it falls back to the server,
    // and that small POST must enter the connection queue ahead of the
    // manifest page GETs the prefetch is about to fire — first paint is the
    // thing this whole path exists to protect.
    const result = resolveAssetNamesCached(characterManifest, moduleManifests, names, fuzzy, getDatabase().assetMaxDifference ?? 4)
    // Then warm the cache so the next parse resolves locally.
    prefetchAssetManifests([characterManifest, ...moduleManifests])
    return result
}

export async function editAssetManifest(
    manifest: AssetManifestDescriptor,
    operations: AssetManifestOperation[],
): Promise<AssetManifestDescriptor> {
    if (!manifest.ownerKind || !manifest.ownerId) {
        throw new Error('Asset manifest owner information is missing')
    }
    try {
        const descriptor = await forageStorage.editAssetManifest(
            manifest.ownerKind,
            manifest.ownerId,
            manifest.id,
            operations,
        )
        activeSavePatcher?.updateAssetManifestBaseline(manifest.ownerKind, manifest.ownerId, descriptor)
        return descriptor
    } catch (error) {
        if (!(error instanceof ConflictError)) throw error
        const current = (error as ConflictError & { current?: AssetManifestDescriptor }).current
            ?? await forageStorage.getAssetManifestOwner(manifest.ownerKind, manifest.ownerId)
        if (current) {
            const enriched = { ...current, ownerKind: manifest.ownerKind, ownerId: manifest.ownerId }
            Object.assign(manifest, enriched)
            activeSavePatcher?.updateAssetManifestBaseline(manifest.ownerKind, manifest.ownerId, enriched)
        }
        // Asset operations are positional and not generally idempotent. Do not
        // replay automatically: a lost response followed by a 409 could append
        // twice or remove the next tuple. The refreshed descriptor lets the UI
        // reload safely before the user retries the edit.
        throw error
    }
}

export async function appendAssetManifestItems(
    manifest: AssetManifestDescriptor,
    items: AssetManifestTuple[],
): Promise<AssetManifestDescriptor> {
    let current = manifest
    for (let offset = 0; offset < items.length; offset += 1000) {
        current = await editAssetManifest(
            current,
            items.slice(offset, offset + 1000).map((item) => ({ type: 'append' as const, item })),
        )
    }
    return current
}

export function isAssetManifestConflict(error: unknown): error is ConflictError {
    return error instanceof ConflictError
}

export async function recoverAssetManifestConflict(
    error: unknown,
    reload: () => Promise<void>,
): Promise<boolean> {
    if (!isAssetManifestConflict(error)) return false
    notifyError(language.errors.assetManifestConflictTitle, {
        description: language.errors.assetManifestConflictDesc,
        source: 'asset-manifest-conflict',
    })
    await reload()
    return true
}

export async function downloadFile(name: string, dat: Uint8Array | ArrayBuffer | string) {
    if (typeof (dat) === 'string') {
        dat = Buffer.from(dat, 'utf-8')
    }
    const data = new Uint8Array(dat)
    const downloadURL = (data: string, fileName: string) => {
        const a = document.createElement('a')
        a.href = data
        a.download = fileName
        document.body.appendChild(a)
        a.style.display = 'none'
        a.click()
        a.remove()
    }

    const blob = new Blob([data], { type: 'application/octet-stream' })
    const url = URL.createObjectURL(blob)

    downloadURL(url, name)

    setTimeout(() => {
        URL.revokeObjectURL(url)
    }, 10000)
}

let fileCache: {
    origin: string[], res: (Uint8Array | 'loading' | 'done')[]
} = {
    origin: [],
    res: []
}

let pathCache: { [key: string]: string } = {}
let checkedPaths: string[] = []

function buildTimeoutSignal(signal: AbortSignal | undefined, timeoutMs: number | undefined) {
    if (!timeoutMs || timeoutMs <= 0) {
        return {
            signal,
            cleanup: () => {}
        }
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

    if (signal) {
        if (signal.aborted) {
            controller.abort()
        } else {
            signal.addEventListener('abort', () => controller.abort(), { once: true })
        }
    }

    return {
        signal: controller.signal,
        cleanup: () => clearTimeout(timeoutId)
    }
}

/**
 * Gets the source URL of a file.
 * 
 * @param {string} loc - The location of the file.
 * @returns {Promise<string>} - A promise that resolves to the source URL of the file.
 */
export async function getFileSrc(loc: string) {
    // NodeOnly: return a direct server URL instead of fetching + base64-encoding.
    // The browser will cache the response using HTTP Cache-Control headers,
    // so repeated renders (sidebar, chat) cost zero network after first load.
    if ((globalThis as any).__NODE__) {
        return `/api/asset/${Buffer.from(loc, 'utf-8').toString('hex')}`
    }
    try {
        if (usingSw) {
            const encoded = Buffer.from(loc, 'utf-8').toString('hex')
            let ind = fileCache.origin.indexOf(loc)
            if (ind === -1) {
                ind = fileCache.origin.length
                fileCache.origin.push(loc)
                fileCache.res.push('loading')
                try {
                    const hasCache: boolean = (await (await fetch("/sw/check/" + encoded)).json()).able
                    if (hasCache) {
                        fileCache.res[ind] = 'done'
                        return "/sw/img/" + encoded
                    }
                    else {
                        const f: Uint8Array = await forageStorage.getItem(loc) as unknown as Uint8Array
                        await fetch("/sw/register/" + encoded, {
                            method: "POST",
                            body: f as any
                        })
                        fileCache.res[ind] = 'done'
                        await sleep(10)
                    }
                    return "/sw/img/" + encoded
                } catch (error) {

                }
            }
            else {
                const f = fileCache.res[ind]
                if (f === 'loading') {
                    while (fileCache.res[ind] === 'loading') {
                        await sleep(10)
                    }
                }
                return "/sw/img/" + encoded
            }
        }
        else {
            let ind = fileCache.origin.indexOf(loc)
            if (ind === -1) {
                ind = fileCache.origin.length
                fileCache.origin.push(loc)
                fileCache.res.push('loading')
                const f: Uint8Array = await forageStorage.getItem(loc) as unknown as Uint8Array
                fileCache.res[ind] = f
                return `data:image/png;base64,${Buffer.from(f).toString('base64')}`
            }
            else {
                const f = fileCache.res[ind]
                if (f === 'loading') {
                    while (fileCache.res[ind] === 'loading') {
                        await sleep(10)
                    }
                    return `data:image/png;base64,${Buffer.from(fileCache.res[ind]).toString('base64')}`
                }
                return `data:image/png;base64,${Buffer.from(f).toString('base64')}`
            }
        }
    } catch (error) {
        console.error(error)
        return ''
    }
}

/**
 * Reads an image file and returns its data.
 * 
 * @param {string} data - The path to the image file.
 * @returns {Promise<Uint8Array>} - A promise that resolves to the data of the image file.
 */
export async function readImage(data: string) {
    return (await forageStorage.getItem(data) as unknown as Uint8Array)
}

/**
 * Saves an asset file with the given data, custom ID, and file name.
 * 
 * @param {Uint8Array} data - The data of the asset file.
 * @param {string} [customId=''] - The custom ID for the asset file.
 * @param {string} [fileName=''] - The name of the asset file.
 * @returns {Promise<string>} - A promise that resolves to the path of the saved asset file.
 */
export async function saveAsset(data: Uint8Array, customId: string = '', fileName: string = '') {
    let id = ''
    if (customId !== '') {
        id = customId
    }
    else {
        try {
            id = await hasher(data)
        } catch (error) {
            id = uuidv4()
        }
    }
    let fileExtension: string = 'png'
    if (fileName && fileName.split('.').length > 0) {
        fileExtension = fileName.split('.').pop()
    }
    let form = `assets/${id}.${fileExtension}`
    const replacer = await forageStorage.setItem(form, data)
    if (replacer) {
        return replacer
    }
    return form
}

/**
 * Loads an asset file with the given ID.
 * 
 * @param {string} id - The ID of the asset file to load.
 * @returns {Promise<Uint8Array>} - A promise that resolves to the data of the loaded asset file.
 */
export async function loadAsset(id: string) {
    return await forageStorage.getItem(id) as unknown as Uint8Array
}

let lastSave = ''
export let saving = $state({
    state: false
})

/**
 * Saves the current state of the database.
 * 
 * @returns {Promise<void>} - A promise that resolves when the database has been saved.
 */
export let requiresFullEncoderReload = $state({
    state: false
})

let requestImmediateSaveImpl: ((options?: {
    forceFullWrite?: boolean
}) => Promise<void> | void) = () => {}
let patchSyncBaseline: Database | null = null
let activeSavePatcher: RisuSavePatcher | null = null

// Surfaces server-side persist failures (Stage 1 visibility — see issues.md).
// The same failure is re-attached on every patch response until cleared, so we
// dedupe by timestamp to fire one toast per distinct failure event.
let lastShownPersistWarningTs = 0

function showPersistWarningOnce(warning: PersistWarning) {
    if (warning.timestamp <= lastShownPersistWarningTs) return
    lastShownPersistWarningTs = warning.timestamp

    // Stub-flag-loss is the chat-data corruption guard firing at the disk
    // boundary — this means the persist was REFUSED, not that the save was
    // safely re-routed. Show the dedicated "save aborted" toast so the user
    // knows their latest changes may not be on disk yet.
    if (warning.source && warning.source.includes('stub-flag-loss')) {
        showChatGuardPersistAbortToast()
        return
    }

    const sizeStr = warning.attemptedSize != null
        ? ` (${language.errors.persistFailureAttemptedSize} ${(warning.attemptedSize / 1024 / 1024 / 1024).toFixed(2)}GB)`
        : ''
    notifyError(`${language.errors.persistFailureTitle}${sizeStr}`, {
        description: warning.message,
        source: 'persist-failure',
    })
}

// Throttle the client/server-PATCH chat-guard toast — the underlying root
// cause may keep firing every 5s save cycle, and we don't want to spam the
// user. One toast per 5-minute window is enough to surface the situation.
// Guards 2/3 fall through to a safe full-write so the data IS persisted —
// the toast is informational, not actionable.
const CHAT_GUARD_TOAST_INTERVAL_MS = 5 * 60 * 1000
let lastChatGuardToastTs = 0

function showChatGuardToastThrottled(source: 'client' | 'server') {
    const now = Date.now()
    if (now - lastChatGuardToastTs < CHAT_GUARD_TOAST_INTERVAL_MS) return
    lastChatGuardToastTs = now
    notifyError(language.errors.chatGuardTitle, {
        description: `${language.errors.chatGuardDesc} [${source}]`,
        source: 'chat-guard',
    })
}

// Persist-side guard (guard 1) refuses the disk write outright — there is no
// fallback path that recovers this cycle's changes automatically. Use a
// shorter throttle (30s) since this is more severe and actionable: the user
// should be aware before refreshing that their latest changes might not be
// persisted. Each separate persist-failure timestamp on the server gates this
// path via showPersistWarningOnce, so a single corruption won't repeat-toast.
const CHAT_GUARD_PERSIST_TOAST_INTERVAL_MS = 30 * 1000
let lastChatGuardPersistToastTs = 0

// Verbose chat-guard dump is gated behind a localStorage flag so chronic
// root-cause environments (e.g. a still-corrupt v1.4.x install) don't flood
// the console every 5-second save cycle. Toggle with:
//   localStorage.setItem('risu-chat-guard-debug', '1')
const CHAT_GUARD_DEBUG_KEY = 'risu-chat-guard-debug'
function isChatGuardDebugEnabled(): boolean {
    try {
        return typeof localStorage !== 'undefined' && localStorage.getItem(CHAT_GUARD_DEBUG_KEY) === '1'
    } catch {
        return false
    }
}

function showChatGuardPersistAbortToast() {
    const now = Date.now()
    if (now - lastChatGuardPersistToastTs < CHAT_GUARD_PERSIST_TOAST_INTERVAL_MS) return
    lastChatGuardPersistToastTs = now
    notifyError(language.errors.chatGuardPersistTitle, {
        description: language.errors.chatGuardPersistDesc,
        source: 'chat-guard-persist',
    })
}

// Dev-only preview helpers — bypass throttling so the dev panel always shows
// the toast immediately. Mirror the production helpers above so any wording
// or source-tag tweak shows up in the preview without extra synchronization.
export function previewChatGuardToast(variant: 'client' | 'server' | 'server-persist') {
    if (variant === 'server-persist') {
        notifyError(language.errors.chatGuardPersistTitle, {
            description: language.errors.chatGuardPersistDesc,
            source: 'chat-guard-persist',
        })
        return
    }
    notifyError(language.errors.chatGuardTitle, {
        description: `${language.errors.chatGuardDesc} [${variant}]`,
        source: 'chat-guard',
    })
}

export function previewPersistFailureToast() {
    notifyError(`${language.errors.persistFailureTitle} (${language.errors.persistFailureAttemptedSize} 2.10GB)`, {
        description: 'preview: simulated kvSet failure (BLOB size > INT_MAX)',
        source: 'persist-failure',
    })
}

export function requestImmediateSave(options?: {
    forceFullWrite?: boolean
}) {
    return requestImmediateSaveImpl(options)
}

export function setPatchSyncBaseline(data: Database | null) {
    patchSyncBaseline = data ? safeStructuredClone(data) as Database : null
}

export async function saveDb() {
    let changed = false
    let gotChannel = false
    const sessionID = v4()
    let saveInFlight: Promise<void> | null = null
    const knownChatIdsByCharacter = new Map<string, Set<string>>(
        (getDatabase()?.characters ?? [])
            .filter(character => character?.chaId)
            .map(character => [
                character.chaId,
                new Set((character.chats ?? []).map(chat => chat?.id).filter(Boolean)),
            ])
    )
    let channel: BroadcastChannel
    if (window.BroadcastChannel) {
        channel = new BroadcastChannel('risu-db')
    }
    if (channel) {
        channel.onmessage = (ev) => {
            if (ev.data === sessionID) {
                return
            }
            if (!gotChannel) {
                gotChannel = true
                alertNormalWait(language.activeTabChange).then(() => {
                    location.reload()
                })
            }
        }
    }
    // Cross-device single-writer lock: mirrors BroadcastChannel behavior
    // across devices via server-side session check (423 → deactivate).
    // With reload-on-return below, a write actually reaching 423 means TRUE
    // simultaneous use of two devices — rare, and the attempted change cannot
    // be saved — so it stays an explicit blocking modal, never an automatic
    // reload that would eat the user's action without a word.
    window.addEventListener('risu-session-deactivated', () => {
        if (!gotChannel) {
            gotChannel = true
            alertNormalWait(language.activeTabChange).then(() => {
                location.reload()
            })
        }
    })

    // Reload-on-return: while this tab was hidden, another device may have
    // taken the writer lock and changed data. Check the moment the user comes
    // BACK — right then nothing is in progress, so a refresh costs nothing —
    // instead of at the next write, where a 423 would eat the very change
    // being saved. Only 'stale' reloads (the other device actually wrote);
    // 'fresh' means our copy is still current and the next user action simply
    // takes the lock back with no reload at all.
    let lastLockReturnCheck = 0
    const checkWriterLockOnReturn = () => {
        const nowMs = Date.now()
        if (nowMs - lastLockReturnCheck < 5000) return
        lastLockReturnCheck = nowMs
        void (async () => {
            // Dynamic import: process/index.svelte imports this module, so a
            // static import here would be circular. Already loaded → instant.
            const { doingChat } = await import("./process/index.svelte")
            if (get(doingChat)) return // never yank a running generation
            const state = await forageStorage.getWriterLockState()
            if (state !== 'stale') return
            try { sessionStorage.setItem('risu-session-handoff-reload', '1') } catch { /* toast is best-effort */ }
            location.reload()
        })().catch(() => { /* status check failed — do nothing, write path 423 still guards */ })
    }
    window.addEventListener('focus', checkWriterLockOnReturn)
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') checkWriterLockOnReturn()
    })

    // Post-handoff notice from a reload-on-return in the previous page life.
    // Delayed so the toast container is mounted before it fires.
    try {
        if (sessionStorage.getItem('risu-session-handoff-reload')) {
            sessionStorage.removeItem('risu-session-handoff-reload')
            setTimeout(() => notifyInfo(language.sessionHandoffReload), 1500)
        }
    } catch { /* storage unavailable — skip the notice */ }

    const changeTracker: toSaveType = {
        character: [],
        chat: [],
        root: false,
        botPreset: false,
        modules: false,
        plugins: false,
        // Always false: plugin values are in the server kv, not the DB.
        pluginCustomStorage: false
    }

    let encoder = new RisuSaveEncoder()
    await encoder.init(getDatabase(), {
        compression: false
    })

    let patcher = new RisuSavePatcher()
    if (supportsPatchSync) {
        await patcher.init(patchSyncBaseline ?? getDatabase())
        activeSavePatcher = patcher
        patchSyncBaseline = null
    } else {
        activeSavePatcher = null
    }

    function hasTrackedChanges(toSave: toSaveType) {
        return !!(
            toSave.botPreset ||
            toSave.modules ||
            toSave.plugins ||
            toSave.root ||
            toSave.character.length > 0 ||
            toSave.chat.length > 0
        )
    }

    function takeTrackedChanges() {
        const toSave = safeStructuredClone(changeTracker)
        changeTracker.character = changeTracker.character.length === 0 ? [] : [changeTracker.character[0]]
        changeTracker.chat = changeTracker.chat.length === 0 ? [] : [changeTracker.chat[0]]
        changeTracker.root = false
        changeTracker.botPreset = false
        changeTracker.modules = false
        changeTracker.plugins = false
        return toSave
    }

    async function flushServerDbKeepalive() {
        try {
            fetch('/api/db/flush', {
                method: 'POST',
                keepalive: true,
                credentials: 'same-origin'
            }).catch(() => {})
        } catch {
            // ignore best-effort flush failures
        }
    }

    $effect.root(() => {

        let selIdState = $state(0)
        let knownCharacterIds = new Set<string>((getDatabase()?.characters ?? []).map((character) => character?.chaId).filter(Boolean))
        let didInitRootEffect = false
        let didInitBotPresetEffect = false
        let didInitModulesEffect = false
        let didInitPluginsEffect = false
        let didInitGeneralEffect = false
        let trackedActiveChatKey = ''

        const debounceTime = 500; // 500 milliseconds
        let saveTimeout: ReturnType<typeof setTimeout> | null = null;

        selectedCharID.subscribe((v) => {
            selIdState = v
        })

        function saveTimeoutExecute() {
            if (saveTimeout) {
                clearTimeout(saveTimeout);
            }
            saveTimeout = setTimeout(() => {
                changed = true;
            }, debounceTime);
        }

        // Start a best-effort save immediately when the page is hidden/unloaded.
        function flushImmediate() {
            if (saveTimeout) {
                clearTimeout(saveTimeout);
                saveTimeout = null;
            }
            changed = true;
            void triggerSave({
                skipBroadcast: true,
            })
            void flushServerDbKeepalive()
        }
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') flushImmediate();
        });
        window.addEventListener('pagehide', flushImmediate);

        $effect(() => {
            for (const key in DBState.db) {
                if (
                    key !== 'characters' && key !== 'botPresets' && key !== 'modules' &&
                    key !== 'plugins' && key !== 'pluginCustomStorage'
                ) {
                    deepTouch(DBState.db[key])
                }
            }
            if (!didInitRootEffect) {
                didInitRootEffect = true
                return
            }
            changeTracker.root = true
            saveTimeoutExecute()
        })
        $effect(() => {
            DBState.db.botPresetsId
            try { deepTouch(DBState.db.botPresets) } catch (e) {
                console.warn('[Save] deepTouch(botPresets) failed:', e)
                return
            }
            if (!didInitBotPresetEffect) {
                didInitBotPresetEffect = true
                return
            }
            changeTracker.botPreset = true
            saveTimeoutExecute()
        })
        $effect(() => {
            try { deepTouch(DBState.db.modules) } catch (e) {
                console.warn('[Save] deepTouch(modules) failed:', e)
                return
            }
            if (!didInitModulesEffect) {
                didInitModulesEffect = true
                return
            }
            changeTracker.modules = true
            saveTimeoutExecute()
        })
        $effect(() => {
            deepTouch(DBState.db.plugins)
            if (!didInitPluginsEffect) {
                didInitPluginsEffect = true
                return
            }
            changeTracker.plugins = true
            saveTimeoutExecute()
        })
        // No effect for db.pluginCustomStorage: plugin values live in the
        // server kv (pluginStorageStore) and the DB field stays {} forever, so
        // toSave.pluginCustomStorage is always false.
        $effect(() => {
            const currentCharacterIds = (DBState?.db?.characters ?? []).map((character) => character?.chaId).filter(Boolean)
            deepTouch(currentCharacterIds)

            const currentCharacterIdSet = new Set<string>(currentCharacterIds)
            for (const previousCharacterId of knownCharacterIds) {
                if (!currentCharacterIdSet.has(previousCharacterId)) {
                    changeTracker.character = [previousCharacterId, ...changeTracker.character.filter((v) => v !== previousCharacterId)]
                }
            }
            knownCharacterIds = currentCharacterIdSet

            if (DBState?.db?.characters?.[selIdState]) {
                for (const key in DBState.db.characters[selIdState]) {
                    // Exclude chats — chat changes are tracked via chat-specific server save, not database.bin
                    if (key !== 'chats') {
                        deepTouch(DBState.db.characters[selIdState][key])
                    }
                }
                // Track stub metadata and chat ordering for database.bin persistence.
                deepTouch(DBState.db.characters[selIdState].chats.map(c => ({
                    id: c.id,
                    name: c.name,
                    lastDate: c.lastDate,
                    folderId: c.folderId,
                })))
                if (changeTracker.character[0] !== DBState.db.characters[selIdState]?.chaId) {
                    changeTracker.character.unshift(DBState.db.characters[selIdState]?.chaId)
                }
            }
            if (!didInitGeneralEffect) {
                didInitGeneralEffect = true
                changeTracker.character = []
                changeTracker.chat = []
                return
            }
            saveTimeoutExecute()
        })
        $effect(() => {
            const activeChar = DBState?.db?.characters?.[selIdState]
            const activeChat = activeChar?.chats?.[activeChar?.chatPage]
            if (activeChat) {
                deepTouch(activeChat)
            }

            const activeChaId = activeChar?.chaId ?? ''
            const activeChatId = activeChat?.id ?? ''
            const activeKey = activeChaId && activeChatId ? `${activeChaId}|${activeChatId}` : ''

            if (!activeKey) {
                trackedActiveChatKey = ''
                return
            }

            // Selecting a different chat establishes a new baseline; only later edits are dirty.
            if (trackedActiveChatKey !== activeKey) {
                trackedActiveChatKey = activeKey
                return
            }

            if (isHydrating(activeChaId, activeChatId)) {
                return
            }

            if (
                changeTracker.chat[0]?.[0] !== activeChaId ||
                changeTracker.chat[0]?.[1] !== activeChatId
            ) {
                changeTracker.chat.unshift([activeChaId, activeChatId])
            }
            saveTimeoutExecute()
        })
    })

    function requeueTrackedChanges(toSave: toSaveType) {
        changeTracker.character = [...new Set([...toSave.character, ...changeTracker.character])]
        const chatSeen = new Set<string>()
        changeTracker.chat = [...toSave.chat, ...changeTracker.chat].filter((chatPair) => {
            const key = `${chatPair?.[0] ?? ''}|${chatPair?.[1] ?? ''}`
            if (chatSeen.has(key)) {
                return false
            }
            chatSeen.add(key)
            return true
        })
        changeTracker.botPreset = changeTracker.botPreset || toSave.botPreset
        changeTracker.modules = changeTracker.modules || toSave.modules
        changeTracker.plugins = changeTracker.plugins || toSave.plugins
        changeTracker.root = changeTracker.root || toSave.root
    }

    function collectChatsToPersist(db: Database, toSave: toSaveType): [string, string][] {
        const chatsToPersist: [string, string][] = []
        const seen = new Set<string>()
        const pushChat = (chaId: string, chatId: string) => {
            if (!chaId || !chatId) return
            const key = `${chaId}|${chatId}`
            if (seen.has(key)) return
            seen.add(key)
            chatsToPersist.push([chaId, chatId])
        }

        for (const [chaId, chatId] of toSave.chat) {
            pushChat(chaId, chatId)
        }

        for (const chaId of toSave.character) {
            const char = db.characters.find(c => c?.chaId === chaId)
            if (!char) continue
            const knownChatIds = knownChatIdsByCharacter.get(chaId) ?? new Set<string>()
            for (const chat of char.chats ?? []) {
                if (!chat?.id || chat._placeholder) continue
                if (!knownChatIds.has(chat.id)) {
                    pushChat(chaId, chat.id)
                }
            }
        }

        return chatsToPersist
    }

    function updateKnownChatsAfterSuccessfulSave(db: Database, toSave: toSaveType) {
        for (const chaId of toSave.character) {
            const char = db.characters.find(c => c?.chaId === chaId)
            if (!char) {
                knownChatIdsByCharacter.delete(chaId)
                continue
            }
            knownChatIdsByCharacter.set(
                chaId,
                new Set((char.chats ?? []).map(chat => chat?.id).filter(Boolean))
            )
        }

        for (const [chaId, chatId] of toSave.chat) {
            if (!chaId || !chatId) continue
            const knownChatIds = knownChatIdsByCharacter.get(chaId) ?? new Set<string>()
            knownChatIds.add(chatId)
            knownChatIdsByCharacter.set(chaId, knownChatIds)
        }
    }

    // After a full write the patcher was re-seeded from the bytes we sent,
    // while the server holds its own client view of the same data (chats
    // stubbed, asset lists as manifest descriptors, normalized). If the two
    // differ, every patch from here on 409s and falls back to a full write —
    // the "every save uploads the whole database" loop. The write response
    // carries the server view's hashes: on a difference, name it in the
    // system log and re-seed the patcher from the server view, but only when
    // nobody else wrote in between (the read must return the etag we wrote).
    async function resyncBaselineAfterFullWrite() {
        const diagnostics = forageStorage.realStorage?.takeDbWriteDiagnostics?.()
        if (!diagnostics?.serverHash) return
        let report: ReturnType<RisuSavePatcher['describeHashMismatch']>
        try {
            report = patcher.describeHashMismatch(diagnostics)
        } catch (e) {
            console.warn('[Save] Failed to compare baseline after full write:', e)
            return
        }
        if (report.localHash === report.serverHash) return
        console.warn('[Save] Baseline differs from server view after full write:', report)
        addLog({
            level: 'warning',
            source: 'save',
            message: `[Save] Baseline differs from server after full write: ${summarizeHashMismatch(report)}`.slice(0, 300),
            description: JSON.stringify(report),
        })
        const writtenEtag = forageStorage.getDbEtag()
        if (!writtenEtag) return
        // A divergence the re-seed cannot cure would otherwise cost a full
        // download on every full write; one attempt per interval keeps the
        // diagnostic and caps the traffic.
        if (Date.now() - lastBaselineResyncAt < BASELINE_RESYNC_MIN_INTERVAL_MS) {
            console.warn('[Save] Skipped baseline re-seed: one succeeded recently and the divergence persists')
            return
        }
        try {
            const serverBytes = await forageStorage.getItem('database/database.bin') as unknown as Uint8Array
            const readEtag = forageStorage.getDbEtag()
            if (!serverBytes || serverBytes.length === 0 || readEtag !== writtenEtag) {
                // Someone else wrote meanwhile (or the read did not match the
                // write byte for byte). Keep the etag we wrote so the next
                // full write still runs into the conflict path instead of
                // silently overwriting theirs.
                forageStorage.setDbEtag(writtenEtag)
                console.warn('[Save] Skipped baseline re-seed: server etag moved since the full write')
                return
            }
            await patcher.init(await decodeRisuSave(serverBytes))
            // Stamped only on success: a transient failure must retry on
            // the next full write, while a divergence the re-seed cannot
            // cure is capped to one download per interval.
            lastBaselineResyncAt = Date.now()
            addLog({ level: 'info', source: 'save', message: '[Save] Baseline re-seeded from the server view after a full write' })
        } catch (e) {
            forageStorage.setDbEtag(writtenEtag)
            console.warn('[Save] Baseline re-seed failed:', e)
        }
    }

    // chaIds with a generation in flight. Their local chat object holds the
    // reply as it streams in; a rebase that rebuilt them from the server's
    // stubs would swap in an empty placeholder and strand the partial reply.
    function generatingCharacters(db: Database): Map<string, string[]> {
        const live = get(generationStates)
        const byChar = new Map<string, string[]>()
        if (live.size === 0) return byChar
        for (const char of Array.isArray(db.characters) ? db.characters : []) {
            if (!char?.chaId || !Array.isArray(char.chats)) continue
            const keys = char.chats.map((chat: any) => chatGenKey(chat?.id)).filter((key: string) => live.has(key))
            if (keys.length > 0) byChar.set(char.chaId, keys)
        }
        return byChar
    }

    // Abort the generations under these keys and wait for their entries to
    // clear (the send pipeline ends its entry on every exit path), bounded so
    // a stuck send cannot block saving. Returns whether all of them ended.
    async function abortGenerationsAndWait(keys: string[], timeoutMs: number): Promise<boolean> {
        for (const key of keys) abortGeneration(key)
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
            const live = get(generationStates)
            if (!keys.some((key) => live.has(key))) return true
            await sleep(50)
        }
        return false
    }

    async function rebaseTrackedLocalChangesOnLatestServerDb(
        conflictEtag: string | null, db: Database, toSave: toSaveType, syncedArchivedIds: ReadonlySet<string>,
        syncedBaselineDb: Database | null,
    ) {
        const etagBeforeRebase = forageStorage.getDbEtag()
        forageStorage.setDbEtag(conflictEtag ?? null)
        const latestData = await forageStorage.getItem('database/database.bin') as unknown as Uint8Array
        if (latestData && latestData.length > 0) {
            const latestDb = await decodeRisuSave(latestData) as Database
            const selectedChaId = getCurrentCharacter()?.chaId
            const localNames = new Map<string, string>(
                (Array.isArray(db.characters) ? db.characters : [])
                    .filter((char) => char?.chaId)
                    .map((char) => [char.chaId, char.name || char.chaId] as [string, string]),
            )
            const generating = generatingCharacters(db)
            toSave = withTrackedCharacters(toSave, [...generating.keys()])
            const { mergedDb, skippedArchivedCharIds } = mergeServerDbWithTrackedLocalChanges(
                latestDb, db, toSave, safeStructuredClone, convertStubsToPlaceholders, syncedArchivedIds, syncedBaselineDb, normalizeJSON,
            )
            // A character deactivated elsewhere while a generation streams into
            // it has no slot in the merged DB. The send pipeline addresses its
            // target by index into DBState.db, so end those generations first
            // and only then swap the database: every write they still make
            // lands in the old object, which is discarded whole.
            const generatingSkippedKeys = skippedArchivedCharIds.flatMap((chaId) => generating.get(chaId) ?? [])
            if (generatingSkippedKeys.length > 0) {
                console.warn('[Save] Aborting generations for characters deactivated elsewhere before rebase:', skippedArchivedCharIds)
                if (!await abortGenerationsAndWait(generatingSkippedKeys, 5000)) {
                    // Swapping now would let the still-running send write
                    // through its stale indices into the new database. Give
                    // up on this attempt instead: the changes are requeued by
                    // triggerSave's error path and the next attempt rebases
                    // again once the generation has ended. The patcher's
                    // baseline already advanced to this attempt's local state,
                    // so restore the pre-rebase etag: the retry's patch then
                    // 409s with the server's (foreign) etag and takes this
                    // rebase path again, rather than the full-write fallback
                    // an equal etag would select.
                    forageStorage.setDbEtag(etagBeforeRebase)
                    // And the patcher itself: its baseline advanced to this
                    // attempt's local state in set(), which would make the
                    // retry's rebase read every local root edit as
                    // "unchanged since sync" and drop it. Re-seed from the
                    // pre-attempt baseline so the retry repeats this attempt.
                    if (supportsPatchSync && syncedBaselineDb) {
                        patcher = new RisuSavePatcher()
                        await patcher.init(syncedBaselineDb)
                        activeSavePatcher = patcher
                    }
                    requeueTrackedChanges(toSave)
                    throw new Error('Rebase deferred: a generation for a character deactivated elsewhere has not ended yet')
                }
            }
            setDatabase(mergedDb)
            // selectedCharID is an index into db.characters; the merged array
            // follows the server's order and may have gained or lost entries,
            // so re-point it at the same character (or clear it if gone).
            if (selectedChaId && !skippedArchivedCharIds.includes(selectedChaId)) {
                const idx = (mergedDb.characters ?? []).findIndex((char) => char?.chaId === selectedChaId)
                if (idx === -1) {
                    deselectCharacter()
                } else if (idx !== get(selectedCharID)) {
                    selectedCharID.set(idx)
                }
            }
            // A send streaming into the old database object addresses it by
            // captured indices; let it re-resolve them against the new one.
            notifyDatabaseRebased()
            if (skippedArchivedCharIds.length > 0) {
                // Deactivated on another device while this one still held
                // edits for them; the edits were dropped (see rebaseMerge).
                const names = skippedArchivedCharIds.map((chaId) => localNames.get(chaId) ?? chaId).join(', ')
                console.warn('[Save] Dropped local edits to characters deactivated elsewhere:', skippedArchivedCharIds)
                addLog({
                    level: 'warning',
                    source: 'save',
                    message: '[Save] Dropped local edits to characters deactivated on another device',
                    description: skippedArchivedCharIds.join(', '),
                })
                notifyError(language.rebaseSkippedArchived(names))
                if (selectedChaId && skippedArchivedCharIds.includes(selectedChaId)) {
                    deselectCharacter()
                }
            }

            encoder = new RisuSaveEncoder()
            await encoder.init(getDatabase(), {
                compression: false
            })
            if (supportsPatchSync) {
                // Seed from the server's view, not the merged result: the
                // retry then sends the overlaid local changes as a patch
                // instead of an empty patch that 409s into a full write.
                patcher = new RisuSavePatcher()
                await patcher.init(latestDb)
                activeSavePatcher = patcher
            }
        }
        requeueTrackedChanges(toSave)
        changed = true
    }

    async function persistTrackedChanges(
        toSave: toSaveType,
        options?: {
            forceFullWrite?: boolean
            skipBroadcast?: boolean
        }
    ): Promise<'saved' | 'retry' | 'noop'> {
        if (gotChannel) {
            // Data is saved in another tab.
            await sleep(1000)
            return 'noop'
        }
        if (channel && !options?.skipBroadcast) {
            channel.postMessage(sessionID)
        }

        const db = getDatabase()
        if (!db.characters) {
            await sleep(1000)
            return 'noop'
        }

        // ── Save changed chat content to server ─────────────────────────
        const failedChats: { chaId: string, chatId: string, message: string }[] = []
        for (const [chaId, chatId] of collectChatsToPersist(db, toSave)) {
            const char = db.characters.find(c => c.chaId === chaId)
            if (!char) continue
            const chatIndex = char.chats.findIndex(c => c.id === chatId)
            if (chatIndex === -1) continue
            const chat = char.chats[chatIndex]
            // Skip placeholders — they have no real data to save
            if (!chat || chat._placeholder) continue
            try {
                await saveChatToServer(chaId, chatIndex, chatId, chat)
            } catch (e) {
                console.error(`[Save] Failed to save chat ${chaId}/${chatId}:`, e)
                failedChats.push({ chaId, chatId, message: errorMessage(e) })
            }
        }
        if (failedChats.length > 0) {
            throw new Error(
                `Failed to save ${failedChats.length} chat${failedChats.length === 1 ? '' : 's'}: ${failedChats[0].message}`
            )
        }

        // ── database.bin: exclude chat payload (stubs only via encoder) ──
        await encoder.set(db, safeStructuredClone(toSave))
        const encoded = encoder.encode()
        if (!encoded) {
            await sleep(1000)
            return 'noop'
        }
        const dbData = new Uint8Array(encoded)
        recordDbTransferSize(dbData.byteLength, 'save')

        let saved = false
        let newEtag: string | undefined
        // Characters the patcher saw change by hash in this attempt, so a
        // rebase overlays every edited character, not only the tracked ones.
        let attemptedChangedCharIds: string[] = []
        // Decided in the same tick as the ids above: rebase attributes edits
        // by chaId, so with a missing or repeated one the pre-existing
        // behaviour (full write, plain rebase) is kept for this save.
        let attemptedIdsAmbiguous = false
        // The deactivated list as of the last sync, read BEFORE set() below
        // advances the patcher's baseline to this attempt's local state; a
        // rebase classifies in-flight (de)activations against it.
        let syncedArchivedIds: ReadonlySet<string> = new Set()
        // Same baseline, whole: a rebase copies a root key from local only
        // when it differs from this. null (non-patch mode) = local wins.
        let syncedBaselineDb: Database | null = null

        if (supportsPatchSync && !options?.forceFullWrite) {
            syncedArchivedIds = patcher.baselineArchivedCharacterIds()
            syncedBaselineDb = patcher.baselineDb()
            const patchData = await patcher.set(db, safeStructuredClone(toSave))
            attemptedChangedCharIds = patcher.changedCharacterIdsOfLastSet()
            attemptedIdsAmbiguous = hasAmbiguousCharacterIds(db.characters ?? [])
            // Refuse to send patches that would corrupt server-side lazy chats.
            // chatToStub strips chats to metadata before diffing, so the only
            // way these ops appear is a baseline desync. Falling through to a
            // full write rebuilds the server's stub view from scratch and
            // resyncs the patcher baseline. The console.error is the primary
            // breadcrumb for tracking down the unknown root cause.
            const dangerous = findDangerousChatOps(patchData.patch)
            if (dangerous.length > 0) {
                // Always log a one-line summary so production environments
                // see enough to file a bug report. The rich dump below is
                // gated behind a localStorage flag — chronic loops would
                // otherwise dump 5 console.errors every 5s save cycle.
                const sampleOps = dangerous.slice(0, 3).map(d => `${d.op} ${d.path}`).join(', ')
                console.error(
                    `[Save] Patcher emitted ${dangerous.length} chat-internal field op(s) — `
                    + `falling back to full write. sample: ${sampleOps}`
                    + ` (verbose dump: localStorage.setItem('${CHAT_GUARD_DEBUG_KEY}', '1') then reproduce)`
                )
                showChatGuardToastThrottled('client')

                if (isChatGuardDebugEnabled()) {
                // ── Diagnostic dump for unknown root cause ────────────────
                // chatToStub is supposed to strip every chat down to 6
                // metadata fields before the diff. If non-stub fields end
                // up in patch ops, something slipped past it. Dump enough
                // shape info to figure out which side of the diff carries
                // the contraband (baseline vs current) and what flags the
                // chat object has.
                const affectedChats: Record<string, any> = {}
                const seen = new Set<string>()
                const baselineCharsLen = (patcher as any).lastSyncedDb?.characters?.length ?? -1
                const currentCharsLen = db.characters?.length ?? -1

                const summarize = (c: any) => {
                    if (c == null) return null
                    const keys = Object.keys(c)
                    // Per-key shape: which fields are strings vs arrays vs objects vs primitives
                    const keyShapes: Record<string, string> = {}
                    for (const k of keys) {
                        const v = c[k]
                        if (v === null) keyShapes[k] = 'null'
                        else if (Array.isArray(v)) keyShapes[k] = `Array(${v.length})`
                        else if (typeof v === 'object') keyShapes[k] = `Object(${Object.keys(v).length})`
                        else keyShapes[k] = `${typeof v}=${typeof v === 'string' && v.length > 30 ? v.slice(0, 30) + '…' : JSON.stringify(v)}`
                    }
                    return {
                        keys,                                  // full key list, not just length
                        keyShapes,                             // per-key type/preview
                        classification: classifyChat(c),
                        _stub: c._stub,
                        _placeholder: c._placeholder,
                        hasMessage: Array.isArray(c.message),
                        messageLen: Array.isArray(c.message) ? c.message.length : null,
                        id: c.id,
                        name: c.name,
                        // Type fingerprints help identify Svelte $state proxies
                        // or other wrapper objects that might bypass deep clone.
                        ctor: c?.constructor?.name,
                        isFrozen: Object.isFrozen(c),
                        isProxy: typeof c === 'object' && c !== null && (c as any)?.[Symbol.toStringTag] !== undefined,
                    }
                }

                // Re-run chatToStub on the current chat to see what the patcher
                // would have produced. If this still has non-stub fields, the
                // bug is INSIDE chatToStub's isChatStub short-circuit (chat
                // already has `_stub: true` but isn't actually a stub).
                const stubReplay = (c: any) => {
                    if (c == null) return null
                    try {
                        const result = chatToStub(c)
                        return summarize(result)
                    } catch (e) {
                        return { error: String(e) }
                    }
                }

                for (const op of dangerous) {
                    const m = op.path.match(/^\/characters\/(\d+)\/chats\/(\d+)\//)
                    if (!m) continue
                    const key = `${m[1]}/${m[2]}`
                    if (seen.has(key)) continue
                    seen.add(key)
                    if (seen.size > 5) break
                    const ci = +m[1], chi = +m[2]
                    const baselineChar = (patcher as any).lastSyncedDb?.characters?.[ci]
                    const currentChar = db.characters?.[ci]
                    const baselineChat = baselineChar?.chats?.[chi]
                    const currentChat = currentChar?.chats?.[chi]
                    const opsForThisChat = dangerous.filter(d => d.path.startsWith(`/characters/${ci}/chats/${chi}/`))
                    // Reference identity: same object? same chats array? same chat slot?
                    const refIdentity = {
                        sameCharacter: baselineChar === currentChar,
                        sameChatsArray: baselineChar?.chats === currentChar?.chats,
                        sameChatSlot: baselineChat === currentChat,
                    }
                    affectedChats[key] = {
                        characterContext: {
                            baselineChaId: baselineChar?.chaId,
                            currentChaId: currentChar?.chaId,
                            chaIdsMatch: baselineChar?.chaId === currentChar?.chaId,
                            baselineChatsLen: baselineChar?.chats?.length ?? -1,
                            currentChatsLen: currentChar?.chats?.length ?? -1,
                            refIdentity,
                        },
                        baselineChat: summarize(baselineChat),
                        currentChat: summarize(currentChat),
                        // The crucial diagnostic: if this still leaks message etc,
                        // chatToStub's isChatStub fast-path was the offender.
                        currentAfterChatToStub: stubReplay(currentChat),
                        baselineAfterChatToStub: stubReplay(baselineChat),
                        opsForThisChat,
                    }
                }

                // Distribution of stub/placeholder flags across the affected
                // characters' chats — useful to spot wholesale corruption
                // (e.g. a plugin replacing the entire chats array with
                // _stub-tagged objects).
                const charsDistribution: Record<string, any> = {}
                for (const k of Array.from(seen).slice(0, 3)) {
                    const ci = +k.split('/')[0]
                    const baselineChats = (patcher as any).lastSyncedDb?.characters?.[ci]?.chats ?? []
                    const currentChats = db.characters?.[ci]?.chats ?? []
                    const tally = (chats: any[]) => {
                        const t = { total: chats.length, stub: 0, placeholder: 0, hybrid: 0, full: 0, neither: 0 }
                        for (const c of chats) {
                            if (!c) continue
                            const isStub = c._stub === true
                            const isPh = c._placeholder === true
                            const hasMsg = Array.isArray(c.message)
                            if (isStub && hasMsg) t.hybrid++
                            else if (isStub) t.stub++
                            else if (isPh) t.placeholder++
                            else if (hasMsg) t.full++
                            else t.neither++
                        }
                        return t
                    }
                    charsDistribution[`character[${ci}]`] = {
                        baseline: tally(baselineChats),
                        current: tally(currentChats),
                    }
                }

                let activeCharID = -1
                try { selectedCharID.subscribe(v => { activeCharID = v })() } catch {}
                console.error('[Save:guard-debug] context:', {
                    baselineCharsLen,
                    currentCharsLen,
                    selectedCharID: activeCharID,
                    totalDangerousOps: dangerous.length,
                    uniqueAffectedChats: seen.size,
                })
                console.error('[Save:guard-debug] all dangerous ops:', dangerous)
                console.error('[Save:guard-debug] affected chats (baseline / current / stubReplay):', affectedChats)
                console.error('[Save:guard-debug] chats[] distribution per affected character:', charsDistribution)
                }
                // Leave saved=false so the full-write path below kicks in.
            } else {
                // The revision this client last synced against, read before
                // the patch: a 409 returns the server's current etag, which
                // is adopted only on success — adopting it on failure would
                // let the full-write fallback pass x-if-match over another
                // device's write.
                const syncedEtag = forageStorage.getDbEtag()
                const patchResult = await forageStorage.patchItem('database/database.bin', patchData)
                saved = patchResult.success
                if (patchResult.success && patchResult.etag) {
                    newEtag = patchResult.etag
                    forageStorage.setDbEtag(patchResult.etag)
                }
                if (patchResult.persistWarning) {
                    showPersistWarningOnce(patchResult.persistWarning)
                }
                // Server's chat-internal-field guard rejected the patch — the
                // client-side guard above missed this case. Surface to user
                // and continue to the conflict handling below (rebase or full write).
                if (patchResult.chatGuardRejected) {
                    console.error('[Save] Server rejected patch — chat-internal field ops detected server-side')
                    showChatGuardToastThrottled('server')
                }
                // Hash mismatch: name the diverged keys so a repeated
                // conflict (every save falling through to a full write)
                // can be traced from the system log instead of only
                // "expected≠server" on the server console.
                if (!patchResult.success && patchResult.hashDiagnostics) {
                    try {
                        const report = patcher.describeHashMismatch(patchResult.hashDiagnostics)
                        console.warn('[Save] Patch hash mismatch, diverged keys:', report)
                        addLog({
                            level: 'warning',
                            source: 'save',
                            message: `[Save] Patch hash mismatch: ${summarizeHashMismatch(report)}`.slice(0, 300),
                            description: JSON.stringify(report),
                        })
                    } catch (e) {
                        console.warn('[Save] Failed to describe patch hash mismatch:', e)
                    }
                } else if (!patchResult.success && patchResult.conflictCode && !patchResult.chatGuardRejected) {
                    // Any other server guard (asset manifest, deactivated
                    // character): say which, or the fallback below hides it.
                    console.warn('[Save] Patch rejected by server:', patchResult.conflictCode, patchResult.conflictError ?? '')
                    addLog({
                        level: 'warning',
                        source: 'save',
                        message: `[Save] Patch rejected: ${patchResult.conflictCode}`,
                        description: patchResult.conflictError,
                    })
                    if (patchResult.conflictCode === 'ARCHIVE_GUARD_REJECTED' && patchResult.etag === syncedEtag) {
                        // Our own revision was refused for an invalid
                        // deactivation state (e.g. a character returned from
                        // the archive without /activate after a server
                        // restart). A full write or rebase would only replay
                        // the same state; surface it through the error path
                        // instead of cycling.
                        throw new SaveRejectedError(patchResult.conflictError ?? 'Save rejected: deactivated-character state is inconsistent')
                    }
                }
                if (!patchResult.success && patchResult.etag && patchResult.etag !== syncedEtag && attemptedIdsAmbiguous) {
                    // Rebase attributes edits by chaId; with a missing or
                    // repeated one the hash-detected widening could misplace
                    // an edit, so rebase with the tracked list only (the
                    // pre-existing conflict behaviour) and retry.
                    console.warn('[Save] Foreign revision conflict with ambiguous character ids, rebasing tracked changes only...')
                    await rebaseTrackedLocalChangesOnLatestServerDb(patchResult.etag, db, toSave, syncedArchivedIds, syncedBaselineDb)
                    await sleep(Math.min(500 * (savetrys + 1), 3000))
                    return 'retry'
                } else if (!patchResult.success && patchResult.etag && patchResult.etag !== syncedEtag) {
                    // The server's revision is not the one this client last
                    // synced against: someone else wrote in between. A full
                    // write would pass x-if-match with the server's etag and
                    // silently overwrite their changes, so merge theirs first
                    // (the same path a full-write 409 takes) and retry.
                    console.warn('[Save] Patch conflict with a foreign revision, rebasing tracked local changes on latest server DB...')
                    await rebaseTrackedLocalChangesOnLatestServerDb(
                        patchResult.etag, db, withTrackedCharacters(toSave, attemptedChangedCharIds), syncedArchivedIds, syncedBaselineDb,
                    )
                    await sleep(Math.min(500 * (savetrys + 1), 3000))
                    return 'retry'
                }
            }
        }
        if (!saved) {
            if (supportsPatchSync && !options?.forceFullWrite) {
                console.warn('[Save] Patch conflict, falling through to full write...')
            }
            const currentEtag = forageStorage.getDbEtag()
            try {
                await forageStorage.setItem('database/database.bin', dbData, currentEtag ?? undefined)
            } catch (conflictErr) {
                if (conflictErr instanceof ConflictError) {
                    if (conflictErr.code === 'ARCHIVE_GUARD_REJECTED' && currentEtag && conflictErr.currentEtag === currentEtag) {
                        // Our own revision, refused for an inconsistent
                        // deactivation state: a rebase would download the DB
                        // and replay the same state into the same rejection.
                        throw new SaveRejectedError(conflictErr.message)
                    }
                    console.warn('[Save] Full-write conflict detected, rebasing tracked local changes on latest server DB...')
                    await rebaseTrackedLocalChangesOnLatestServerDb(
                        conflictErr.currentEtag ?? null, db,
                        attemptedIdsAmbiguous ? toSave : withTrackedCharacters(toSave, attemptedChangedCharIds),
                        syncedArchivedIds, syncedBaselineDb,
                    )
                    await sleep(Math.min(500 * (savetrys + 1), 3000))
                    return 'retry'
                }
                throw conflictErr
            }

            // Re-init patcher from the data we just wrote so both sides
            // share the same baseline (including setDatabase defaults).
            if (supportsPatchSync) {
                const decodedDb = await decodeRisuSave(dbData)
                await patcher.init(decodedDb)
                await resyncBaselineAfterFullWrite()
            }
        }

        updateKnownChatsAfterSuccessfulSave(db, toSave)

        if (newEtag) {
            forageStorage.setDbEtag(newEtag)
        }


        return 'saved'
    }

    async function triggerSave(options?: {
        forceFullWrite?: boolean
        skipBroadcast?: boolean
    }) {
        if (saveInFlight) {
            return saveInFlight
        }

        const toSave = takeTrackedChanges()
        if (!hasTrackedChanges(toSave) && !options?.forceFullWrite) {
            return
        }

        saveInFlight = (async () => {
            saving.state = true
            try {
                const result = await persistTrackedChanges(toSave, options)
                if (result === 'saved') {
                    savetrys = 0
                    consecutiveRetries = 0
                } else if (result === 'retry') {
                    // A rebase requeued the changes; a conflict that never
                    // settles must surface instead of re-downloading forever.
                    consecutiveRetries += 1
                    if (consecutiveRetries > MAX_CONSECUTIVE_SAVE_RETRIES) {
                        consecutiveRetries = 0
                        throw new SaveRejectedError('Saving keeps conflicting with the server after repeated rebases. Another device may be saving continuously; reload this page to resync, and your unsaved changes are retried on the next edit.')
                    }
                } else if (result === 'noop' && hasTrackedChanges(toSave)) {
                    requeueTrackedChanges(toSave)
                    changed = true
                }
            } catch (error) {
                requeueTrackedChanges(toSave)
                if (error instanceof SaveRejectedError) {
                    // Deterministic rejection: the generic backoff below would
                    // only repeat the download/replay cycle (up to 30 full
                    // downloads before this alert used to appear). Surface it
                    // now; the changes stay queued for the next edit.
                    console.error(error)
                    alertError(error)
                    savetrys = 0
                    return
                }
                savetrys += 1
                if (savetrys > 4) {
                    alertError(error)
                    savetrys = 0
                }
                else {
                    console.error(error)
                    await sleep(Math.min(500 * savetrys, 3000))
                    changed = true
                }
            } finally {
                saving.state = false
                saveInFlight = null
            }
        })()

        return saveInFlight
    }

    requestImmediateSaveImpl = async (options) => {
        changed = true
        await tick()
        await triggerSave({
            forceFullWrite: options?.forceFullWrite,
        })
    }

    let savetrys = 0

    let consecutiveRetries = 0

    const MAX_CONSECUTIVE_SAVE_RETRIES = 5
    while (true) {
        if (!changed) {
            await sleep(200)
            continue
        }
        changed = false
        if (requiresFullEncoderReload.state) {
            encoder = new RisuSaveEncoder()
            await encoder.init(getDatabase(), {
                compression: false,
                skipRemoteSavingOnCharacters: false
            })
            requiresFullEncoderReload.state = false
        }
        await triggerSave()
        await sleep(100)
    }
}

/**
 * Retrieves the database backups.
 * 
 * @returns {Promise<number[]>} - A promise that resolves to an array of backup timestamps.
 */
export async function getDbBackups(currentDbSize?: number) {
    const keys = await forageStorage.keys()

    const backups = keys
        .filter(key => key.startsWith('database/dbbackup-'))
        .map(key => parseInt(key.slice(18, -4)))
        .sort((a, b) => b - a);

    const BACKUP_BUDGET = 500 * 1024 * 1024 // 500MB
    const maxBackups = currentDbSize
        ? Math.min(20, Math.max(3, Math.floor(BACKUP_BUDGET / currentDbSize)))
        : 20

    while (backups.length > maxBackups) {
        const last = backups.pop()
        await forageStorage.removeItem(`database/dbbackup-${last}.bin`)
    }
    return backups
}

let usingSw = false

export function setUsingSw(value: boolean) {
    usingSw = value
}


const knownHostes = ["localhost", "127.0.0.1", "0.0.0.0"];

/**
 * Interface representing the arguments for the global fetch function.
 * 
 * @interface GlobalFetchArgs
 * @property {boolean} [plainFetchForce] - Whether to force plain fetch.
 * @property {any} [body] - The body of the request.
 * @property {{ [key: string]: string }} [headers] - The headers of the request.
 * @property {boolean} [rawResponse] - Whether to return the raw response.
 * @property {'POST' | 'GET'} [method] - The HTTP method to use.
 * @property {AbortSignal} [abortSignal] - The abort signal to cancel the request.
 * @property {boolean} [useRisuToken] - Whether to use the Risu token.
 * @property {string} [chatId] - The chat ID associated with the request.
 */
interface GlobalFetchArgs {
    plainFetchForce?: boolean;
    plainFetchDeforce?: boolean;
    body?: any;
    headers?: { [key: string]: string };
    rawResponse?: boolean;
    method?: 'POST' | 'GET';
    abortSignal?: AbortSignal;
    useRisuToken?: boolean;
    chatId?: string;
    interceptor?: string;
    requestTimeoutMs?: number;
    networkRoute?: 'auto' | 'local_network';
    /** Request-log classification. Defaults to the neutral 'other'/'other';
     *  LLM call sites pass 'llm' plus the issuing part of the app so the log's
     *  default filter and the usage statistics can tell them apart. */
    logCategory?: RequestLogCategory;
    logSource?: RequestLogSource;
    logModel?: string;
    logPlugin?: string;
}

/**
 * Interface representing the result of the global fetch function.
 * 
 * @interface GlobalFetchResult
 * @property {boolean} ok - Whether the request was successful.
 * @property {any} data - The data returned from the request.
 * @property {{ [key: string]: string }} headers - The headers returned from the request.
 */
interface GlobalFetchResult {
    ok: boolean;
    data: any;
    headers: { [key: string]: string };
    status: number;
}

/**
 * Performs a global fetch request.
 * 
 * @param {string} url - The URL to fetch.
 * @param {GlobalFetchArgs} [arg={}] - The arguments for the fetch request.
 * @returns {Promise<GlobalFetchResult>} - The result of the fetch request.
 */
export async function globalFetch(url: string, arg: GlobalFetchArgs = {}): Promise<GlobalFetchResult> {
    try {
        const db = getDatabase();

        if (arg.abortSignal?.aborted) { return { ok: false, data: 'aborted', headers: {}, status: 400 }; }

        const urlHost = new URL(url).hostname
        const useLocalNetworkRoute = arg.networkRoute === 'local_network' && isLocalNetworkUrl(url)
        const forcePlainFetch = ((knownHostes.includes(urlHost)) || db.usePlainFetch || arg.plainFetchForce) && !arg.plainFetchDeforce && !useLocalNetworkRoute

        if(arg.interceptor){
            for (const interceptor of bodyIntercepterStore) {
                try {
                    arg.body = await interceptor.callback(arg.body, arg.interceptor) || arg.body
                }
                catch (e) {
                    console.error(e)
                }
            }
        }

        const timeoutSignal = buildTimeoutSignal(arg.abortSignal, arg.requestTimeoutMs)
        const requestArg = timeoutSignal.signal === arg.abortSignal
            ? arg
            : { ...arg, abortSignal: timeoutSignal.signal }

        try {
            if (useLocalNetworkRoute) {
                return await fetchWithProxy(url, requestArg);
            }

            if (forcePlainFetch) {
                return await fetchWithPlainFetch(url, requestArg);
            }
            //userScriptFetch is provided by userscript
            if (window.userScriptFetch && !arg.plainFetchDeforce) {
                return await fetchWithUSFetch(url, requestArg);
            }
            return await fetchWithProxy(url, requestArg);
        } finally {
            timeoutSignal.cleanup()
        }

    } catch (error) {
        console.error(error);
        return { ok: false, data: `${error}`, headers: {}, status: 400 };
    }
}

/**
 * Records a completed globalFetch request in the server request log.
 *
 * @param {any} response - The response data.
 * @param {boolean} success - Indicates if the fetch was successful.
 * @param {string} url - The URL of the fetch request.
 * @param {GlobalFetchArgs} arg - The arguments for the fetch request.
 * @param {number} started - Epoch ms when the request was issued, for duration.
 */
function addFetchLogInGlobalFetch(response: any, success: boolean, url: string, arg: GlobalFetchArgs, status: number | undefined, started: number) {
    // Opt-in, same rule as fetchNative: untagged call sites (TTS polling,
    // asset downloads, plugin traffic) are not worth a persisted row.
    if (!arg.logCategory) return
    const stringify = (value: unknown) => {
        try {
            return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
        } catch {
            return `${value}`
        }
    }
    recordRequestLog({
        timestamp: started,
        category: arg.logCategory ?? 'other',
        source: arg.logSource ?? 'other',
        chatId: arg.chatId,
        model: arg.logModel,
        provider: arg.logPlugin,
        url,
        method: arg.method ?? 'POST',
        status,
        success,
        streaming: false,
        durationMs: Date.now() - started,
        ...(arg.logCategory === 'llm' ? extractLegacyUsage(response) : undefined),
        requestHeaders: stringify(arg.headers ?? {}),
        requestBody: stringify(arg.body),
        responseBody: stringify(response),
    })
}

/**
 * Performs a fetch request using plain fetch.
 * 
 * @param {string} url - The URL to fetch.
 * @param {GlobalFetchArgs} arg - The arguments for the fetch request.
 * @returns {Promise<GlobalFetchResult>} - The result of the fetch request.
 */
async function fetchWithPlainFetch(url: string, arg: GlobalFetchArgs): Promise<GlobalFetchResult> {
    try {
        const started = Date.now();
        const headers = { 'Content-Type': 'application/json', ...arg.headers };
        const response = await fetch(new URL(url), { body: JSON.stringify(arg.body), headers, method: arg.method ?? "POST", signal: arg.abortSignal });
        const data = arg.rawResponse ? new Uint8Array(await response.arrayBuffer()) : await response.json();
        const ok = response.ok && response.status >= 200 && response.status < 300;
        addFetchLogInGlobalFetch(data, ok, url, arg, response.status, started);
        return { ok, data, headers: Object.fromEntries(response.headers), status: response.status };
    } catch (error) {
        return { ok: false, data: `${error}`, headers: {}, status: 400 };
    }
}

/**
 * Performs a fetch request using userscript provided fetch.
 * 
 * @param {string} url - The URL to fetch.
 * @param {GlobalFetchArgs} arg - The arguments for the fetch request.
 * @returns {Promise<GlobalFetchResult>} - The result of the fetch request.
 */
async function fetchWithUSFetch(url: string, arg: GlobalFetchArgs): Promise<GlobalFetchResult> {
    try {
        const started = Date.now();
        const headers = { 'Content-Type': 'application/json', ...arg.headers };
        const response = await userScriptFetch(url, { body: JSON.stringify(arg.body), headers, method: arg.method ?? "POST", signal: arg.abortSignal });
        const data = arg.rawResponse ? new Uint8Array(await response.arrayBuffer()) : await response.json();
        const ok = response.ok && response.status >= 200 && response.status < 300;
        addFetchLogInGlobalFetch(data, ok, url, arg, response.status, started);
        return { ok, data, headers: Object.fromEntries(response.headers), status: response.status };
    } catch (error) {
        return { ok: false, data: `${error}`, headers: {}, status: 400 };
    }
}

/**
 * Performs a fetch request using a proxy.
 * 
 * @param {string} url - The URL to fetch.
 * @param {GlobalFetchArgs} arg - The arguments for the fetch request.
 * @returns {Promise<GlobalFetchResult>} - The result of the fetch request.
 */
async function fetchWithProxy(url: string, arg: GlobalFetchArgs): Promise<GlobalFetchResult> {
    try {
        const started = Date.now();
        const furl = `/proxy2`;
        arg.headers["Content-Type"] ??= arg.body instanceof URLSearchParams ? "application/x-www-form-urlencoded" : "application/json";
        const headers = {
            "risu-header": encodeURIComponent(JSON.stringify(arg.headers)),
            "risu-url": encodeURIComponent(url),
            "Content-Type": arg.body instanceof URLSearchParams ? "application/x-www-form-urlencoded" : "application/json",
            ...(arg.useRisuToken && { "x-risu-tk": "use" }),
            ...(DBState?.db?.requestLocation && { "risu-location": DBState.db.requestLocation }),
        };

        // Add risu-auth header for Node.js server
        headers["risu-auth"] = await forageStorage.createAuth();

        const body = arg.body instanceof URLSearchParams ? arg.body.toString() : JSON.stringify(arg.body);

        const response = await fetch(furl, { body, headers, method: arg.method ?? "POST", signal: arg.abortSignal });
        const isSuccess = response.ok && response.status >= 200 && response.status < 300;

        if (arg.rawResponse) {
            const data = new Uint8Array(await response.arrayBuffer());
            addFetchLogInGlobalFetch("Uint8Array Response", isSuccess, url, arg, response.status, started);
            return { ok: isSuccess, data, headers: Object.fromEntries(response.headers), status: response.status };
        }

        const text = await response.text();
        try {
            const data = JSON.parse(text);
            addFetchLogInGlobalFetch(data, isSuccess, url, arg, response.status, started);
            return { ok: isSuccess, data, headers: Object.fromEntries(response.headers), status: response.status };
        } catch (error) {
            const errorMsg = text.startsWith('<!DOCTYPE') ? "Responded HTML. Is your URL, API key, and password correct?" : text;
            addFetchLogInGlobalFetch(text, false, url, arg, response.status, started);
            return { ok: false, data: errorMsg, headers: Object.fromEntries(response.headers), status: response.status };
        }
    } catch (error) {
        return { ok: false, data: `${error}`, headers: {}, status: 400 };
    }
}

/**
 * Regular expression to match backslashes.
 * 
 * @constant {RegExp}
 */
const re = /\\/g;

/**
 * Gets the basename of a given path.
 * 
 * @param {string} data - The path to get the basename from.
 * @returns {string} - The basename of the path.
 */
export function getBasename(data: string) {
    const splited = data.replace(re, '/').split('/');
    const lasts = splited[splited.length - 1];
    return lasts;
}

/**
 * Extracts "assets/..." path references from an arbitrary value. Non-string
 * values are serialized first so references nested inside plugin-stored JSON
 * (objects, arrays) are found too.
 *
 * @param {unknown} value - The value to scan.
 * @returns {string[]} - The asset paths found in the value.
 */
export function extractAssetRefs(value: unknown): string[] {
    let text: string;
    if (typeof value === 'string') {
        text = value;
    } else {
        try {
            text = JSON.stringify(value) ?? '';
        } catch {
            return [];
        }
    }
    return Array.from(text.matchAll(/assets[/\\][\w-]+\.\w+/g), (m) => m[0]);
}

/**
 * Retrieves uncleanable resources from the database.
 *
 * @param {Database} db - The database to retrieve uncleanable resources from.
 * @param {'basename'|'pure'} [uptype='basename'] - The type of uncleanable resources to retrieve.
 * @returns {string[]} - An array of uncleanable resources.
 */
export function getUncleanables(db: Database, uptype: 'basename' | 'pure' = 'basename') {
    const uncleanable = new Set<string>();

    /**
     * Adds a resource to the uncleanable list if it is not already included.
     * 
     * @param {string} data - The resource to add.
     */
    function addUncleanable(data: string) {
        if (!data) {
            return;
        }
        if (data === '') {
            return;
        }
        const bn = uptype === 'basename' ? getBasename(data) : data;
        uncleanable.add(bn);
    }

    addUncleanable(db.customBackground);
    addUncleanable(db.userIcon);
    // Uploaded notification sounds. Preset-id values (e.g. "bell") are not
    // asset paths, so they add a harmless basename that matches no stored asset.
    addUncleanable(db.messageSound);
    addUncleanable(db.translateSound);
    if (db.customSounds) {
        for (const s of db.customSounds) {
            addUncleanable(s.path);
        }
    }
    // Image-gen reference images hang off settings, not off a character. Missing
    // them here meant cleanChunks deleted an asset the app still points at.
    addUncleanable(db.NAIImgConfig?.character_image);
    addUncleanable(db.NAIImgConfig?.image);
    addUncleanable(db.wavespeedImage?.reference_image);

    for (const cha of db.characters) {
        if (cha.image) {
            addUncleanable(cha.image);
        }
        if (cha.emotionImages) {
            for (const em of cha.emotionImages) {
                addUncleanable(em[1]);
            }
        }
        if (cha.additionalAssets) {
            for (const em of cha.additionalAssets) {
                addUncleanable(em[1]);
            }
        }
        if (cha.vits) {
            const keys = Object.keys(cha.vits.files);
            for (const key of keys) {
                const vit = cha.vits.files[key];
                addUncleanable(vit);
            }
        }
        if (cha.ccAssets) {
            for (const asset of cha.ccAssets) {
                addUncleanable(asset.uri);
            }
        }
        // GPT-SoVITS reference audio is uploaded via saveAsset and read back on
        // every TTS run — assetId holds the full "assets/..." path.
        addUncleanable(cha.gptSoVitsConfig?.ref_audio_data?.assetId);
    }

    if (db.modules) {
        for (const module of db.modules) {
            const assets = module.assets
            if (assets) {
                for (const asset of assets) {
                    addUncleanable(asset[1])
                }
            }
            if(module.icon){
                addUncleanable(module.icon)
            }
        }
    }

    if (db.personas) {
        db.personas.map((v) => {
            addUncleanable(v.icon);
            // Legacy field: personas imported from character cards in older
            // versions kept an `image` alongside `icon`. Nothing reads it today,
            // but it is a live asset reference — omitting it here deleted the
            // asset for good.
            addUncleanable((v as unknown as { image?: string }).image);

            if(v.embeddedModule){
                const assets = v.embeddedModule.assets
                if (assets) {
                    for (const asset of assets) {
                        addUncleanable(asset[1])
                    }
                }
                if(v.embeddedModule.icon){
                    addUncleanable(v.embeddedModule.icon)
                }
            }
        });
    }

    if (db.characterOrder) {
        db.characterOrder.forEach((item) => {
            if (typeof item === 'object' && 'imgFile' in item) {
                addUncleanable(item.imgFile);
            }
        })
    }

    // Plugins can persist asset paths (from risuai.saveAsset) anywhere inside
    // their storage — as plain strings or nested in JSON values — so scan the
    // serialized text for "assets/..." references instead of assuming a structure.
    if (db.pluginCustomStorage) {
        for (const value of Object.values(db.pluginCustomStorage)) {
            for (const ref of extractAssetRefs(value)) {
                addUncleanable(ref);
            }
        }
    }
    return Array.from(uncleanable);
}


/**
 * Replaces database resources with the provided replacer object.
 * 
 * @param {Database} db - The database object containing resources to be replaced.
 * @param {{[key: string]: string}} replacer - An object mapping original resource keys to their replacements.
 * @returns {Database} - The updated database object with replaced resources.
 */
export function replaceDbResources(db: Database, replacer: { [key: string]: string }): Database {
    /**
     * Replaces a given data string with its corresponding value from the replacer object.
     * 
     * @param {string} data - The data string to be replaced.
     * @returns {string} - The replaced data string or the original data if no replacement is found.
     */
    function replaceData(data: string): string {
        if (!data) {
            return data;
        }
        return replacer[data] ?? data;
    }

    db.customBackground = replaceData(db.customBackground);
    db.userIcon = replaceData(db.userIcon);
    db.messageSound = replaceData(db.messageSound);
    db.translateSound = replaceData(db.translateSound);
    if (db.customSounds) {
        for (const s of db.customSounds) {
            s.path = replaceData(s.path);
        }
    }

    for (const cha of db.characters) {
        if (cha.image) {
            cha.image = replaceData(cha.image);
        }
        if (cha.emotionImages) {
            for (let i = 0; i < cha.emotionImages.length; i++) {
                cha.emotionImages[i][1] = replaceData(cha.emotionImages[i][1]);
            }
        }
        if (cha.additionalAssets) {
            for (let i = 0; i < cha.additionalAssets.length; i++) {
                cha.additionalAssets[i][1] = replaceData(cha.additionalAssets[i][1]);
            }
        }
    }
    return db;
}

/**
 * Checks and updates the character order in the database.
 * Ensures that all characters are properly ordered and removes any invalid entries.
 */
export function checkCharOrder() {
    let db = getDatabase()
    db.characterOrder = db.characterOrder ?? []
    let ordered = []
    for (let i = 0; i < db.characterOrder.length; i++) {
        const folder = db.characterOrder[i]
        if (typeof (folder) !== 'string' && folder) {
            for (const f of folder.data) {
                ordered.push(f)
            }
        }
        if (typeof (folder) === 'string') {
            ordered.push(folder)
        }
    }

    let charIdList: string[] = []

    for (let i = 0; i < db.characters.length; i++) {
        const char = db.characters[i]
        const charId = char.chaId
        if (!char.trashTime) {
            charIdList.push(charId)
        }
        if (!ordered.includes(charId)) {
            if (charId !== '§temp' && charId !== '§playground' && !char.trashTime) {
                db.characterOrder.push(charId)
            }
        }
    }
    // Deactivated characters are not in db.characters but keep their place
    // (and folder) in the order list so the sidebar can render them dimmed.
    for (const stub of db.nodeOnlyArchivedCharacters ?? []) {
        if (!stub?.chaId) continue
        // Trashed stubs (deactivated + trashedAt) leave the order like trashed characters.
        if (stub.trashedAt) continue
        charIdList.push(stub.chaId)
        if (!ordered.includes(stub.chaId)) {
            db.characterOrder.push(stub.chaId)
        }
    }


    for (let i = 0; i < db.characterOrder.length; i++) {
        const data = db.characterOrder[i]
        if (typeof (data) !== 'string') {
            if (!data) {
                db.characterOrder.splice(i, 1)
                i--;
                continue
            }
            // Empty folders are kept: the character manager creates a folder
            // first and fills it afterwards.
            for (let i2 = 0; i2 < data.data.length; i2++) {
                const data2 = data.data[i2]
                if (!charIdList.includes(data2)) {
                    data.data.splice(i2, 1)
                    i2--;
                }
            }
            db.characterOrder[i] = data
        }
        else {
            if (!charIdList.includes(data)) {
                db.characterOrder.splice(i, 1)
                i--;
            }
        }
    }

    // Sidebar-hidden ids: drop only ids that exist nowhere any more (trashed
    // characters keep their flag so restoring them restores the hidden state).
    if (Array.isArray(db.nodeOnlyHiddenCharacterIds) && db.nodeOnlyHiddenCharacterIds.length > 0) {
        const known = new Set<string>(charIdList)
        for (const char of db.characters) {
            if (char?.chaId) known.add(char.chaId)
        }
        for (const stub of db.nodeOnlyArchivedCharacters ?? []) {
            if (stub?.chaId) known.add(stub.chaId)
        }
        const pruned = pruneHiddenCharacterIds(db.nodeOnlyHiddenCharacterIds, known)
        if (pruned.length !== db.nodeOnlyHiddenCharacterIds.length) {
            db.nodeOnlyHiddenCharacterIds = pruned
        }
    }
}

/**
 * Retrieves the most recent request logs. Kept for the plugin API (v3
 * getFetchLogs), which has always been Promise-returning, so moving the
 * storage server-side is invisible to plugins.
 */
export async function getFetchLogs(limit = 20) {
    return await fetchRequestLogs({ limit, bodies: true })
}

/**
 * Opens a URL in the appropriate environment.
 * 
 * @param {string} url - The URL to open.
 */
export function openURL(url: string) {
    window.open(url, "_blank")
}

/**
 * Converts FormData to a URL-encoded string.
 * 
 * @param {FormData} formData - The FormData to convert.
 * @returns {string} The URL-encoded string.
 */
function formDataToString(formData: FormData): string {
    const params: string[] = [];

    for (const [name, value] of formData.entries()) {
        params.push(`${encodeURIComponent(name)}=${encodeURIComponent(value.toString())}`);
    }

    return params.join('&');
}

/**
 * Class representing a local writer.
 */
export class LocalWriter {
    writer: WritableStreamDefaultWriter

    /**
     * Initializes the writer.
     * 
     * @param {string} [name='Binary'] - The name of the file.
     * @param {string[]} [ext=['bin']] - The file extensions.
     * @returns {Promise<boolean>} - A promise that resolves to a boolean indicating success.
     */
    async init(name = 'Binary', ext = ['bin']): Promise<boolean> {
        const writableStream = streamSaver.createWriteStream(name + '.' + ext[0])
        this.writer = writableStream.getWriter()
        return true
    }

    /**
     * Writes backup data to the file.
     * 
     * @param {string} name - The name of the backup.
     * @param {Uint8Array} data - The data to write.
     */
    async writeBackup(name: string, data: Uint8Array): Promise<void> {
        const encodedName = new TextEncoder().encode(getBasename(name))
        const nameLength = new Uint32Array([encodedName.byteLength])
        await this.writer.write(new Uint8Array(nameLength.buffer))
        await this.writer.write(encodedName)
        const dataLength = new Uint32Array([data.byteLength])
        await this.writer.write(new Uint8Array(dataLength.buffer))
        await this.writer.write(data)
    }

    /**
     * Writes data to the file.
     * 
     * @param {Uint8Array} data - The data to write.
     */
    async write(data: Uint8Array): Promise<void> {
        await this.writer.write(data)
    }

    /**
     * Closes the writer.
     */
    async close(): Promise<void> {
        await this.writer.close()
    }
}

/**
 * Class representing a virtual writer.
 */
export class VirtualWriter {
    buf = new AppendableBuffer()

    /**
     * Writes data to the buffer.
     * 
     * @param {Uint8Array} data - The data to write.
     */
    write(data: Uint8Array): void {
        this.buf.append(data)
    }

    /**
     * Closes the writer. (No operation for VirtualWriter)
     */
    close(): void {
        // do nothing
    }
}

/**
 * Index for fetch operations.
 * @type {number}
 */
let fetchIndex = 0

/**
 * Stores native fetch data.
 * @type {{ [key: string]: StreamedFetchChunk[] }}
 */
let nativeFetchData: { [key: string]: StreamedFetchChunk[] } = {}

/**
 * Interface representing a streamed fetch chunk data.
 * @interface
 */
interface StreamedFetchChunkData {
    type: 'chunk',
    body: string,
    id: string
}

/**
 * Interface representing a streamed fetch header data.
 * @interface
 */
interface StreamedFetchHeaderData {
    type: 'headers',
    body: { [key: string]: string },
    id: string,
    status: number
}

/**
 * Interface representing a streamed fetch end data.
 * @interface
 */
interface StreamedFetchEndData {
    type: 'end',
    id: string
}

/**
 * Type representing a streamed fetch chunk.
 * @typedef {StreamedFetchChunkData | StreamedFetchHeaderData | StreamedFetchEndData} StreamedFetchChunk
 */
type StreamedFetchChunk = StreamedFetchChunkData | StreamedFetchHeaderData | StreamedFetchEndData

/**
 * Interface representing a streamed fetch plugin.
 * @interface
 */
interface StreamedFetchPlugin {
    /**
     * Performs a streamed fetch operation.
     * @param {Object} options - The options for the fetch operation.
     * @param {string} options.id - The ID of the fetch operation.
     * @param {string} options.url - The URL to fetch.
     * @param {string} options.body - The body of the fetch request.
     * @param {{ [key: string]: string }} options.headers - The headers of the fetch request.
     * @returns {Promise<{ error: string, success: boolean }>} - The result of the fetch operation.
     */
    streamedFetch(options: { id: string, url: string, body: string, headers: { [key: string]: string } }): Promise<{ "error": string, "success": boolean }>;

    /**
     * Adds a listener for the specified event.
     * @param {string} eventName - The name of the event.
     * @param {(data: StreamedFetchChunk) => void} listenerFunc - The function to call when the event is triggered.
     */
    addListener(eventName: 'streamed_fetch', listenerFunc: (data: StreamedFetchChunk) => void): void;
}

/**
 * Indicates whether streamed fetch listening is active.
 * @type {boolean}
 */
let streamedFetchListening = false

/**
 * The streamed fetch plugin instance.
 * @type {StreamedFetchPlugin | undefined}
 */
let capStreamedFetch: StreamedFetchPlugin | undefined


/**
 * A class to manage a buffer that can be appended to and deappended from.
 */
export class AppendableBuffer {
    deapended: number = 0
    #buffer: Uint8Array
    #byteLength: number = 0

    /**
     * Creates an instance of AppendableBuffer.
     */
    constructor() {
        this.#buffer = new Uint8Array(128)
    }

    get buffer(): Uint8Array {
        return this.#buffer.slice(0, this.#byteLength)
    }

    /**
     * Appends data to the buffer.
     * @param {Uint8Array} data - The data to append.
     */
    append(data: Uint8Array) {
        // New way (faster)
        const requiredLength = this.#byteLength + data.length
        if (this.#buffer.byteLength < requiredLength) {
            let newLength = this.#buffer.byteLength * 2
            while (newLength < requiredLength) {
                newLength *= 2
            }
            const newBuffer = new Uint8Array(newLength)
            newBuffer.set(this.#buffer)
            this.#buffer = newBuffer
        }
        this.#buffer.set(data, this.#byteLength)
        this.#byteLength += data.length
    }

    /**
     * Deappends a specified length from the buffer.
     * @param {number} length - The length to deappend.
     */
    deappend(length: number) {
        this.#buffer = this.#buffer.slice(length)
        this.deapended += length
        this.#byteLength -= length
    }

    /**
     * Slices the buffer from start to end.
     * @param {number} start - The start index.
     * @param {number} end - The end index.
     * @returns {Uint8Array} - The sliced buffer.
     */
    slice(start: number, end: number) {
        return this.buffer.slice(start - this.deapended, end - this.deapended)
    }

    /**
     * Gets the total length of the buffer including deappended length.
     * @returns {number} - The total length.
     */
    length() {
        return this.#byteLength + this.deapended
    }

    /**
     * Clears the buffer.
     */
    clear() {
        this.#buffer = new Uint8Array(128)
        this.#byteLength = 0
        this.deapended = 0
    }
}

/**
 * Fetches data from a given URL using native fetch or through a proxy.
 * @param {string} url - The URL to fetch data from.
 * @param {Object} arg - The arguments for the fetch request.
 * @param {string} arg.body - The body of the request.
 * @param {Object} [arg.headers] - The headers of the request.
 * @param {string} [arg.method="POST"] - The HTTP method of the request.
 * @param {AbortSignal} [arg.signal] - The signal to abort the request.
 * @param {boolean} [arg.useRisuTk] - Whether to use Risu token.
 * @param {string} [arg.chatId] - The chat ID associated with the request.
 * @returns {Promise<Object>} - A promise that resolves to an object containing the response body, headers, and status.
 * @returns {ReadableStream<Uint8Array>} body - The response body as a readable stream.
 * @returns {Headers} headers - The response headers.
 * @returns {number} status - The response status code.
 * @throws {Error} - Throws an error if the request is aborted or if there is an error in the response.
 */
export interface FetchNativeArgs {
    body?: string | Uint8Array | ArrayBuffer,
    headers?: { [key: string]: string },
    method?: "POST" | "GET" | "PUT" | "DELETE",
    signal?: AbortSignal,
    useRisuTk?: boolean,
    chatId?: string
    interceptor?: string
    requestTimeoutMs?: number
    networkRoute?: 'auto' | 'local_network'
    /** Request-log classification; see GlobalFetchArgs for the same fields. */
    logCategory?: RequestLogCategory
    logSource?: RequestLogSource
    logModel?: string
    logPlugin?: string
    /** Reports which transport was actually used. Fires regardless of
     *  logCategory, so a caller that logs at a higher level (the model-preset
     *  path) can record the true route instead of guessing. */
    onLogRoute?: (route: RequestLogRoute) => void
}

export async function fetchNative(url: string, arg: FetchNativeArgs): Promise<Response> {
    // Logging is OPT-IN: only call sites that tag a category are recorded.
    // Logging everything that passes through here was actively harmful —
    // ComfyUI polls /history once a second, /view returns a PNG that would be
    // text-decoded and stored, an MCP SSE connection stays open for the whole
    // session, and makeProxiedFetch routes the model-preset path through here,
    // which produced a second, untagged row for every preset request.
    if (!arg.logCategory) {
        return fetchNativeRaw(url, arg, { onRoute: arg.onLogRoute })
    }
    // Logging wraps the transport rather than living inside it: fetchNativeRaw
    // returns from several branches (userscript / WS proxy job / proxy2 /
    // direct), and the response body is a stream that must be tee'd exactly
    // once. The scope handles both, and assembles the streamed text so the log
    // records the real response instead of a "Streamed Fetch" placeholder.
    const scope = createRequestLogScope({
        category: arg.logCategory ?? 'other',
        source: arg.logSource ?? 'other',
        chatId: arg.chatId,
        model: arg.logModel,
        logPlugin: arg.logPlugin,
        streaming: true,
    })
    const logged = scope.wrap(((_input: RequestInfo | URL, _init?: RequestInit) =>
        fetchNativeRaw(url, arg, {
            onRealBody: (body) => scope.setRequestBody(body),
            onRoute: (route) => { scope.setRoute(route); arg.onLogRoute?.(route) },
        })
    ) as typeof fetch)
    try {
        return await logged(url, {
            method: arg.method ?? 'POST',
            headers: arg.headers,
            body: arg.body as BodyInit | undefined,
        })
    } finally {
        // Fire-and-forget: close() waits for the tee'd body to finish
        // assembling, which outlives this return for a streamed response.
        void scope.close()
    }
}

async function fetchNativeRaw(url: string, arg: FetchNativeArgs, hooks?: {
    onRealBody?: (body: string) => void,
    onRoute?: (route: RequestLogRoute) => void,
}): Promise<Response> {
    const useInterceptor = !!arg.interceptor
    if (arg.body === undefined && (arg.method === 'POST' || arg.method === 'PUT')) {
        throw new Error('Body is required for POST and PUT requests')
    }

    arg.method = arg.method ?? 'POST'

    const headers = arg.headers ?? {}
    let realBody: Uint8Array | undefined

    if (arg.method === 'GET' || arg.method === 'DELETE') {
        realBody = undefined
    }
    else if (typeof arg.body === 'string') {
        let body: string = arg.body
        if(useInterceptor) {
            for (const interceptor of bodyIntercepterStore) {
                try {
                    body = await interceptor.callback(body, arg.interceptor) || body
                }
                catch (e) {
                    console.error(e)
                }
            }
        }
        realBody = new TextEncoder().encode(body)
    }
    else if (arg.body instanceof Uint8Array) {
        realBody = arg.body
    }
    else if (arg.body instanceof ArrayBuffer) {
        realBody = new Uint8Array(arg.body)
    }
    else {
        throw new Error('Invalid body type')
    }

    // The logged body is the one actually sent — after any body interceptor
    // rewrote it — which is why it is reported from here rather than from the
    // wrapper's view of arg.body.
    hooks?.onRealBody?.(realBody ? new TextDecoder().decode(realBody) : '')
    const useLocalNetworkRoute = arg.networkRoute === 'local_network' && isLocalNetworkUrl(url)
    const timeoutSignal = buildTimeoutSignal(arg.signal, arg.requestTimeoutMs)
    const requestSignal = timeoutSignal.signal
    const db = getDatabase()
    let throughProxy = !db.usePlainFetch
    if (useLocalNetworkRoute) {
        throughProxy = true
    }

    try {
        if (window.userScriptFetch && !throughProxy) {
            hooks?.onRoute?.('direct')
            return await window.userScriptFetch(url, {
                body: realBody as any,
                headers: headers,
                method: arg.method,
                signal: requestSignal
            })
        }

        // Local network streaming: try WebSocket proxy job, fallback to /proxy2
        const useProxyJobWs = useLocalNetworkRoute
            && arg.interceptor === 'openai_streaming'
            && arg.method === 'POST'
        if (useProxyJobWs) {
            try {
                const res = await fetchViaProxyJobWs(url, {
                    method: arg.method,
                    headers,
                    body: realBody,
                    signal: requestSignal,
                    requestTimeoutMs: arg.requestTimeoutMs,
                })
                hooks?.onRoute?.('proxy')
                return res
            } catch (wsErr) {
                console.warn('[ProxyJobWS] fallback to /proxy2 due to error:', wsErr)
            }
        }

        // Local network non-streaming or WS fallback: go through /proxy2 directly
        if (useLocalNetworkRoute) {
            hooks?.onRoute?.('proxy')
            return await fetchViaProxy2(url, headers, realBody, {
                ...arg,
                signal: requestSignal
            })
        }

        // Try direct fetch first (upstream behavior), fall back to proxy on CORS/network error
        try {
            const res = await fetch(url, {
                body: realBody as any,
                headers: headers,
                method: arg.method,
                signal: requestSignal,
            })
            hooks?.onRoute?.('direct')
            return res
        } catch (e) {
            if (requestSignal?.aborted) throw e
            // The route is only known once the direct attempt has failed, which
            // is why it is reported here rather than guessed up front.
            hooks?.onRoute?.('proxy')
            return await fetchViaProxy2(url, headers, realBody, {
                ...arg,
                signal: requestSignal
            })
        }
    } finally {
        timeoutSignal.cleanup()
    }
}

const defaultProxyJobHeartbeatSec = 15

async function fetchViaProxy2(
    url: string,
    headers: Record<string, string>,
    realBody: Uint8Array | undefined,
    arg: { method?: string, signal?: AbortSignal, useRisuTk?: boolean, requestTimeoutMs?: number }
): Promise<Response> {
    const proxyHeaders: Record<string, string> = {
        "risu-header": encodeURIComponent(JSON.stringify(headers)),
        "risu-url": encodeURIComponent(url),
        "risu-auth": await forageStorage.createAuth(),
        ...(arg.useRisuTk ? { "x-risu-tk": "use" } : {}),
        ...(arg.requestTimeoutMs && { "risu-timeout-ms": Math.max(1, Math.floor(arg.requestTimeoutMs)).toString() }),
        ...(DBState?.db?.requestLocation ? { "risu-location": DBState.db.requestLocation } : {}),
    }

    if (realBody) {
        proxyHeaders["Content-Type"] = headers["Content-Type"] ?? headers["content-type"] ?? "application/json"
    }

    const r = await fetch(`/proxy2`, {
        body: realBody as any,
        headers: proxyHeaders,
        method: arg.method,
        signal: arg.signal
    })

    return new Response(r.body, {
        headers: r.headers,
        status: r.status
    })
}

async function fetchViaProxyJobWs(url: string, arg: {
    method: string,
    headers: Record<string, string>,
    body?: Uint8Array,
    signal?: AbortSignal,
    requestTimeoutMs?: number,
}): Promise<Response> {
    const auth = await forageStorage.createAuth()
    const bodyBase64 = arg.body ? Buffer.from(arg.body).toString('base64') : ''

    const jobRes = await fetch('/proxy-stream-jobs', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'risu-auth': auth,
        },
        body: JSON.stringify({
            url,
            method: arg.method,
            headers: arg.headers,
            bodyBase64,
            timeoutMs: arg.requestTimeoutMs,
            heartbeatSec: defaultProxyJobHeartbeatSec,
        }),
        signal: arg.signal,
    })

    if (!jobRes.ok) {
        throw new Error(`Failed to create proxy stream job: ${jobRes.status} ${await jobRes.text()}`)
    }

    const { jobId } = await jobRes.json() as { jobId: string }
    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${wsProtocol}//${location.host}/proxy-stream-jobs/${encodeURIComponent(jobId)}/ws?risu-auth=${encodeURIComponent(auth)}`

    return new Promise<Response>((resolve, reject) => {
        const ws = new WebSocket(wsUrl)
        let resolved = false
        let responseStatus = 200
        let responseHeaders: Record<string, string> = {}
        let streamController: ReadableStreamDefaultController<Uint8Array> | null = null

        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                streamController = controller
            },
            cancel() {
                ws.close()
                fetch(`/proxy-stream-jobs/${encodeURIComponent(jobId)}`, {
                    method: 'DELETE',
                    headers: { 'risu-auth': auth },
                }).catch(() => {})
            }
        })

        const abortHandler = () => {
            ws.close()
            fetch(`/proxy-stream-jobs/${encodeURIComponent(jobId)}`, {
                method: 'DELETE',
                headers: { 'risu-auth': auth },
            }).catch(() => {})
            if (!resolved) {
                resolved = true
                reject(new DOMException('Aborted', 'AbortError'))
            }
        }

        if (arg.signal) {
            if (arg.signal.aborted) {
                abortHandler()
                return
            }
            arg.signal.addEventListener('abort', abortHandler, { once: true })
        }

        ws.onmessage = (ev) => {
            const event = parseProxyJobWsEvent(typeof ev.data === 'string' ? ev.data : '')
            if (!event) return

            switch (event.type) {
                case 'job_accepted':
                case 'ping':
                    break
                case 'upstream_headers':
                    responseStatus = event.status
                    responseHeaders = event.headers
                    if (!resolved) {
                        resolved = true
                        resolve(new Response(stream, {
                            status: responseStatus,
                            headers: responseHeaders,
                        }))
                    }
                    break
                case 'chunk': {
                    const bytes = decodeProxyJobWsChunk(event.dataBase64)
                    streamController?.enqueue(bytes)
                    break
                }
                case 'error': {
                    const msg = formatProxyStreamErrorMessage(event.status, event.message)
                    if (!resolved) {
                        resolved = true
                        resolve(new Response(msg, {
                            status: event.status ?? 502,
                            headers: { 'content-type': 'text/plain' },
                        }))
                    }
                    streamController?.close()
                    break
                }
                case 'done':
                    streamController?.close()
                    break
            }
        }

        ws.onerror = () => {
            if (!resolved) {
                resolved = true
                reject(new Error('WebSocket connection failed'))
            }
        }

        ws.onclose = () => {
            arg.signal?.removeEventListener('abort', abortHandler)
            try { streamController?.close() } catch { /* already closed */ }
            if (!resolved) {
                resolved = true
                reject(new Error('WebSocket closed before response'))
            }
        }
    })
}

/**
 * Converts a ReadableStream of Uint8Array to a text string.
 * 
 * @param {ReadableStream<Uint8Array>} stream - The readable stream to convert.
 * @returns {Promise<string>} A promise that resolves to the text content of the stream.
 */
export function textifyReadableStream(stream: ReadableStream<Uint8Array>) {
    return new Response(stream).text()
}

/**
 * Toggles the fullscreen mode of the document.
 * If the document is currently in fullscreen mode, it exits fullscreen.
 * If the document is not in fullscreen mode, it requests fullscreen with navigation UI hidden.
 */
export function toggleFullscreen() {
    const fullscreenElement = document.fullscreenElement
    fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen({
        navigationUI: "hide"
    })
}

/**
 * Removes non-Latin characters from a string, replaces multiple spaces with a single space, and trims the string.
 * 
 * @param {string} data - The input string to be processed.
 * @returns {string} The processed string with non-Latin characters removed, multiple spaces replaced by a single space, and trimmed.
 */
export function trimNonLatin(data: string) {
    return data.replace(/[^\x00-\x7F]/g, "")
        .replace(/ +/g, ' ')
        .trim()
}

/**
 * A class that provides a blank writer implementation.
 * 
 * This class is used to provide a no-op implementation of a writer, making it compatible with other writer interfaces.
 */
export class BlankWriter {
    constructor() {
    }

    /**
     * Initializes the writer.
     * 
     * This method does nothing and is provided for compatibility with other writer interfaces.
     */
    async init() {
        //do nothing, just to make compatible with other writer
    }

    /**
     * Writes data to the writer.
     * 
     * This method does nothing and is provided for compatibility with other writer interfaces.
     * 
     * @param {string} key - The key associated with the data.
     * @param {Uint8Array|string} data - The data to be written.
     */
    async write(key: string, data: Uint8Array | string) {
        //do nothing, just to make compatible with other writer
    }

    /**
     * Ends the writing process.
     * 
     * This method does nothing and is provided for compatibility with other writer interfaces.
     */
    async end() {
        //do nothing, just to make compatible with other writer
    }
}

export async function loadInternalBackup() {

    const keys = await forageStorage.keys()
    const internalBackups = keys
        .filter((key) => key.startsWith('database/dbbackup-'))
        .sort((a, b) => {
            const aTs = parseInt(a.replace('database/dbbackup-', '').replace('.bin', ''))
            const bTs = parseInt(b.replace('database/dbbackup-', '').replace('.bin', ''))
            return bTs - aTs
        })

    const selectOptions = [
        'Cancel',
        ...(internalBackups.map((a) => {
            return (new Date(parseInt(a.replace('database/dbbackup-', '').replace('dbbackup-', '')) * 100)).toLocaleString()
        }))
    ]

    const alertResult = parseInt(
        await alertSelect(selectOptions)
    ) - 1

    if (alertResult === -1) {
        return
    }

    const selectedBackup = internalBackups[alertResult]

    const data = await forageStorage.getItem(selectedBackup)

    const backupDecoded = await decodeRisuSave(Buffer.from(data) as unknown as Uint8Array)
    setDatabase(backupDecoded)

    notifySuccess('Loaded backup')



}

/**
 * A debugging class for performance measurement.
*/

export class PerformanceDebugger {
    kv: { [key: string]: number[] } = {}
    startTime: number
    endTime: number

    /**
     * Starts the timing measurement.
    */
    start() {
        this.startTime = performance.now()
    }

    /**
     * Ends the timing measurement and records the time difference.
     * 
     * @param {string} key - The key to associate with the recorded time.
    */
    endAndRecord(key: string) {
        this.endTime = performance.now()
        if (!this.kv[key]) {
            this.kv[key] = []
        }
        this.kv[key].push(this.endTime - this.startTime)
    }

    /**
     * Ends the timing measurement, records the time difference, and starts a new timing measurement.
     * 
     * @param {string} key - The key to associate with the recorded time.
    */
    endAndRecordAndStart(key: string) {
        this.endAndRecord(key)
        this.start()
    }

    /**
     * Logs the average time for each key to the console.
    */
    log() {
        let table: { [key: string]: number } = {}

        for (const key in this.kv) {
            table[key] = this.kv[key].reduce((a, b) => a + b, 0) / this.kv[key].length
        }


        console.table(table)
    }

    combine(other: PerformanceDebugger) {
        for (const key in other.kv) {
            if (!this.kv[key]) {
                this.kv[key] = []
            }
            this.kv[key].push(...other.kv[key])
        }
    }
}

export function getLanguageCodes() {
    let languageCodes: {
        code: string
        name: string
    }[] = []

    for (let i = 0x41; i <= 0x5A; i++) {
        for (let j = 0x41; j <= 0x5A; j++) {
            languageCodes.push({
                code: String.fromCharCode(i) + String.fromCharCode(j),
                name: ''
            })
        }
    }

    languageCodes = languageCodes.map(v => {
        return {
            code: v.code.toLocaleLowerCase(),
            name: new Intl.DisplayNames([
                DBState.db.language === 'cn' ? 'zh' : DBState.db.language
            ], {
                type: 'language',
                fallback: 'none'
            }).of(v.code)
        }
    }).filter((a) => {
        return a.name
    }).sort((a, b) => a.name.localeCompare(b.name))

    return languageCodes
}

export function getVersionString(): string {
    return nodeOnlyVer
}

export function toGetter<T extends object>(
    getterFn: () => T,
    args?: {
        //blocks this.children from being accessed
        restrictChildren:string[]
    }
): T {

    const dummyTarget = () => { };

    return new Proxy(dummyTarget, {
        get(target, prop, receiver) {

            const realInstance = getterFn();
            
            if (args?.restrictChildren && args.restrictChildren.includes(prop as string)) {
                throw new Error(`Access to property '${String(prop)}' is restricted`);
            }

            if (realInstance === null || realInstance === undefined) {
                return (realInstance as any)[prop];
            }

            const value = Reflect.get(realInstance as object, prop);

            if (typeof value === 'function') {
                return value.bind(realInstance);
            }

            return value;
        },

        set(target, prop, value, receiver) {

            if(args?.restrictChildren && args.restrictChildren.includes(prop as string)) {
                throw new Error(`Access to property '${String(prop)}' is restricted`);
            }
            const realInstance = getterFn();
            return Reflect.set(realInstance as object, prop, value, receiver);
        },

        has(target, prop) {
            const realInstance = getterFn();
            return Reflect.has(realInstance as object, prop);
        },

        ownKeys(target) {
            const realInstance = getterFn();
            return Reflect.ownKeys(realInstance as object);
        },

        construct(target, argArray, newTarget) {
            const realInstance = getterFn() as any;
            return new realInstance(...argArray);
        },

        deleteProperty(target, prop) {
            const realInstance = getterFn();
            return Reflect.deleteProperty(realInstance as object, prop);
        },

        getPrototypeOf() {
            const realInstance = getterFn();
            return Reflect.getPrototypeOf(realInstance as object);
        }
    }) as unknown as T;
}

const countriesWithAiLaw = new Set<string>([

    // EU
    // AI Act
    // https://artificialintelligenceact.eu/
    
    "AT",
    "BE",
    "BG",
    "HR",
    "CY",
    "CZ",
    "DK",
    "EE",
    "FI",
    "FR",
    "DE",
    "EL",
    "GR",
    "HU",
    "IE",
    "IT",
    "LV",
    "LT",
    "LU",
    "MT",
    "NL",
    "PL",
    "PT",
    "RO",
    "SK",
    "SI",
    "ES",
    "SE",

    //China 
    //Measures for Labeling of AI-Generated Synthetic Content
    // 关于印发《人工智能生成合成内容标识办法》的通知 
    // https://www.cac.gov.cn/2025-03/14/c_1743654684782215.htm
    "CN",

    //Although CN Law doesn't apply, just in case
    "HK",
    "MO",

    //TW isn't under mainland china jurisdiction
    //de facto, de jure in TW law, unlike HK and MO,
    //So we don't include it for now
    //"TW", 

    // Republic of Korea
    // AI Basic Act
    // 인공지능 발전과 신뢰 기반 조성 등에 관한 기본법
    // https://www.law.go.kr/%EB%B2%95%EB%A0%B9/%EC%9D%B8%EA%B3%B5%EC%A7%80%EB%8A%A5%20%EB%B0%9C%EC%A0%84%EA%B3%BC%20%EC%8B%A0%EB%A2%B0%20%EA%B8%B0%EB%B0%98%20%EC%A1%B0%EC%84%B1%20%EB%93%B1%EC%97%90%20%EA%B4%80%ED%95%9C%20%EA%B8%B0%EB%B3%B8%EB%B2%95/(20676,20250121)
    "KR",

    // Vietnam
    // Digital Tech Law
    // Luật Công nghệ số
    "VN",

])

export function aiLawApplies(): boolean {

    //TODO: implement actual logic
    //lets now assume it always applies
    //so we don't have legal issues later

    return true
}

export function aiWatermarkingLawApplies(): boolean {

    //TODO: implement actual logic
    //lets now assume it is false for now,
    //becuase very few countries have it for now
    return false
}

export const chatFoldedState = $state<{
    data: null| {
        targetCharacterId: string,
        targetChatId: string,
        targetMessageId: string,
    }
}>({
    data: null
})

//Since its exported, we cannot use $derived here
export let chatFoldedStateMessageIndex = $state({
    index: -1
})

$effect.root(() => {
    $effect(() => {
        if(!chatFoldedState.data){
            return
        }
        const char = DBState.db.characters[selIdState.selId]
        const chat = char.chats[char.chatPage]
        if(chatFoldedState.data.targetCharacterId !== char.chaId){
            chatFoldedState.data = null
        }
        if(chatFoldedState.data.targetChatId !== chat.id){
            chatFoldedState.data = null
        }
    })

    $effect(() => {
        if(chatFoldedState.data === null){
            chatFoldedStateMessageIndex.index = -1
            return
        }
        const char = DBState.db.characters[selIdState.selId]
        const chat = char.chats[char.chatPage]
        const messageIndex = chat.message.findIndex((v) => {
            return chatFoldedState.data?.targetMessageId === v.chatId
        })
        if(messageIndex === -1){
            console.warn('Target message for folding id' + chatFoldedState.data?.targetMessageId + ' not found')
            chatFoldedStateMessageIndex.index = -1
            return
        }
        chatFoldedStateMessageIndex.index = messageIndex
    })
})

export function foldChatToMessage(targetMessageIdOrIndex: string | number) {
    let targetMessageId = ''
    if (typeof targetMessageIdOrIndex === 'number') {
        const char = getCurrentCharacter()
        const chat = char.chats[char.chatPage]
        const message = chat.message[targetMessageIdOrIndex]
        targetMessageId = message.chatId
    }
    else{
        targetMessageId = targetMessageIdOrIndex
    }
    const char = getCurrentCharacter()
    const chat = char.chats[char.chatPage]
    chatFoldedState.data = {
        targetCharacterId: char.chaId,
        targetChatId: chat.id,
        targetMessageId: targetMessageId,
    }
}

export function changeChatTo(IdOrIndex: string | number) {
    let index = -1
    if (typeof IdOrIndex === 'number') {
        index = IdOrIndex
    }

    if (typeof IdOrIndex === 'string') {
        const currentCharacter = getCurrentCharacter()
        index = currentCharacter.chats.findIndex((v) => {
            return v.id === IdOrIndex
        })
    }

    if(index === -1){
        return
    }

    chatDeselected.set(false)
    const char = DBState.db.characters[selIdState.selId]
    char.chatPage = index
    const newChat = char.chats[index]
    if(newChat){
        if(newChat._placeholder){
            const capturedIndex = index
            let cancelled = false
            loadingOverlayStore.set({ active: true, text: language.loading ?? '', onCancel: () => {
                cancelled = true
                chatDeselected.set(true)
                loadingOverlayStore.set({ active: false, text: '', onCancel: null })
            }})
            void ensureChatHydrated(char.chats, capturedIndex, char.chaId).then((hydrated) => {
                if(cancelled) return
                if(hydrated && char.chatPage === capturedIndex) loadTogglesFromChat(hydrated)
            }).catch((e) => {
                console.error('[changeChatTo] hydration failed:', e)
            }).finally(() => {
                if(!cancelled) loadingOverlayStore.set({ active: false, text: '', onCancel: null })
            })
        } else {
            loadTogglesFromChat(newChat)
        }
    }
    ReloadGUIPointer.set(Math.random())
}

export function createChatCopyName(originalName: string,type:'Copy'|'Branch'): string {
    let name = originalName.replaceAll(/\(((Copy|Branch)( \d+)?)\)$/g, '').trim()
    let copyIndex = 1
    let newName = `${name} (${type})`
    const char = getCurrentCharacter()
    while (char.chats.find((v) => v.name === newName)) {
        copyIndex++
        newName = `${name} (${type} ${copyIndex})`
    }
    return newName
}

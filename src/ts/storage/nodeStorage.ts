// ── NodeOnly: server-side JWT ────────────────────────────────────────────────
// Upstream uses client-side ECDSA JWT (crypto.subtle) which requires Secure
// Context (HTTPS/localhost). NodeOnly needs HTTP remote access, so JWT
// signing is moved to the server. The client only caches and forwards
// server-issued tokens. If upstream changes its auth flow, sync manually.
// Server counterpart: server/node/server.cjs (createServerJwt, checkAuth,
// /api/login, /api/token/refresh)
import { language } from "src/lang"
import { alertInput, waitAlert, notifyError } from "../alert"
import { decodeRisuSave, encodeRisuSaveLegacy } from "./risuSave"
import { appVer, nodeOnlyVer, normalizeChat } from "./database.svelte"
import { StartupDatabaseCache } from "./startupDatabaseCache"

const DATABASE_KEY = 'database/database.bin'
// Bump this when decoding the same bytes can produce a different runtime shape.
const STARTUP_DATABASE_SCHEMA_EPOCH = 1

function responseDatabaseEtag(response: Response): string | null {
    const legacy = response.headers.get('x-db-etag')
    if (legacy) return legacy
    const standard = response.headers.get('etag')
    if (!standard) return null
    return standard.replace(/^W\//, '').replace(/^"|"$/g, '') || null
}

// Custom error class for database conflict detection
export class ConflictError extends Error {
    currentEtag: string
    constructor(message: string, currentEtag: string) {
        super(message)
        this.name = 'ConflictError'
        this.currentEtag = currentEtag
    }
}

// Warning the server attaches to /api/patch responses when the most recent
// debounced persist failed (Stage 1 visibility — see issues.md).
export interface PersistWarning {
    timestamp: number
    message: string
    attemptedSize: number | null
    source: string
}

export interface PatchItemResult {
    success: boolean
    etag?: string
    persistWarning?: PersistWarning
    /** Set when the server's chat-internal-field guard rejected the patch. */
    chatGuardRejected?: boolean
    /** A stale database hash/ETag must be rebased, never full-written. */
    conflict?: boolean
    /** The proposed database shape is invalid and must not be retried as full. */
    validationRejected?: boolean
    error?: string
}

export interface StartupDatabaseLoadResult {
    bytes: Uint8Array | null
    decoded: any | null
    etag: string | null
    fromCache: boolean
}

export class ChatConflictError extends Error {
    currentRevision: string | null

    constructor(message: string, currentRevision: string | null = null) {
        super(message)
        this.name = 'ChatConflictError'
        this.currentRevision = currentRevision
    }
}

interface ChatSyncState {
    revision: string
    snapshot: any | null
    encodedBytes: number
}

interface ServerChatSnapshot {
    revision: string
    chat: any
    encodedBytes: number
}

function isPlainJsonValue(value: unknown, seen = new Set<object>()): boolean {
    if (value === null) return true
    if (typeof value === 'string' || typeof value === 'boolean') return true
    if (typeof value === 'number') return Number.isFinite(value)
    if (typeof value !== 'object') return false
    if (seen.has(value)) return false
    seen.add(value)
    try {
        if (Array.isArray(value)) {
            return value.every((entry) => isPlainJsonValue(entry, seen))
        }
        const prototype = Object.getPrototypeOf(value)
        if (prototype !== Object.prototype && prototype !== null) return false
        return Object.values(value as Record<string, unknown>)
            .every((entry) => isPlainJsonValue(entry, seen))
    }
    finally {
        seen.delete(value)
    }
}

export class NodeStorage{
    private static readonly BULK_WRITE_CLIENT_BATCH = 20
    private static readonly MAX_CHAT_SYNC_STATES = 4
    private static readonly MAX_CHAT_SYNC_STATE_BYTES = 16 * 1024 * 1024
    private static readonly MAX_SINGLE_CHAT_SYNC_BYTES = 8 * 1024 * 1024

    // Unique per page load — used for cross-device single-writer lock
    private static sessionId: string =
        crypto?.randomUUID?.() ?? (Date.now().toString(36) + Math.random().toString(36).slice(2))

    _lastDbEtag: string | null = null
    authChecked = false
    private cachedJwt: { token: string; expiresAt: number } | null = null
    private static sessionInitialized = false
    private static sessionPending: Promise<void> | null = null
    private refreshPending: Promise<string> | null = null
    private readonly startupDatabaseCache: StartupDatabaseCache
    private readonly chatSyncStates = new Map<string, ChatSyncState>()
    private readonly chatSaveTails = new Map<string, Promise<void>>()
    private chatSyncStateBytes = 0
    private chatSyncSnapshotCount = 0
    private chatDeltaSupported: boolean | null = null

    constructor(startupDatabaseCache?: StartupDatabaseCache) {
        this.startupDatabaseCache = startupDatabaseCache ?? new StartupDatabaseCache({
            appVersion: `${appVer}:${nodeOnlyVer}`,
            schemaEpoch: STARTUP_DATABASE_SCHEMA_EPOCH,
        })
    }

    async createAuth(){
        const now = Date.now()
        if (this.cachedJwt && this.cachedJwt.expiresAt - now > 30_000) {
            return this.cachedJwt.token
        }
        const token = await this._refreshToken()
        return token
    }

    // Called once after JWT auth is confirmed. Issues a session cookie so that
    // <img src="/api/asset/..."> can be served without JS-injected headers.
    private async initSession() {
        if (NodeStorage.sessionInitialized) return
        if (NodeStorage.sessionPending) return NodeStorage.sessionPending
        NodeStorage.sessionPending = this._doInitSession()
        return NodeStorage.sessionPending
    }

    private async _doInitSession() {
        try {
            const res = await fetch('/api/session', {
                method: 'POST',
                headers: {
                    'risu-auth': await this.createAuth(),
                    'x-session-id': NodeStorage.sessionId,
                },
            })
            if (res.ok) {
                NodeStorage.sessionInitialized = true
            }
            // Non-ok (400/401/500): will retry on next checkAuth() call.
        } catch {
            // Network error: will retry on next checkAuth() call.
        } finally {
            NodeStorage.sessionPending = null
        }
    }

    private async _refreshToken(): Promise<string> {
        if (this.refreshPending) return this.refreshPending
        this.refreshPending = this._doRefreshToken()
        try { return await this.refreshPending }
        finally { this.refreshPending = null }
    }

    private async _doRefreshToken(): Promise<string> {
        const res = await fetch('/api/token/refresh', {
            method: 'POST',
            headers: { 'risu-auth': this.cachedJwt?.token ?? '' }
        })
        if (res.ok) {
            const data = await res.json()
            this.cachedJwt = { token: data.token, expiresAt: Date.now() + 5 * 60 * 1000 }
            return data.token
        }
        return this.cachedJwt?.token ?? ''
    }

    private async loginWithPassword(password: string) {
        const response = await fetch('/api/login', {
            method: "POST",
            body: JSON.stringify({ password }),
            headers: {
                'content-type': 'application/json'
            }
        })

        if(response.status === 429){
            notifyError(`Too many attempts. Please wait and try again later.`)
            await waitAlert()
            throw new Error('Too many login attempts')
        }

        if(response.status < 200 || response.status >= 300){
            let message = 'Node login failed'
            try {
                const data = await response.json()
                message = data.error ?? message
            } catch {
                // noop
            }
            throw new Error(message)
        }

        const data = await response.json()
        if (data.token) {
            this.cachedJwt = { token: data.token, expiresAt: Date.now() + 5 * 60 * 1000 }
        }
        this.authChecked = true
    }

    private async shouldRetryAuth(response: Response) {
        if(response.status !== 400 && response.status !== 401){
            return false
        }

        try {
            const data = await response.clone().json()
            return [
                'No auth header',
                'Invalid Signature',
                'Token Expired'
            ].includes(data?.error)
        } catch {
            return false
        }
    }

    private async authFetch(input: RequestInfo | URL, init: RequestInit = {}, retry = true) {
        await this.checkAuth()
        const headers = new Headers(init.headers)
        headers.set('risu-auth', await this.createAuth())
        headers.set('x-session-id', NodeStorage.sessionId)

        const response = await fetch(input, {
            ...init,
            headers
        })

        if (response.status === 423) {
            window.dispatchEvent(new CustomEvent('risu-session-deactivated'))
        }

        if(retry && await this.shouldRetryAuth(response)){
            this.authChecked = false
            this.cachedJwt = null
            await this.checkAuth()
            return this.authFetch(input, init, false)
        }

        return response
    }

    private databaseReadHeaders(): Record<string, string> {
        return {
            'file-path': Buffer.from(DATABASE_KEY, 'utf-8').toString('hex'),
        }
    }

    private async readDatabaseUnconditionally(): Promise<StartupDatabaseLoadResult> {
        const response = await this.authFetch('/api/read', {
            method: 'GET',
            headers: this.databaseReadHeaders(),
        })
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`getItem Error (${response.status})`)
        }

        const etag = responseDatabaseEtag(response)
        if (etag) this._lastDbEtag = etag
        const bytes = new Uint8Array(await response.arrayBuffer())
        return {
            bytes: bytes.byteLength > 0 ? bytes : null,
            decoded: null,
            etag,
            fromCache: false,
        }
    }

    /**
     * Revalidate the startup cache before reading it. A cached object is never
     * trusted on its own: the authenticated server must first answer 304 for
     * the exact cached ETag. Missing/corrupt cache data falls back to a fresh
     * unconditional response in the same call.
     */
    async loadDatabaseForStartup(): Promise<StartupDatabaseLoadResult> {
        const probe = await this.startupDatabaseCache.probe()
        if (!probe) return this.readDatabaseUnconditionally()

        const headers = this.databaseReadHeaders()
        headers['if-none-match'] = probe.etag
        const response = await this.authFetch('/api/read', { method: 'GET', headers })

        if (response.status === 304) {
            const hit = await this.startupDatabaseCache.resolveNotModified(probe.etag, {
                validateDecoded: (database) => !!database
                    && typeof database === 'object'
                    && !Array.isArray(database),
            })
            if (hit?.kind === 'decoded') {
                this._lastDbEtag = hit.etag
                return {
                    bytes: null,
                    decoded: hit.database,
                    etag: hit.etag,
                    fromCache: true,
                }
            }
            if (hit?.kind === 'raw') {
                this._lastDbEtag = hit.etag
                return {
                    bytes: hit.bytes,
                    decoded: null,
                    etag: hit.etag,
                    fromCache: true,
                }
            }

            // The server confirmed the metadata but the matching body was
            // evicted/corrupt. Retry without the validator instead of treating
            // an empty 304 response as a new database.
            await this.startupDatabaseCache.invalidate()
            return this.readDatabaseUnconditionally()
        }

        if (response.status < 200 || response.status >= 300) {
            throw new Error(`getItem Error (${response.status})`)
        }
        const etag = responseDatabaseEtag(response)
        if (etag) this._lastDbEtag = etag
        const bytes = new Uint8Array(await response.arrayBuffer())
        return {
            bytes: bytes.byteLength > 0 ? bytes : null,
            decoded: null,
            etag,
            fromCache: false,
        }
    }

    /** Schedule large CacheStorage/IndexedDB writes outside the boot path. */
    scheduleStartupDatabaseCache(bytes: Uint8Array, decoded: any, etag = this._lastDbEtag): void {
        if (!etag || !bytes?.byteLength || !decoded) return
        const write = () => {
            void this.startupDatabaseCache.storeAuthoritative({ etag, bytes, decoded })
                .catch(() => undefined)
        }
        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(write, { timeout: 2_000 })
        }
        else {
            setTimeout(write, 0)
        }
    }

    async invalidateStartupDatabaseCache(): Promise<void> {
        await this.startupDatabaseCache.invalidate()
    }

    private async invalidateAfterDatabaseReplacement(): Promise<void> {
        this._lastDbEtag = null
        this.chatSyncStates.clear()
        this.chatSyncStateBytes = 0
        this.chatSyncSnapshotCount = 0
        this.chatDeltaSupported = null
        await this.startupDatabaseCache.invalidate()
    }

    async setItem(key:string, value:Uint8Array, etag?:string) {
        const headers: Record<string, string> = {
            'content-type': 'application/octet-stream',
            'file-path': Buffer.from(key, 'utf-8').toString('hex')
        }
        if (etag) {
            headers['x-if-match'] = etag
        }
        const da = await this.authFetch('/api/write', {
            method: "POST",
            body: value as any,
            headers
        })
        if(da.status === 409){
            const data = await da.json()
            throw new ConflictError(data.error, data.currentEtag)
        }
        if(da.status < 200 || da.status >= 300){
            const data = await da.clone().json().catch(() => ({}))
            throw new Error(data?.detail || data?.error || `setItem Error (${da.status})`)
        }
        const data = await da.json()
        if(data.error){
            throw data.error
        }
        const nextEtag = data.etag as string | undefined
        if (key === DATABASE_KEY) {
            if (nextEtag) this._lastDbEtag = nextEtag
            // The server may canonicalize/split the submitted bytes before
            // hashing them, so never label the outgoing body with its ETag.
            void this.startupDatabaseCache.invalidate().catch(() => undefined)
        }
    }
    async getItem(key:string):Promise<Buffer> {
        const headers: Record<string, string> = {
            'file-path': Buffer.from(key, 'utf-8').toString('hex')
        }

        const da = await this.authFetch('/api/read', { method: "GET", headers })
        if(da.status < 200 || da.status >= 300){
            throw "getItem Error"
        }

        // Capture ETag for database.bin
        const etag = responseDatabaseEtag(da)
        if (etag) {
            this._lastDbEtag = etag
        }

        const data = Buffer.from(await da.arrayBuffer())
        if (data.length === 0){
            return null
        }

        return data
    }

    async getItemFresh(key: string): Promise<Buffer> {
        if (key === DATABASE_KEY) {
            await this.startupDatabaseCache.invalidate()
        }
        return this.getItem(key)
    }
    async keys(prefix: string = ''):Promise<string[]>{
        const headers: Record<string, string> = {
        }
        if (prefix) {
            headers['key-prefix'] = prefix
        }
        const da = await this.authFetch('/api/list', {
            method: "GET",
            headers
        })
        if(da.status < 200 || da.status >= 300){
            throw "listItem Error"
        }
        const data = await da.json()
        if(data.error){
            throw data.error
        }
        return data.content
    }
    async removeItem(key:string){
        const da = await this.authFetch('/api/remove', {
            method: "GET",
            headers: {
                'file-path': Buffer.from(key, 'utf-8').toString('hex')
            }
        })
        if(da.status < 200 || da.status >= 300){
            throw "removeItem Error"
        }
        const data = await da.json()
        if(data.error){
            throw data.error
        }
        if (key === DATABASE_KEY) {
            this._lastDbEtag = null
            void this.startupDatabaseCache.invalidate().catch(() => undefined)
        }
    }

    private async checkAuth(){

        if(!this.authChecked){
            const data = await (await fetch('/api/test_auth',{
                headers: {
                    'risu-auth': this.cachedJwt?.token ?? ''
                }
            })).json()

            if(data.status === 'unset'){
                const input = await digestPassword(await alertInput(language.setNodePassword))
                const response = await fetch('/api/set_password',{
                    method: "POST",
                    body:JSON.stringify({
                        password: input 
                    }),
                    headers: {
                        'content-type': 'application/json'
                    }
                })

                if(response.status < 200 || response.status >= 300){
                    throw new Error('Failed to set node password')
                }

                await this.loginWithPassword(input)
                await this.initSession()
                return
            }
            else if(data.status === 'incorrect'){
                const input = await digestPassword(await alertInput(language.inputNodePassword))
                await this.loginWithPassword(input)
                await this.initSession()
                return
            }
            else{
                if (data.token) {
                    this.cachedJwt = { token: data.token, expiresAt: Date.now() + 5 * 60 * 1000 }
                }
                this.authChecked = true
            }
        }
        await this.initSession()
    }

    listItem = this.keys

    /** Set cached ETag for database.bin */
    setDbEtag(etag: string | null) {
        this._lastDbEtag = etag
    }

    async patchItem(key: string, patchData: { patch: any[], expectedHash: string }): Promise<PatchItemResult> {
        const previousEtag = key === DATABASE_KEY ? this._lastDbEtag : null
        const da = await this.authFetch('/api/patch', {
            method: "POST",
            body: JSON.stringify(patchData),
            headers: {
                'content-type': 'application/json',
                'file-path': Buffer.from(key, 'utf-8').toString('hex')
            }
        })

        if (da.status === 409) {
            const data = await da.json()
            const currentEtag = data.currentEtag as string | undefined
            // Server signals chat-guard rejection via explicit fields. The
            // error string fallback is kept for forward-compat with deployed
            // servers that haven't shipped the explicit fields yet.
            const rejectedByChatGuard = data.chatGuardRejected === true
                || data.code === 'CHAT_GUARD_REJECTED'
                || (typeof data.error === 'string' && data.error.includes('chat-internal field ops'))
            const rejectedByValidation = data.code === 'DB_INVARIANT_REJECTED'
            return {
                success: false,
                etag: currentEtag,
                chatGuardRejected: rejectedByChatGuard,
                validationRejected: rejectedByValidation,
                conflict: !rejectedByChatGuard && !rejectedByValidation,
                error: typeof data.detail === 'string' ? data.detail : data.error,
            }
        }
        if (da.status < 200 || da.status >= 300) {
            return { success: false }
        }
        const data = await da.json()
        if (data.error) {
            return { success: false }
        }
        const nextEtag = data.etag as string | undefined
        if (key === DATABASE_KEY && nextEtag) {
            this._lastDbEtag = nextEtag
            if (previousEtag) {
                void this.startupDatabaseCache.recordPatch({
                    previousEtag,
                    nextEtag,
                    patch: patchData.patch,
                }).catch(() => undefined)
            }
        }
        const persistWarning = data.persistWarning as PersistWarning | undefined
        return { success: true, etag: nextEtag, persistWarning }
    }

    // ── Bulk asset operations (3-2-B) ──────────────────────────────────────────
    async getItems(keys: string[]): Promise<{key: string, value: Buffer}[]> {
        const da = await this.authFetch('/api/assets/bulk-read', {
            method: 'POST',
            body: JSON.stringify(keys),
            headers: {
                'content-type': 'application/json',
                'accept': 'application/octet-stream'
            }
        })
        if (da.status < 200 || da.status >= 300) throw 'getItems Error'

        const ct = da.headers.get('content-type') || ''
        if (ct.includes('application/octet-stream')) {
            // Binary protocol: [count(4)] then per entry: [keyLen(4)][key][valLen(4)][value]
            const buf = Buffer.from(await da.arrayBuffer())
            let offset = 0
            const count = buf.readUInt32BE(offset); offset += 4
            const results: {key: string, value: Buffer}[] = []
            for (let i = 0; i < count; i++) {
                const keyLen = buf.readUInt32BE(offset); offset += 4
                const key = buf.subarray(offset, offset + keyLen).toString('utf-8'); offset += keyLen
                const valLen = buf.readUInt32BE(offset); offset += 4
                const value = buf.subarray(offset, offset + valLen) as Buffer; offset += valLen
                results.push({ key, value })
            }
            return results
        }

        // Fallback: JSON+base64
        const results: {key: string, value: string}[] = await da.json()
        return results.map(r => ({ key: r.key, value: Buffer.from(r.value, 'base64') }))
    }

    async setItems(entries: {key: string, value: Uint8Array}[]) {
        for (let i = 0; i < entries.length; i += NodeStorage.BULK_WRITE_CLIENT_BATCH) {
            const batch = entries.slice(i, i + NodeStorage.BULK_WRITE_CLIENT_BATCH)
            const body = batch.map(e => ({
                key: e.key,
                value: Buffer.from(e.value).toString('base64')
            }))
            const da = await this.authFetch('/api/assets/bulk-write', {
                method: 'POST',
                body: JSON.stringify(body),
                headers: {
                    'content-type': 'application/json'
                }
            })
            if (da.status < 200 || da.status >= 300) throw 'setItems Error'
        }
    }

    async exportBackup(opts?: { target?: 'upstream' }): Promise<Response> {
        const url = opts?.target === 'upstream'
            ? '/api/backup/export?target=upstream'
            : '/api/backup/export'
        const da = await this.authFetch(url)
        if (da.status < 200 || da.status >= 300) throw `backup export error: ${da.status}`
        return da
    }

    async prepareImport(size: number): Promise<void> {
        const da = await this.authFetch('/api/backup/import/prepare', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ size }),
        })
        if (da.status === 409) throw new Error('Another import is already in progress')
        if (da.status === 413) throw new Error('Backup file is too large')
        if (da.status === 507) {
            const body = await da.json().catch(() => ({}))
            const avail = body.available != null ? ` (available: ${Math.round(body.available / 1024 / 1024)} MB)` : ''
            throw new Error(`Insufficient disk space${avail}`)
        }
        if (da.status < 200 || da.status >= 300) throw new Error(`backup prepare error: ${da.status}`)
    }

    async importBackup(
        file: Blob,
        onProgress?: (loaded: number, total: number) => void
    ): Promise<{ok: boolean, assetsRestored: number, coldStorageFailed?: number}> {
        await this.prepareImport(file.size)
        const authHeader = await this.createAuth()

        const result = await new Promise<{ok: boolean, assetsRestored: number, coldStorageFailed?: number}>((resolve, reject) => {
            const xhr = new XMLHttpRequest()
            xhr.open('POST', '/api/backup/import')
            xhr.setRequestHeader('content-type', 'application/x-risu-backup')
            xhr.setRequestHeader('risu-auth', authHeader)
            xhr.setRequestHeader('x-session-id', NodeStorage.sessionId)
            // Opt into NDJSON streaming so the server keeps the response socket
            // alive during long post-upload work — prevents reverse-proxy 502s.
            xhr.setRequestHeader('accept', 'application/x-ndjson')

            let uploadComplete = false
            xhr.upload.onprogress = (event) => {
                if (event.lengthComputable) {
                    onProgress?.(event.loaded, event.total)
                }
            }
            xhr.upload.onload = () => { uploadComplete = true }

            let parsedIndex = 0
            let leftover = ''
            let result: {ok: boolean, assetsRestored: number, coldStorageFailed?: number} | null = null
            let serverErrorMsg: string | null = null

            const drainNdjson = () => {
                const text = xhr.responseText
                if (text.length <= parsedIndex) return
                leftover += text.slice(parsedIndex)
                parsedIndex = text.length
                const lines = leftover.split('\n')
                leftover = lines.pop() ?? ''
                for (const line of lines) {
                    if (!line) continue
                    let msg: any
                    try { msg = JSON.parse(line) } catch { continue }
                    if (msg.type === 'progress' && uploadComplete) {
                        // After upload finishes, surface server-side processing
                        // progress through the same callback for UI continuity.
                        onProgress?.(msg.bytes, msg.totalBytes)
                    } else if (msg.type === 'done') {
                        result = msg
                    } else if (msg.type === 'error') {
                        serverErrorMsg = typeof msg.message === 'string' ? msg.message : 'backup import failed'
                    }
                    // Ignore 'heartbeat' and unknown event types.
                }
            }

            xhr.onprogress = drainNdjson
            xhr.onerror = () => reject(new Error('backup import request failed'))
            xhr.onload = () => {
                if (xhr.status < 200 || xhr.status >= 300) {
                    let msg = `backup import error: ${xhr.status}`
                    try {
                        const body = JSON.parse(xhr.responseText)
                        if (body?.error) msg = String(body.error)
                    } catch {}
                    reject(new Error(msg))
                    return
                }
                drainNdjson()
                if (serverErrorMsg) reject(new Error(serverErrorMsg))
                else if (result) resolve(result)
                else reject(new Error('backup import: no result received'))
            }

            xhr.send(file)
        })
        await this.invalidateAfterDatabaseReplacement()
        return result
    }

    // ── Server-side backup ─────────────────────────────────────────────────────

    async saveServerBackup(
        onProgress?: (current: number, total: number, bytes: number, totalBytes: number) => void
    ): Promise<{ok: boolean, filename: string, size: number}> {
        const da = await this.authFetch('/api/backup/server/save', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-session-id': NodeStorage.sessionId,
            },
        })
        if (da.status < 200 || da.status >= 300) {
            const body = await da.json().catch(() => ({}))
            throw new Error(body.error || `server backup save error: ${da.status}`)
        }

        const reader = da.body!.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let result: {ok: boolean, filename: string, size: number} | null = null

        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop()!
            for (const line of lines) {
                if (!line) continue
                const msg = JSON.parse(line)
                if (msg.type === 'progress') {
                    onProgress?.(msg.current, msg.total, msg.bytes, msg.totalBytes)
                } else if (msg.type === 'done') {
                    result = msg
                } else if (msg.type === 'error') {
                    throw new Error(msg.message)
                }
            }
        }
        if (!result) throw new Error('Server backup: no result received')
        return result
    }

    async listServerBackups(): Promise<{backups: Array<{filename: string, size: number, createdAt: number}>}> {
        const da = await this.authFetch('/api/backup/server/list')
        if (da.status < 200 || da.status >= 300) throw new Error(`server backup list error: ${da.status}`)
        return da.json()
    }

    async restoreServerBackup(
        filename: string,
        onProgress?: (bytes: number, totalBytes: number) => void
    ): Promise<{ok: boolean, assetsRestored: number, coldStorageFailed?: number}> {
        const da = await this.authFetch('/api/backup/server/restore', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-session-id': NodeStorage.sessionId,
            },
            body: JSON.stringify({ filename }),
        })
        if (da.status === 404) throw new Error('Backup file not found')
        if (da.status === 409) throw new Error('Another import is already in progress')
        if (da.status < 200 || da.status >= 300) {
            const body = await da.json().catch(() => ({}))
            throw new Error(body.error || `server backup restore error: ${da.status}`)
        }

        const reader = da.body!.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let result: {ok: boolean, assetsRestored: number, coldStorageFailed?: number} | null = null

        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop()!
            for (const line of lines) {
                if (!line) continue
                const msg = JSON.parse(line)
                if (msg.type === 'progress') {
                    onProgress?.(msg.bytes, msg.totalBytes)
                } else if (msg.type === 'done') {
                    result = msg
                } else if (msg.type === 'error') {
                    throw new Error(msg.message)
                }
            }
        }
        if (!result) throw new Error('Server backup restore: no result received')
        await this.invalidateAfterDatabaseReplacement()
        return result
    }

    async deleteServerBackup(filename: string): Promise<void> {
        const da = await this.authFetch(`/api/backup/server/${encodeURIComponent(filename)}`, {
            method: 'DELETE',
        })
        if (da.status === 404) throw new Error('Backup file not found')
        if (da.status < 200 || da.status >= 300) throw new Error(`server backup delete error: ${da.status}`)
    }

    async downloadServerBackup(filename: string): Promise<Response> {
        const da = await this.authFetch(`/api/backup/server/download/${encodeURIComponent(filename)}`)
        if (da.status === 404) throw new Error('Backup file not found')
        if (da.status < 200 || da.status >= 300) throw new Error(`server backup download error: ${da.status}`)
        return da
    }

    // ── Chat content (runtime lazy load) ────────────────────────────────────

    private chatSyncKey(chaId: string, chatId: string): string {
        return `${chaId}|${chatId}`
    }

    private forgetChatSyncState(key: string): void {
        const previous = this.chatSyncStates.get(key)
        if (previous?.snapshot) {
            this.chatSyncStateBytes -= previous.encodedBytes
            this.chatSyncSnapshotCount -= 1
        }
        this.chatSyncStates.delete(key)
    }

    private rememberChatSyncState(
        key: string,
        revision: string,
        chat: any,
        encodedBytes: number,
    ): void {
        this.forgetChatSyncState(key)

        let snapshot: any | null = null
        let retainedBytes = 0
        if (
            isPlainJsonValue(chat)
            && encodedBytes > 0
            && encodedBytes <= NodeStorage.MAX_SINGLE_CHAT_SYNC_BYTES
        ) {
            try {
                snapshot = structuredClone(chat)
                retainedBytes = encodedBytes
            } catch {
                snapshot = null
            }
        }

        this.chatSyncStates.set(key, {
            revision,
            snapshot,
            encodedBytes: retainedBytes,
        })
        if (snapshot) {
            this.chatSyncStateBytes += retainedBytes
            this.chatSyncSnapshotCount += 1
        }

        // Keep revisions for CAS safety, but discard old deep snapshots first.
        // This bounds the mobile-memory multiplier without allowing an evicted
        // existing chat to fall back to an unconditional full overwrite.
        while (
            this.chatSyncSnapshotCount > NodeStorage.MAX_CHAT_SYNC_STATES
            || this.chatSyncStateBytes > NodeStorage.MAX_CHAT_SYNC_STATE_BYTES
        ) {
            const oldest = [...this.chatSyncStates.entries()]
                .find(([, state]) => state.snapshot !== null)
            if (!oldest) break
            const [oldestKey, state] = oldest
            this.chatSyncStateBytes -= state.encodedBytes
            this.chatSyncSnapshotCount -= 1
            this.chatSyncStates.set(oldestKey, {
                ...state,
                snapshot: null,
                encodedBytes: 0,
            })
        }
    }

    private chatRevisionFromResponse(response: Response, body?: any): string | null {
        return response.headers.get('x-chat-revision')
            ?? response.headers.get('etag')?.replace(/^W\//, '').replace(/^"|"$/g, '')
            ?? (typeof body?.revision === 'string' ? body.revision : null)
            ?? (typeof body?.currentRevision === 'string' ? body.currentRevision : null)
    }

    /**
     * Read a chat without changing the local sync baseline. Callers decide
     * whether the returned snapshot is safe to adopt. This distinction is
     * important after a lost save acknowledgement: adopting a different
     * server snapshot would make the next retry overwrite a real conflict.
     */
    private async readServerChatSnapshot(
        chaId: string,
        chatIndex: number,
        chatId: string,
    ): Promise<ServerChatSnapshot | null> {
        const response = await this.authFetch(
            `/api/chat-content/${encodeURIComponent(chaId)}/${chatIndex}`,
            {
                cache: 'no-store',
                headers: { 'x-chat-id': chatId },
            },
        )
        if (response.status === 404) return null
        if (response.status === 409 || response.status === 412) {
            const body = await response.clone().json().catch(() => ({}))
            throw new ChatConflictError(
                body?.error || 'Chat changed on the server',
                this.chatRevisionFromResponse(response, body),
            )
        }
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`fetchChatContent error: ${response.status}`)
        }

        const buffer = new Uint8Array(await response.arrayBuffer())
        const chat = normalizeChat(await decodeRisuSave(buffer))
        if (chat?.id !== chatId || !Array.isArray(chat?.message)) {
            throw new Error('fetchChatContent returned an invalid or mismatched chat')
        }
        const revision = this.chatRevisionFromResponse(response)
        if (!revision) {
            throw new Error('fetchChatContent returned no chat revision')
        }
        return {
            revision,
            chat,
            encodedBytes: buffer.byteLength,
        }
    }

    private async confirmCurrentSnapshotOnServer(
        chaId: string,
        chatIndex: number,
        chatId: string,
        currentSnapshot: any,
        encodedBytes: number,
    ): Promise<{ confirmed: boolean, currentRevision: string | null }> {
        try {
            const serverSnapshot = await this.readServerChatSnapshot(chaId, chatIndex, chatId)
            if (!serverSnapshot || !isPlainJsonValue(serverSnapshot.chat)) {
                return { confirmed: false, currentRevision: null }
            }
            const { compare } = await import('fast-json-patch')
            if (compare(serverSnapshot.chat, currentSnapshot).length !== 0) {
                return {
                    confirmed: false,
                    currentRevision: serverSnapshot.revision,
                }
            }

            this.rememberChatSyncState(
                this.chatSyncKey(chaId, chatId),
                serverSnapshot.revision,
                currentSnapshot,
                encodedBytes,
            )
            this.chatDeltaSupported = true
            return {
                confirmed: true,
                currentRevision: serverSnapshot.revision,
            }
        }
        catch (error) {
            return {
                confirmed: false,
                currentRevision: error instanceof ChatConflictError
                    ? error.currentRevision
                    : null,
            }
        }
    }

    async fetchChatContent(chaId: string, chatIndex: number, chatId: string): Promise<any | null> {
        const serverSnapshot = await this.readServerChatSnapshot(chaId, chatIndex, chatId)
        if (!serverSnapshot) return null
        this.rememberChatSyncState(
            this.chatSyncKey(chaId, chatId),
            serverSnapshot.revision,
            serverSnapshot.chat,
            serverSnapshot.encodedBytes,
        )
        this.chatDeltaSupported = true
        return serverSnapshot.chat
    }

    async saveChatContent(chaId: string, chatIndex: number, chatId: string, chat: any): Promise<void> {
        const key = this.chatSyncKey(chaId, chatId)
        const previous = this.chatSaveTails.get(key) ?? Promise.resolve()
        const operation = previous
            .catch(() => undefined)
            .then(() => this.saveChatContentSerialized(chaId, chatIndex, chatId, chat))
        this.chatSaveTails.set(key, operation)
        try {
            await operation
        }
        finally {
            if (this.chatSaveTails.get(key) === operation) {
                this.chatSaveTails.delete(key)
            }
        }
    }

    private async saveChatContentSerialized(
        chaId: string,
        chatIndex: number,
        chatId: string,
        chat: any,
    ): Promise<void> {
        const encoded = encodeRisuSaveLegacy(chat)
        const currentSnapshot = normalizeChat(await decodeRisuSave(encoded))
        if (currentSnapshot?.id !== chatId || !Array.isArray(currentSnapshot?.message)) {
            throw new Error('Refusing to save an invalid or mismatched chat')
        }

        const syncKey = this.chatSyncKey(chaId, chatId)
        let syncState = this.chatSyncStates.get(syncKey)
        let createOnly = false

        // A missing revision is not permission to overwrite an existing chat.
        // Existing chats are first fetched to seed a delta/CAS baseline. Only
        // an authoritative 404 enables a create-only full save below.
        if (!syncState?.revision) {
            let serverSnapshot: ServerChatSnapshot | null
            try {
                serverSnapshot = await this.readServerChatSnapshot(chaId, chatIndex, chatId)
            }
            catch (error) {
                throw new ChatConflictError(
                    `Could not establish a safe chat save baseline: ${String(error)}`,
                    error instanceof ChatConflictError ? error.currentRevision : null,
                )
            }
            if (serverSnapshot) {
                this.rememberChatSyncState(
                    syncKey,
                    serverSnapshot.revision,
                    serverSnapshot.chat,
                    serverSnapshot.encodedBytes,
                )
                this.chatDeltaSupported = true
                syncState = this.chatSyncStates.get(syncKey)
            }
            else {
                createOnly = true
            }
        }
        if (
            syncState?.snapshot
            && this.chatDeltaSupported !== false
            && isPlainJsonValue(currentSnapshot)
        ) {
            const { compare } = await import('fast-json-patch')
            const patch = compare(syncState.snapshot, currentSnapshot)
            if (patch.length === 0) return

            const deltaBody = JSON.stringify({
                baseRevision: syncState.revision,
                patch,
            })
            const deltaBytes = Buffer.byteLength(deltaBody, 'utf-8')
            const deltaIsWorthwhile = deltaBytes <= 1_500_000
                && deltaBytes < encoded.byteLength * 0.8

            if (deltaIsWorthwhile) {
                let deltaResponse: Response
                try {
                    deltaResponse = await this.authFetch(
                        `/api/chat-content/${encodeURIComponent(chaId)}/${chatIndex}/patch`,
                        {
                            method: 'POST',
                            headers: {
                                'content-type': 'application/json',
                                'x-chat-id': chatId,
                            },
                            body: deltaBody,
                        },
                    )
                }
                catch (error) {
                    // The server may have committed before the connection was
                    // lost. Confirm the desired snapshot with a fresh GET; if it
                    // matches, the missing response was only a lost ACK.
                    const confirmation = await this.confirmCurrentSnapshotOnServer(
                        chaId,
                        chatIndex,
                        chatId,
                        currentSnapshot,
                        encoded.byteLength,
                    )
                    if (confirmation.confirmed) return
                    throw new ChatConflictError(
                        `Incremental chat save could not be confirmed: ${String(error)}`,
                        confirmation.currentRevision ?? syncState.revision,
                    )
                }

                const deltaResult = await deltaResponse.clone().json().catch(() => ({}))
                if (deltaResponse.status >= 200 && deltaResponse.status < 300) {
                    const revision = this.chatRevisionFromResponse(deltaResponse, deltaResult)
                    if (revision) {
                        this.rememberChatSyncState(
                            syncKey,
                            revision,
                            currentSnapshot,
                            encoded.byteLength,
                        )
                    }
                    else {
                        this.forgetChatSyncState(syncKey)
                    }
                    this.chatDeltaSupported = true
                    return
                }
                if (deltaResponse.status === 409 || deltaResponse.status === 404) {
                    if (deltaResponse.status === 409) {
                        const confirmation = await this.confirmCurrentSnapshotOnServer(
                            chaId,
                            chatIndex,
                            chatId,
                            currentSnapshot,
                            encoded.byteLength,
                        )
                        if (confirmation.confirmed) return
                        throw new ChatConflictError(
                            deltaResult?.error || 'Chat changed on the server',
                            confirmation.currentRevision
                                ?? this.chatRevisionFromResponse(deltaResponse, deltaResult),
                        )
                    }
                    throw new ChatConflictError(
                        'Chat was removed or replaced on the server',
                        this.chatRevisionFromResponse(deltaResponse, deltaResult),
                    )
                }
                if (deltaResponse.status === 405 || deltaResponse.status === 501) {
                    // Older servers can still accept the full endpoint. Keep the
                    // base revision header so compatible servers retain CAS.
                    this.chatDeltaSupported = false
                }
                else if (deltaResponse.status !== 400 && deltaResponse.status !== 413) {
                    throw new Error(`saveChatContent patch error: ${deltaResponse.status}`)
                }
            }
        }

        const headers: Record<string, string> = {
            'content-type': 'application/octet-stream',
            'x-chat-id': chatId,
        }
        if (syncState?.revision) {
            headers['x-chat-base-revision'] = syncState.revision
        }
        else if (createOnly) {
            headers['if-none-match'] = '*'
        }
        let da: Response
        try {
            da = await this.authFetch(`/api/chat-content/${encodeURIComponent(chaId)}/${chatIndex}`, {
                method: 'POST',
                headers,
                body: encoded,
            })
        }
        catch (error) {
            const confirmation = await this.confirmCurrentSnapshotOnServer(
                chaId,
                chatIndex,
                chatId,
                currentSnapshot,
                encoded.byteLength,
            )
            if (confirmation.confirmed) return
            throw new ChatConflictError(
                `Full chat save could not be confirmed: ${String(error)}`,
                confirmation.currentRevision ?? syncState?.revision ?? null,
            )
        }
        const result = await da.clone().json().catch(() => ({}))
        if (da.status === 409 || da.status === 412) {
            const confirmation = await this.confirmCurrentSnapshotOnServer(
                chaId,
                chatIndex,
                chatId,
                currentSnapshot,
                encoded.byteLength,
            )
            if (confirmation.confirmed) return
            throw new ChatConflictError(
                result?.error || 'Chat changed on the server',
                confirmation.currentRevision ?? this.chatRevisionFromResponse(da, result),
            )
        }
        if (da.status < 200 || da.status >= 300) throw new Error(`saveChatContent error: ${da.status}`)
        const revision = this.chatRevisionFromResponse(da, result)
        if (revision) {
            this.rememberChatSyncState(
                syncKey,
                revision,
                currentSnapshot,
                encoded.byteLength,
            )
            this.chatDeltaSupported = true
        }
        else {
            this.forgetChatSyncState(syncKey)
            this.chatDeltaSupported = false
        }
    }

    // ── Save-folder migration ─────────────────────────────────────────────────

    async scanSaveFolder(folderPath?: string): Promise<{count: number, totalSize: number, hasDatabase: boolean}> {
        const da = await this.authFetch('/api/migrate/save-folder/scan', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: folderPath }),
        })
        if (da.status < 200 || da.status >= 300) {
            const body = await da.json().catch(() => ({}))
            throw new Error(body.error || `scan error: ${da.status}`)
        }
        return da.json()
    }

    async executeSaveFolderImport(folderPath?: string): Promise<{ok: boolean, imported: number}> {
        const da = await this.authFetch('/api/migrate/save-folder/execute', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: folderPath }),
        })
        if (da.status === 409) throw new Error('Another import is already in progress')
        if (da.status < 200 || da.status >= 300) {
            const body = await da.json().catch(() => ({}))
            throw new Error(body.error || `import error: ${da.status}`)
        }
        const result = await da.json()
        await this.invalidateAfterDatabaseReplacement()
        return result
    }

    async uploadSaveFolderZip(
        file: Blob,
        onProgress?: (loaded: number, total: number) => void
    ): Promise<{ok: boolean, imported: number}> {
        const authHeader = await this.createAuth()

        const result = await new Promise<{ok: boolean, imported: number}>((resolve, reject) => {
            const xhr = new XMLHttpRequest()
            xhr.open('POST', '/api/migrate/save-folder/upload')
            xhr.setRequestHeader('content-type', 'application/zip')
            xhr.setRequestHeader('risu-auth', authHeader)
            xhr.setRequestHeader('x-session-id', NodeStorage.sessionId)

            xhr.upload.onprogress = (event) => {
                if (event.lengthComputable) {
                    onProgress?.(event.loaded, event.total)
                }
            }

            xhr.onerror = () => reject(new Error('zip upload failed'))
            xhr.onload = () => {
                if (xhr.status < 200 || xhr.status >= 300) {
                    let msg = `zip import error: ${xhr.status}`
                    try { msg = JSON.parse(xhr.responseText).error || msg } catch {}
                    reject(new Error(msg))
                    return
                }
                try {
                    resolve(JSON.parse(xhr.responseText))
                } catch (error) {
                    reject(error)
                }
            }

            xhr.send(file)
        })
        await this.invalidateAfterDatabaseReplacement()
        return result
    }

    async scanCleanup(): Promise<{count: number, totalSize: number}> {
        const da = await this.authFetch('/api/migrate/save-folder/cleanup/scan', {
            method: 'POST',
        })
        if (da.status < 200 || da.status >= 300) {
            const body = await da.json().catch(() => ({}))
            throw new Error(body.error || `cleanup scan error: ${da.status}`)
        }
        return da.json()
    }

    async executeCleanup(): Promise<{ok: boolean, removed: number, freedBytes: number}> {
        const da = await this.authFetch('/api/migrate/save-folder/cleanup/execute', {
            method: 'POST',
        })
        if (da.status < 200 || da.status >= 300) {
            const body = await da.json().catch(() => ({}))
            throw new Error(body.error || `cleanup error: ${da.status}`)
        }
        return da.json()
    }

}

async function digestPassword(message:string) {
    const res = await fetch('/api/crypto', {
        body: JSON.stringify({
            data: message
        }),
        headers: {
            'content-type': 'application/json'
        },
        method: "POST"
    })
    if(res.status < 200 || res.status >= 300){
        throw new Error(`Password hashing failed (${res.status})`)
    }
    return await res.text()
}

import { v4 } from "uuid";
import { getImageType } from "src/ts/media";
import { getDatabase } from "../../storage/database.svelte";
import { getModelInfo, LLMFlags, LLMFormat } from "src/ts/model/modellist";
import { asBuffer } from "../../util";
import { NodeStorage } from "../../storage/nodeStorage";
import { forageStorage } from "../../globalApi.svelte";
import {
    type InlayAssetMeta,
    buildInlayMeta,
    getInlayMeta,
    getInlayMetasBatch,
    removeInlayMeta,
    setInlayMeta,
} from "./inlayMeta";

export type InlayAsset = {
    data: string | Blob
    /** File extension */
    ext: string
    height?: number
    name: string
    type: 'image' | 'video' | 'audio' | 'signature'
    width?: number
}

/** Serialized form for server storage (Blob → base64 string) */
type SerializedInlayAsset = {
    data: string
    ext: string
    height?: number
    name: string
    type: 'image' | 'video' | 'audio' | 'signature'
    width?: number
}

export type InlayExplorerInfo = {
    ext: string
    height?: number
    name: string
    type: InlayAsset['type']
    width?: number
}

export type InlayExplorerItem = {
    ext: string
    hasMeta: boolean
    height?: number
    id: string
    meta: InlayAssetMeta | null
    name: string
    type: InlayAsset['type'] | 'unknown'
    width?: number
}

export type CharacterChatIndexItem = {
    chaId: string
    chats: {
        id: string
        name: string
    }[]
    name: string
}

const inlayImageExts = [
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif'
]

const inlayAudioExts = [
    'wav', 'mp3', 'ogg', 'flac'
]

const inlayVideoExts = [
    'webm', 'mp4', 'mkv'
]

const INLAY_PREFIX = 'inlay/'
const INLAY_INFO_PREFIX = 'inlay_info/'

// ── Memory LRU cache ──
type LRUEntry = {
    asset: InlayAsset
    lastAccessed: number
    size: number
}
const inlayLRUCache = new Map<string, LRUEntry>()
let totalLRUSize = 0

const MB = 1024 * 1024

function getNavigatorDeviceMemory(): number | undefined {
    if (typeof navigator === 'undefined') {
        return undefined
    }

    const value = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return undefined
    }

    return value
}

function getInlayCacheLimit(deviceMemory = getNavigatorDeviceMemory()): number {
    if (deviceMemory === undefined) {
        return 192 * MB
    }

    if (deviceMemory <= 2) {
        return 48 * MB
    }

    if (deviceMemory <= 4) {
        return 96 * MB
    }

    if (deviceMemory <= 8) {
        return 192 * MB
    }

    return 256 * MB
}

const INLAY_CACHE_LIMIT = getInlayCacheLimit()

function lruGet(id: string): InlayAsset | null {
    const entry = inlayLRUCache.get(id)
    if (!entry) return null
    entry.lastAccessed = Date.now()
    return entry.asset
}

function lruSet(id: string, asset: InlayAsset): void {
    const size = asset.data instanceof Blob ? asset.data.size : (asset.data as string).length
    const existing = inlayLRUCache.get(id)
    if (existing) totalLRUSize -= existing.size
    inlayLRUCache.set(id, { asset, lastAccessed: Date.now(), size })
    totalLRUSize += size
    // evict oldest entries if over limit
    if (totalLRUSize > INLAY_CACHE_LIMIT) {
        const sorted = [...inlayLRUCache.entries()].sort((a, b) => a[1].lastAccessed - b[1].lastAccessed)
        for (const [key, entry] of sorted) {
            if (totalLRUSize <= INLAY_CACHE_LIMIT) break
            inlayLRUCache.delete(key)
            totalLRUSize -= entry.size
        }
    }
}

function lruDelete(id: string): void {
    const entry = inlayLRUCache.get(id)
    if (entry) {
        totalLRUSize -= entry.size
        inlayLRUCache.delete(id)
    }
}

/** @internal Reset module-level state for unit tests only */
export function __resetInlayStorageForTest(): void {
    inlayLRUCache.clear()
    totalLRUSize = 0
    _nodeInlayStorage = null
    _nodeInlayInfoStorage = null
}

// ── NodeInlayStorage ──

class NodeInlayStorage {
    private nodeStorage = new NodeStorage()

    private serverKey(id: string): string {
        return `${INLAY_PREFIX}${id}`
    }

    private async serializeAsset(asset: InlayAsset): Promise<Uint8Array> {
        let dataStr: string
        if (asset.data instanceof Blob) {
            dataStr = await blobToBase64(asset.data)
        } else {
            dataStr = asset.data as string
        }
        const serialized: SerializedInlayAsset = {
            data: dataStr,
            ext: asset.ext,
            height: asset.height,
            name: asset.name,
            type: asset.type,
            width: asset.width,
        }
        return new TextEncoder().encode(JSON.stringify(serialized))
    }

    private deserializeAsset(buf: Buffer): InlayAsset {
        const json: SerializedInlayAsset = JSON.parse(new TextDecoder().decode(buf))
        let data: string | Blob
        if (json.type !== 'signature' && json.data.startsWith('data:')) {
            data = base64ToBlob(json.data)
        } else {
            data = json.data
        }
        return {
            data,
            ext: json.ext,
            height: json.height,
            name: json.name,
            type: json.type,
            width: json.width,
        }
    }

    async setItem(id: string, asset: InlayAsset): Promise<void> {
        const bytes = await this.serializeAsset(asset)
        await this.nodeStorage.setItem(this.serverKey(id), bytes)
        lruSet(id, toCoreInlayAsset(asset))
    }

    async getItem<T>(id: string): Promise<T | null> {
        // 1. Try memory LRU cache
        const cached = lruGet(id)
        if (cached) return cached as unknown as T

        // 2. Fetch from server
        try {
            const buf = await this.nodeStorage.getItem(this.serverKey(id))
            if (!buf || buf.length === 0) return null
            const asset = this.deserializeAsset(buf)
            lruSet(id, toCoreInlayAsset(asset))
            return asset as unknown as T
        } catch {
            return null
        }
    }

    async removeItem(id: string): Promise<void> {
        try {
            await this.nodeStorage.removeItem(this.serverKey(id))
            lruDelete(id)
        } catch {
            // ignore if not found
        }
    }

    async keys(): Promise<string[]> {
        const allKeys = await this.nodeStorage.keys(INLAY_PREFIX)
        return allKeys.map(k => k.replace(INLAY_PREFIX, ''))
    }

    async iterate<T, U>(callback: (value: T, key: string, iterationNumber: number) => U): Promise<U> {
        const allKeys = await this.nodeStorage.keys(INLAY_PREFIX)
        let result: U
        let i = 0
        for (const decodedKey of allKeys) {
            const id = decodedKey.replace(INLAY_PREFIX, '')
            try {
                const buf = await this.nodeStorage.getItem(decodedKey)
                if (buf && buf.length > 0) {
                    const asset = this.deserializeAsset(buf)
                    result = callback(asset as unknown as T, id, i)
                    i++
                }
            } catch {
                // skip corrupt entries
            }
        }
        return result
    }
}

// ── NodeInlayInfoStorage ──

class NodeInlayInfoStorage {
    private nodeStorage = new NodeStorage()

    private serverKey(id: string): string {
        return `${INLAY_INFO_PREFIX}${id}`
    }

    async setItem(id: string, info: InlayExplorerInfo): Promise<void> {
        const bytes = new TextEncoder().encode(JSON.stringify(info))
        await this.nodeStorage.setItem(this.serverKey(id), bytes)
    }

    async getItem<T>(id: string): Promise<T | null> {
        try {
            const buf = await this.nodeStorage.getItem(this.serverKey(id))
            if (!buf || buf.length === 0) return null
            return JSON.parse(new TextDecoder().decode(buf)) as T
        } catch {
            return null
        }
    }

    async getItems<T>(ids: string[]): Promise<Record<string, T>> {
        const result: Record<string, T> = {}
        if (!Array.isArray(ids) || ids.length === 0) return result
        try {
            const rows = await this.nodeStorage.getItems(ids.map((id) => this.serverKey(id)))
            for (const row of rows) {
                try {
                    const id = row.key.replace(INLAY_INFO_PREFIX, '')
                    result[id] = JSON.parse(new TextDecoder().decode(row.value)) as T
                } catch {
                    // skip corrupt explorer info entries
                }
            }
        } catch {
            // best-effort batch read
        }
        return result
    }

    async removeItem(id: string): Promise<void> {
        try {
            await this.nodeStorage.removeItem(this.serverKey(id))
        } catch {
            // ignore if not found
        }
    }
}

function toCoreInlayAsset(asset: any): InlayAsset {
    return {
        data: asset.data,
        ext: asset.ext,
        height: asset.height,
        name: asset.name,
        type: asset.type,
        width: asset.width,
    }
}

// ── Storage instance singletons ──

let _nodeInlayStorage: NodeInlayStorage | null = null
let _nodeInlayInfoStorage: NodeInlayInfoStorage | null = null

function getInlayStorage(): NodeInlayStorage {
    if (!_nodeInlayStorage) _nodeInlayStorage = new NodeInlayStorage()
    return _nodeInlayStorage
}

function getInlayInfoStorage(): NodeInlayInfoStorage {
    if (!_nodeInlayInfoStorage) _nodeInlayInfoStorage = new NodeInlayInfoStorage()
    return _nodeInlayInfoStorage
}

export { getInlayMeta } from "./inlayMeta";

// ── Helpers ──

function base64ToBlob(b64: string): Blob {
    const splitDataURI = b64.split(',');
    const byteString = atob(splitDataURI[1]);
    const mimeString = splitDataURI[0].split(':')[1].split(';')[0];
    const ab = new ArrayBuffer(byteString.length);
    const ia = new Uint8Array(ab);
    for (let i = 0; i < byteString.length; i++) {
        ia[i] = byteString.charCodeAt(i);
    }
    return new Blob([ab], { type: mimeString });
}

function blobToBase64(blob: Blob): Promise<string> {
    const reader = new FileReader();
    reader.readAsDataURL(blob);
    return new Promise<string>((resolve, reject) => {
        reader.onloadend = () => { resolve(reader.result as string); };
        reader.onerror = reject;
    });
}

function buildInlayExplorerInfo(asset: InlayAsset): InlayExplorerInfo {
    return {
        ext: asset.ext,
        height: asset.height,
        name: asset.name,
        type: asset.type,
        width: asset.width,
    }
}

function buildExplorerItem(
    id: string,
    info: InlayExplorerInfo | null,
    meta: InlayAssetMeta | null
): InlayExplorerItem {
    return {
        ext: info?.ext ?? '',
        hasMeta: meta !== null,
        height: info?.height,
        id,
        meta,
        name: info?.name ?? id,
        type: info?.type ?? 'image',
        width: info?.width,
    }
}

function getSafeChatName(name: unknown, fallbackId: string, index: number): string {
    if (typeof name === 'string' && name.trim().length > 0) return name
    if (fallbackId.trim().length > 0) return fallbackId
    return `Chat ${index + 1}`
}

function getSafeCharacterName(name: unknown, fallbackId: string, index: number): string {
    if (typeof name === 'string' && name.trim().length > 0) return name
    if (fallbackId.trim().length > 0) return fallbackId
    return `Character ${index + 1}`
}

// ── Public API ──

export async function postInlayAsset(img: { name: string, data: Uint8Array }) {
    const extention = img.name.split('.').at(-1)
    const imgObj = new Image()

    if (inlayImageExts.includes(extention)) {
        imgObj.src = URL.createObjectURL(new Blob([asBuffer(img.data)], { type: `image/${extention}` }))
        return await writeInlayImage(imgObj, { name: img.name, ext: extention })
    }

    if (inlayAudioExts.includes(extention)) {
        const audioBlob = new Blob([asBuffer(img.data)], { type: `audio/${extention}` })
        const imgid = v4()
        await setInlayAsset(imgid, { name: img.name, data: audioBlob, ext: extention, type: 'audio' })
        return `${imgid}`
    }

    if (inlayVideoExts.includes(extention)) {
        const videoBlob = new Blob([asBuffer(img.data)], { type: `video/${extention}` })
        const imgid = v4()
        await setInlayAsset(imgid, { name: img.name, data: videoBlob, ext: extention, type: 'video' })
        return `${imgid}`
    }

    return null
}

export async function writeInlayImage(imgObj: HTMLImageElement, arg: { name?: string, ext?: string, id?: string } = {}) {
    let drawHeight = 0
    let drawWidth = 0
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    await new Promise((resolve) => {
        imgObj.onload = () => {
            drawHeight = imgObj.height
            drawWidth = imgObj.width
            const maxPixels = 1024 * 1024
            const currentPixels = drawHeight * drawWidth
            if (currentPixels > maxPixels) {
                const scaleFactor = Math.sqrt(maxPixels / currentPixels)
                drawWidth = Math.floor(drawWidth * scaleFactor)
                drawHeight = Math.floor(drawHeight * scaleFactor)
            }
            canvas.width = drawWidth
            canvas.height = drawHeight
            ctx.drawImage(imgObj, 0, 0, drawWidth, drawHeight)
            resolve(null)
        }
    })
    const db = getDatabase()
    const [mimeType, ext, quality]: [string, string, number?] = db.inlayImageLossless
        ? ['image/png', 'png', undefined]
        : ['image/webp', 'webp', 0.85]
    const imageBlob = await new Promise<Blob>(resolve => canvas.toBlob(resolve, mimeType, quality))
    const imgid = arg.id ?? v4()
    await setInlayAsset(imgid, { name: arg.name ?? imgid, data: imageBlob, ext, height: drawHeight, width: drawWidth, type: 'image' })
    return `${imgid}`
}

export type InlaySignature = {
    signatures: {
        type: 'function' | 'text'
        content: string
    }[],
    sourceFormat: LLMFormat,
    source: string
}

export async function saveInlayedSignature(sigid: string, signature: InlaySignature) {
    await setInlayAsset(sigid, {
        name: sigid,
        data: JSON.stringify(signature),
        ext: 'json',
        type: 'signature'
    } satisfies InlayAsset)
    return sigid
}

// Returns with base64 data URI
export async function getInlayAsset(id: string) {
    const img = await getInlayStorage().getItem<InlayAsset | null>(id)
    if (img === null) return null
    let data: string
    if (img.data instanceof Blob) {
        data = await blobToBase64(img.data)
    } else {
        data = img.data as string
    }
    const existingInfo = await getInlayInfoStorage().getItem<InlayExplorerInfo>(id)
    if (!existingInfo) {
        await getInlayInfoStorage().setItem(id, buildInlayExplorerInfo(toCoreInlayAsset(img)))
    }
    return { ...toCoreInlayAsset(img), data }
}

// Returns with Blob
export async function getInlayAssetBlob(id: string) {
    const img = await getInlayStorage().getItem<InlayAsset | null>(id)
    if (img === null) return null
    let data: Blob
    if (typeof img.data === 'string') {
        data = base64ToBlob(img.data)
        await setInlayAsset(id, { ...toCoreInlayAsset(img), data })
    } else {
        data = img.data
        const existingInfo = await getInlayInfoStorage().getItem<InlayExplorerInfo>(id)
        if (!existingInfo) {
            await getInlayInfoStorage().setItem(id, buildInlayExplorerInfo(toCoreInlayAsset(img)))
        }
    }
    return { ...toCoreInlayAsset(img), data }
}

export async function listInlayAssets(): Promise<[id: string, InlayAsset][]> {
    const assets: [id: string, InlayAsset][] = []
    await getInlayStorage().iterate<InlayAsset, void>((value, key) => {
        assets.push([key, toCoreInlayAsset(value)])
    })
    return assets
}

export async function listInlayKeys(): Promise<string[]> {
    return await getInlayStorage().keys()
}

export function getCharacterChatIndex(): CharacterChatIndexItem[] {
    const db = getDatabase()
    const characters = Array.isArray(db?.characters) ? db.characters : []
    const result: CharacterChatIndexItem[] = []
    for (let i = 0; i < characters.length; i++) {
        const char = characters[i]
        const chaId = typeof char?.chaId === 'string' ? char.chaId : ''
        if (!chaId) continue
        const chats = Array.isArray(char?.chats) ? char.chats : []
        result.push({
            chaId,
            chats: chats
                .map((chat, chatIndex) => {
                    const id = typeof chat?.id === 'string' ? chat.id : ''
                    if (!id) return null
                    return {
                        id,
                        name: getSafeChatName(chat?.name, id, chatIndex),
                    }
                })
                .filter((chat): chat is CharacterChatIndexItem['chats'][number] => chat !== null),
            name: getSafeCharacterName(char?.name, chaId, i),
        })
    }
    // Deactivated characters keep their chat ids in the stub, so their inlay
    // images are not mistaken for "orphan character/chat" entries.
    const archived = Array.isArray(db?.nodeOnlyArchivedCharacters) ? db.nodeOnlyArchivedCharacters : []
    for (let i = 0; i < archived.length; i++) {
        const stub = archived[i]
        const chaId = typeof stub?.chaId === 'string' ? stub.chaId : ''
        if (!chaId || result.some((c) => c.chaId === chaId)) continue
        const chatIds = Array.isArray(stub?.chatIds) ? stub.chatIds : []
        result.push({
            chaId,
            chats: chatIds
                .filter((id): id is string => typeof id === 'string' && id.length > 0)
                .map((id, chatIndex) => ({ id, name: getSafeChatName(undefined, id, chatIndex) })),
            name: getSafeCharacterName(stub?.name, chaId, characters.length + i),
        })
    }
    return result
}

/**
 * Lightweight explorer list for Playground.
 * Use `getInlayAssetBlob(id)` on demand when the user opens or downloads the original file.
 */
// Gallery metadata cache — avoids re-fetching on gallery re-entry
let _explorerItemsCache: InlayExplorerItem[] | null = null
let _explorerItemsCacheTime = 0
const EXPLORER_CACHE_TTL = 30_000 // 30 seconds

export async function listInlayExplorerItems(forceRefresh = false): Promise<InlayExplorerItem[]> {
    if (!forceRefresh && _explorerItemsCache && Date.now() - _explorerItemsCacheTime < EXPLORER_CACHE_TTL) {
        return _explorerItemsCache
    }

    const ids = await listInlayKeys()
    if (ids.length === 0) {
        _explorerItemsCache = []
        _explorerItemsCacheTime = Date.now()
        return []
    }

    const [infos, metas] = await Promise.all([
        getInlayInfoStorage().getItems<InlayExplorerInfo>(ids),
        getInlayMetas(ids),
    ])

    const items = ids.map((id) => buildExplorerItem(
        id,
        infos[id] ?? null,
        metas[id] ?? null,
    ))

    _explorerItemsCache = items
    _explorerItemsCacheTime = Date.now()
    return items
}

export async function setInlayAsset(id: string, img: InlayAsset) {
    const existingMeta = await getInlayMeta(id)
    const nextMeta = buildInlayMeta(existingMeta)
    await getInlayStorage().setItem(id, toCoreInlayAsset(img))
    await getInlayInfoStorage().setItem(id, buildInlayExplorerInfo(toCoreInlayAsset(img)))
    await setInlayMeta(id, nextMeta)
    _explorerItemsCache = null // invalidate gallery cache
}

export async function removeInlayAsset(id: string) {
    await getInlayStorage().removeItem(id)
    await getInlayInfoStorage().removeItem(id)
    await removeInlayMeta(id)
    _explorerItemsCache = null // invalidate gallery cache
}

export async function removeInlayAssets(ids: string[]): Promise<number> {
    if (!Array.isArray(ids) || ids.length === 0) return 0
    let removed = 0
    for (const id of ids) {
        if (!id) continue
        try {
            await removeInlayAsset(id)
            removed++
        } catch {
            // best-effort bulk delete
        }
    }
    return removed
}

export async function setInlayMetaFields(
    id: string,
    patch: Partial<Pick<InlayAssetMeta, 'charId' | 'chatId' | 'createdAt' | 'updatedAt'>>
): Promise<void> {
    const existing = await getInlayMeta(id)
    const now = Date.now()
    const next: InlayAssetMeta = {
        createdAt: (typeof patch.createdAt === 'number' && patch.createdAt > 0)
            ? patch.createdAt
            : (existing?.createdAt && existing.createdAt > 0 ? existing.createdAt : now),
        updatedAt: (typeof patch.updatedAt === 'number' && patch.updatedAt > 0) ? patch.updatedAt : now,
        charId: typeof patch.charId === 'string' ? patch.charId : existing?.charId,
        chatId: typeof patch.chatId === 'string' ? patch.chatId : existing?.chatId,
    }
    await setInlayMeta(id, next)
}

export async function getInlayMetas(ids: string[]): Promise<Record<string, InlayAssetMeta>> {
    if (!Array.isArray(ids) || ids.length === 0) return {}
    return await getInlayMetasBatch(ids)
}

export async function getInlayInfosBatch(ids: string[]): Promise<Record<string, InlayExplorerInfo>> {
    if (!Array.isArray(ids) || ids.length === 0) return {}
    return await getInlayInfoStorage().getItems<InlayExplorerInfo>(ids)
}

export type InlayScanResult = {
    scannedAt: number
    totalMessages: number
    refCounts: Record<string, number>
}

const INLAY_REF_REGEX = /\{\{(?:inlay|inlayed|inlayeddata)::(.+?)\}\}/g

/**
 * Count inlay references in every chat message.
 *
 * The browser only holds bodies for chats it has opened (lazy loading leaves
 * the rest as placeholders with `message: []`), and deactivated characters'
 * chats are not in the browser at all — so the authoritative scan runs on the
 * server (fullChatStore + archive index). The local scan is merged in for
 * chats edited in this tab that the server may not have received yet.
 * Rejects when the server scan fails: callers must then treat the result as
 * unknown, never as "nothing is referenced".
 */
export async function scanInlayReferences(): Promise<InlayScanResult> {
    const storage = forageStorage.realStorage as NodeStorage
    const server = await storage.fetchInlayReferences()
    const local = scanLocalInlayReferences()
    // Null-prototype map so an id like "constructor" still counts as referenced.
    const refCounts: Record<string, number> = Object.assign(Object.create(null), server.refCounts)
    for (const [id, count] of Object.entries(local.refCounts)) {
        refCounts[id] = Math.max(refCounts[id] ?? 0, count)
    }
    return {
        scannedAt: Date.now(),
        totalMessages: Math.max(server.totalMessages, local.totalMessages),
        refCounts,
    }
}

/**
 * Scan the chat messages currently loaded in the browser. Placeholder chats
 * contribute nothing, so this alone under-counts — see scanInlayReferences.
 */
export function scanLocalInlayReferences(): InlayScanResult {
    const db = getDatabase()
    const characters = Array.isArray(db?.characters) ? db.characters : []
    const refCounts: Record<string, number> = Object.create(null)
    let totalMessages = 0

    for (const char of characters) {
        if (!Array.isArray(char?.chats)) continue
        for (const chat of char.chats) {
            if (!Array.isArray(chat?.message)) continue
            for (const msg of chat.message) {
                if (typeof msg?.data !== 'string') continue
                totalMessages++
                // Reset regex state and create fresh instance to avoid lastIndex issues
                const regex = new RegExp(INLAY_REF_REGEX.source, 'g')
                let m: RegExpExecArray | null
                while ((m = regex.exec(msg.data)) !== null) {
                    const id = m[1]
                    refCounts[id] = (refCounts[id] ?? 0) + 1
                }
            }
        }
    }

    return { scannedAt: Date.now(), totalMessages, refCounts }
}

export function supportsInlayImage() {
    const db = getDatabase()
    return getModelInfo(db.aiModel).flags.includes(LLMFlags.hasImageInput)
}

export async function reencodeImage(img: Uint8Array) {
    if (getImageType(img) === 'PNG') return img
    const canvas = document.createElement('canvas')
    const imgObj = new Image()
    imgObj.src = URL.createObjectURL(new Blob([asBuffer(img)], { type: `image/png` }))
    await imgObj.decode()
    let drawHeight = imgObj.height
    let drawWidth = imgObj.width
    canvas.width = drawWidth
    canvas.height = drawHeight
    const ctx = canvas.getContext('2d')
    ctx.drawImage(imgObj, 0, 0, drawWidth, drawHeight)
    const b64 = canvas.toDataURL('image/png').split(',')[1]
    const b = Buffer.from(b64, 'base64')
    return b
}

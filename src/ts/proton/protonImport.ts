import type { ProtonDriveClient } from '@protontech/drive-sdk'
import { writable } from 'svelte/store'
import { language } from '../../lang'
import { alertError, notifySuccess } from '../alert'
import { importFileByName } from '../characterCards'
import { checkCharOrder } from '../globalApi.svelte'
import { importPlugin } from '../plugins/plugins.svelte'

export const protonImportDialogOpen = writable(false)

// Set by protonDriveClient once the SDK chunk loads.
let sdkAbortError: (abstract new (...args: never[]) => Error) | null = null
export function setSdkAbortError(errorClass: typeof sdkAbortError) {
    sdkAbortError = errorClass
}

// The SDK downloads blocks in parallel. On cancel only one rejection reaches
// the caller; the other in-flight blocks reject with nobody awaiting them, and
// bootstrap's global handler would show each one as an error alert. Listeners
// on window run in registration order (capture does not jump the queue there),
// so this is registered at module load, before bootstrap adds its handler.
if (typeof window !== 'undefined') {
    window.addEventListener('unhandledrejection', (event) => {
        if (sdkAbortError && event.reason instanceof sdkAbortError) {
            event.preventDefault()
            event.stopImmediatePropagation()
        }
    })
}

const IMPORTABLE_EXTENSIONS = ['charx', 'png', 'jpg', 'jpeg', 'risum', 'risup', 'risupreset', 'js', 'ts']

function extensionOf(name: string): string {
    const dot = name.lastIndexOf('.')
    return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

export function isProtonImportable(name: string): boolean {
    return IMPORTABLE_EXTENSIONS.includes(extensionOf(name))
}

export function isProtonPlugin(name: string): boolean {
    const ext = extensionOf(name)
    return ext === 'js' || ext === 'ts'
}

// AbortSignal.any only exists from Safari 17.4.
export function anySignal(signals: AbortSignal[]): AbortSignal {
    if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals)
    const controller = new AbortController()
    const aborted = signals.find((signal) => signal.aborted)
    if (aborted) {
        controller.abort(aborted.reason)
        return controller.signal
    }
    // Detach from every input once one fires, so a long-lived session signal
    // doesn't collect a listener per request (each request also has a timeout).
    const onAbort = (event: Event) => {
        controller.abort((event.target as AbortSignal).reason)
        for (const signal of signals) signal.removeEventListener('abort', onAbort)
    }
    for (const signal of signals) signal.addEventListener('abort', onAbort)
    return controller.signal
}

// Plugins are only installable from here, where the user picked the file:
// importFileByName also serves #import=<url> links and must not install code.
export async function importProtonFile(name: string, data: Uint8Array): Promise<boolean> {
    const ext = extensionOf(name)
    if (isProtonPlugin(name)) {
        const code = Buffer.from(data).toString('utf-8').replace(/^\uFEFF/gm, '')
        // importPlugin opens a local file picker when it gets no code.
        if (!code.trim()) {
            alertError(language.errors.noData)
            return false
        }
        const ok = (await importPlugin(code, { isTypescript: ext === 'ts' })) === true
        // importPlugin stays silent on success; the other importers notify.
        if (ok) notifySuccess(language.successImport)
        return ok
    }
    const ok = await importFileByName(name.slice(0, name.length - ext.length) + ext, data)
    // Like the other import paths, so a new character shows up in the sidebar.
    checkCharOrder()
    return ok
}

type PublicLinkClient = Awaited<ReturnType<ProtonDriveClient['experimental']['authURLAccess']>>

export type ProtonEntry = { uid: string, name: string, type: 'file' | 'folder', size?: number, modifiedAt?: number }

export type ProtonShare = {
    root: ProtonEntry
    list(folderUid: string, signal?: AbortSignal): Promise<ProtonEntry[]>
    download(entry: ProtonEntry, options?: {
        signal?: AbortSignal
        onProgress?: (downloaded: number, total?: number) => void
    }): Promise<Uint8Array>
}

export type ProtonOpenResult =
    | { kind: 'password' }
    | { kind: 'unsupported' }
    | { kind: 'ready', share: ProtonShare }

// Finds exactly one public share link (https://drive.proton.me/urls/<token>#<password>) in pasted text.
export function findProtonLink(text: string): string | null {
    const links = new Set<string>()
    for (const candidate of text.match(/https:\/\/[^\s<>"'`]+/gi) ?? []) {
        try {
            const url = new URL(candidate.replace(/[)\]},.;!?]+$/, ''))
            if (url.protocol !== 'https:' || !['drive.proton.me', 'drive.proton.ch'].includes(url.hostname)
                || url.port || url.username || url.password || !/^\/urls\/[a-z0-9]+\/?$/i.test(url.pathname)
                || !/^#[a-z0-9_-]+$/i.test(url.hash)) continue
            // Tracking parameters and a trailing slash do not identify a different share.
            url.search = ''
            url.pathname = url.pathname.replace(/\/$/, '')
            links.add(url.href)
        } catch { /* Not a usable public share URL. */ }
    }
    return links.size === 1 ? [...links][0] : null
}

type NodeLike = { uid: string, name: { ok: boolean, value?: unknown, error?: unknown }, type: string, modificationTime?: Date, activeRevision?: { claimedSize?: number } }

// Null when the name can't be read at all. A name that fails to decrypt
// comes with a placeholder (InvalidNameError) to show instead.
function toEntry(node: NodeLike): ProtonEntry | null {
    const { name: result } = node
    const name = result.ok ? result.value
        : result.error instanceof Error ? undefined : (result.error as { name?: unknown } | undefined)?.name
    if (typeof name !== 'string') return null
    return {
        uid: node.uid,
        name,
        type: node.type === 'folder' ? 'folder' : 'file',
        size: node.activeRevision?.claimedSize,
        modifiedAt: node.modificationTime?.getTime(),
    }
}

function wrapShare(client: PublicLinkClient, root: ProtonEntry): ProtonShare {
    return {
        root,
        async list(folderUid, signal) {
            const uids: string[] = []
            for await (const uid of client.iterateFolderChildrenNodeUids(folderUid, undefined, signal)) uids.push(uid)
            const entries: ProtonEntry[] = []
            for await (const node of client.iterateNodes(uids, signal)) {
                if ('missingUid' in node) continue
                // One unreadable entry shouldn't hide the rest of the folder.
                const entry = toEntry(node)
                if (entry) entries.push(entry)
            }
            // Numeric collation so versioned names order as v1.9 < v1.10.
            entries.sort((a, b) => Number(b.type === 'folder') - Number(a.type === 'folder')
                || a.name.localeCompare(b.name, undefined, { numeric: true }))
            return entries
        },
        async download(entry, options = {}) {
            const { signal, onProgress } = options
            const downloader = await client.getFileDownloader(entry.uid, signal)
            const total = downloader.getClaimedSizeInBytes()
            // The importers get one contiguous buffer. Filling a buffer of the
            // claimed size as blocks arrive keeps the file in memory only once;
            // the size comes from the uploader, so collect chunks if it's wrong.
            let buffer: Uint8Array | null = null
            try {
                if (total) buffer = new Uint8Array(total)
            } catch { /* Implausible size; collect chunks instead. */ }
            const chunks: Uint8Array[] = []
            let size = 0
            onProgress?.(0, total)
            // Progress comes from the SDK as blocks arrive; the stream only
            // receives them once they can be written in order.
            const controller = downloader.downloadToStream(new WritableStream<Uint8Array>({
                write(chunk) {
                    signal?.throwIfAborted()
                    if (buffer && size + chunk.byteLength <= buffer.byteLength) {
                        buffer.set(chunk, size)
                    } else {
                        if (buffer) chunks.push(buffer.subarray(0, size))
                        buffer = null
                        chunks.push(chunk)
                    }
                    size += chunk.byteLength
                },
            }), (downloaded) => onProgress?.(downloaded, total))
            // Never hand unverified or incomplete data to the importers.
            await controller.completion()
            signal?.throwIfAborted()
            if (buffer) return size === buffer.byteLength ? buffer : buffer.subarray(0, size)
            const data = new Uint8Array(size)
            let offset = 0
            for (const chunk of chunks) {
                data.set(chunk, offset)
                offset += chunk.byteLength
            }
            return data
        },
    }
}

export async function openProtonShare(url: string, options: { password?: string, signal?: AbortSignal } = {}): Promise<ProtonOpenResult> {
    if (findProtonLink(url) !== url) throw new Error('Invalid Proton share URL')
    const { createProtonDriveClient } = await import('./protonDriveClient')
    options.signal?.throwIfAborted()
    const client = createProtonDriveClient(options.signal)
    const info = await client.experimental.getURLAccessInfo(url)
    if (info.isLegacy) return { kind: 'unsupported' }
    if (info.isCustomPasswordProtected && !options.password) return { kind: 'password' }
    const share = await client.experimental.authURLAccess(url, options.password, true)
    const root = toEntry(await share.getRootNode())
    if (!root) throw new Error('Could not read the shared item name')
    return { kind: 'ready', share: wrapShare(share, root) }
}

/**
 * Pure helpers over `db.characterOrder` — the sidebar rail's mixed sequence of
 * character ids and folders — and over `db.nodeOnlyHiddenCharacterIds`.
 *
 * Every function returns a new array and never mutates its inputs; folder
 * objects are copied with spread so fields other than `data` (color, image,
 * future additive fields) are preserved. Callers assign the result to the DB
 * and run `checkCharOrder()` afterwards.
 */
import type { folder } from './storage/database.svelte'

export type OrderEntry = string | folder

/** A character's position: top level (`folderId` undefined) or inside a folder. */
export interface CharacterPlacement {
    chaId: string
    folderId?: string
}

/** Layout read back from the manager's DOM after a drop. */
export type OrderLayoutItem =
    | { type: 'char'; id: string }
    | { type: 'folder'; id: string; data: string[] }

export function isFolderEntry(entry: OrderEntry | null | undefined): entry is folder {
    return !!entry && typeof entry !== 'string'
}

export function findFolder(order: OrderEntry[], folderId: string): folder | undefined {
    for (const entry of order) {
        if (isFolderEntry(entry) && entry.id === folderId) return entry
    }
    return undefined
}

export function findPlacement(order: OrderEntry[], chaId: string): CharacterPlacement | undefined {
    for (const entry of order) {
        if (isFolderEntry(entry)) {
            if (entry.data.includes(chaId)) return { chaId, folderId: entry.id }
        } else if (entry === chaId) {
            return { chaId }
        }
    }
    return undefined
}

function cloneFolder(entry: folder, data?: string[]): folder {
    return { ...entry, data: data ? [...data] : [...entry.data] }
}

function cloneOrder(order: OrderEntry[]): OrderEntry[] {
    return order.map((entry) => (isFolderEntry(entry) ? cloneFolder(entry) : entry))
}

/** Remove every occurrence of `chaId` (top level and inside folders). */
export function removeCharacter(order: OrderEntry[], chaId: string): OrderEntry[] {
    return order
        .filter((entry) => isFolderEntry(entry) || entry !== chaId)
        .map((entry) => (isFolderEntry(entry) ? cloneFolder(entry, entry.data.filter((id) => id !== chaId)) : entry))
}

/**
 * Rebuild the order from a layout (e.g. the DOM after a drag). Folder objects
 * are looked up by id in the previous order so their other fields survive;
 * layout folders that no longer exist are dropped. Duplicate character ids
 * keep their first occurrence. Characters that were in the old order but are
 * missing from the layout are appended at the end so nothing silently
 * disappears from the rail.
 */
export function rebuildOrder(previous: OrderEntry[], layout: OrderLayoutItem[]): OrderEntry[] {
    const folders = new Map<string, folder>()
    const knownChars = new Set<string>()
    for (const entry of previous) {
        if (isFolderEntry(entry)) {
            folders.set(entry.id, entry)
            for (const id of entry.data) knownChars.add(id)
        } else {
            knownChars.add(entry)
        }
    }
    const seen = new Set<string>()
    const next: OrderEntry[] = []
    for (const item of layout) {
        if (item.type === 'char') {
            if (seen.has(item.id)) continue
            seen.add(item.id)
            next.push(item.id)
        } else {
            const existing = folders.get(item.id)
            if (!existing) continue
            const data: string[] = []
            for (const id of item.data) {
                if (seen.has(id)) continue
                seen.add(id)
                data.push(id)
            }
            next.push(cloneFolder(existing, data))
            folders.delete(item.id)
        }
    }
    for (const id of knownChars) {
        if (!seen.has(id)) {
            seen.add(id)
            next.push(id)
        }
    }
    return next
}

/**
 * Move a character to the end of `folderId` (or to the end of the top level
 * when undefined). Unknown folder → unchanged copy.
 */
export function moveCharacterToFolder(order: OrderEntry[], chaId: string, folderId: string | undefined): OrderEntry[] {
    if (folderId !== undefined && !findFolder(order, folderId)) return cloneOrder(order)
    const next = removeCharacter(order, chaId)
    if (folderId === undefined) {
        next.push(chaId)
        return next
    }
    return next.map((entry) => (isFolderEntry(entry) && entry.id === folderId ? cloneFolder(entry, [...entry.data, chaId]) : entry))
}

/** Move a top-level entry (character id or folder id) by `delta` within the top level. */
export function moveTopLevelEntry(order: OrderEntry[], key: string, delta: -1 | 1): OrderEntry[] {
    const next = cloneOrder(order)
    const from = next.findIndex((entry) => (isFolderEntry(entry) ? entry.id === key : entry === key))
    const to = from + delta
    if (from < 0 || to < 0 || to >= next.length) return next
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    return next
}

/** Move a character by `delta` within its folder. Top-level characters use `moveTopLevelEntry`. */
export function moveCharacterInFolder(order: OrderEntry[], folderId: string, chaId: string, delta: -1 | 1): OrderEntry[] {
    return order.map((entry) => {
        if (!isFolderEntry(entry) || entry.id !== folderId) return entry
        const data = [...entry.data]
        const from = data.indexOf(chaId)
        const to = from + delta
        if (from < 0 || to < 0 || to >= data.length) return cloneFolder(entry)
        data.splice(from, 1)
        data.splice(to, 0, chaId)
        return cloneFolder(entry, data)
    })
}

export function createFolder(order: OrderEntry[], id: string, name: string): OrderEntry[] {
    const next = cloneOrder(order)
    next.push({ id, name, data: [], color: '' })
    return next
}

/** Patch a folder's own fields (name, color, image…) by id. Unknown id → unchanged copy. */
export function updateFolder(order: OrderEntry[], folderId: string, patch: Partial<Omit<folder, 'id' | 'data'>>): OrderEntry[] {
    return order.map((entry) => (isFolderEntry(entry) && entry.id === folderId ? { ...cloneFolder(entry), ...patch } : entry))
}

/** Remove a folder, leaving its characters at the same position on the top level. */
export function removeFolderKeepItems(order: OrderEntry[], folderId: string): OrderEntry[] {
    const next: OrderEntry[] = []
    for (const entry of order) {
        if (isFolderEntry(entry) && entry.id === folderId) {
            next.push(...entry.data)
        } else {
            next.push(isFolderEntry(entry) ? cloneFolder(entry) : entry)
        }
    }
    return next
}

/** Add or remove ids from the hidden list (deduplicated, order preserved). */
export function setHidden(hidden: readonly string[], chaIds: readonly string[], value: boolean): string[] {
    const set = new Set(hidden)
    for (const id of chaIds) {
        if (value) set.add(id)
        else set.delete(id)
    }
    return [...set]
}

/** Drop hidden ids that no longer exist anywhere (`known` = every live, trashed and deactivated chaId). */
export function pruneHiddenCharacterIds(hidden: readonly string[], known: ReadonlySet<string>): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    for (const id of hidden) {
        if (typeof id !== 'string' || seen.has(id) || !known.has(id)) continue
        seen.add(id)
        out.push(id)
    }
    return out
}

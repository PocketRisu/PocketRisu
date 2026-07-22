import type { toSaveType } from './risuSave'

type JsonObject = Record<string, any>

function isObject(value: unknown): value is JsonObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function cloneValue<T>(value: T): T {
    if (value === undefined || value === null || typeof value !== 'object') {
        return value
    }
    if (Array.isArray(value)) {
        return value.map((item) => cloneValue(item)) as T
    }

    const cloned: JsonObject = {}
    for (const key of Object.keys(value)) {
        cloned[key] = cloneValue((value as JsonObject)[key])
    }
    return cloned as T
}

export function jsonValuesEqual(left: any, right: any): boolean {
    if (Object.is(left, right)) return true
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
        return left.every((item, index) => jsonValuesEqual(item, right[index]))
    }
    if (isObject(left) || isObject(right)) {
        if (!isObject(left) || !isObject(right)) return false
        const leftKeys = Object.keys(left)
        const rightKeys = Object.keys(right)
        if (leftKeys.length !== rightKeys.length) return false
        return leftKeys.every((key) => Object.hasOwn(right, key) && jsonValuesEqual(left[key], right[key]))
    }
    return false
}

function stableArrayKey(arrays: any[][]): 'chaId' | 'id' | null {
    for (const key of ['chaId', 'id'] as const) {
        let sawItem = false
        let valid = true
        for (const array of arrays) {
            const seen = new Set<string>()
            for (const item of array) {
                const id = isObject(item) ? item[key] : undefined
                if (typeof id !== 'string' || id.length === 0 || seen.has(id)) {
                    valid = false
                    break
                }
                sawItem = true
                seen.add(id)
            }
            if (!valid) break
        }
        if (valid && sawItem) return key
    }
    return null
}

function sameIds(left: string[], right: string[]): boolean {
    return left.length === right.length && left.every((id, index) => id === right[index])
}

function mergeKeyedArray(base: any[], local: any[], remote: any[], key: 'chaId' | 'id'): any[] {
    const baseById = new Map(base.map((item) => [item[key], item]))
    const localById = new Map(local.map((item) => [item[key], item]))
    const remoteById = new Map(remote.map((item) => [item[key], item]))
    const mergedById = new Map<string, any>()

    // Deletion wins over an edit. This is intentional for chats/characters:
    // a stale tab must never revive an item deleted by another device.
    for (const [id, baseItem] of baseById) {
        if (!localById.has(id) || !remoteById.has(id)) continue
        mergedById.set(id, mergeThreeWayValue(baseItem, localById.get(id), remoteById.get(id)))
    }

    for (const [id, localItem] of localById) {
        if (baseById.has(id)) continue
        if (remoteById.has(id)) {
            mergedById.set(id, mergeThreeWayValue(undefined, localItem, remoteById.get(id)))
        }
        else {
            mergedById.set(id, cloneValue(localItem))
        }
    }
    for (const [id, remoteItem] of remoteById) {
        if (!baseById.has(id) && !localById.has(id)) {
            mergedById.set(id, cloneValue(remoteItem))
        }
    }

    const baseIds = base.map((item) => item[key] as string)
    const localIds = local.map((item) => item[key] as string)
    const remoteIds = remote.map((item) => item[key] as string)
    const localChangedStructure = !sameIds(baseIds, localIds)
    const preferredOrder = localChangedStructure ? localIds : remoteIds
    const secondaryOrder = localChangedStructure ? remoteIds : localIds
    const result: any[] = []
    const appended = new Set<string>()

    for (const id of [...preferredOrder, ...secondaryOrder]) {
        if (appended.has(id) || !mergedById.has(id)) continue
        appended.add(id)
        result.push(mergedById.get(id))
    }
    return result
}

/**
 * Three-way merge a local runtime DB onto a freshly fetched server DB.
 *
 * The previous server baseline is the common ancestor. Unchanged local fields
 * take the remote value, unchanged remote fields take the local value, and
 * independent object-field edits are combined. Arrays with stable `chaId`/`id`
 * keys are merged by identity so a stale chats array cannot overwrite remote
 * additions, deletions or metadata changes wholesale.
 */
export function mergeThreeWayValue(base: any, local: any, remote: any): any {
    if (jsonValuesEqual(local, base)) return cloneValue(remote)
    if (jsonValuesEqual(remote, base)) return cloneValue(local)
    if (jsonValuesEqual(local, remote)) return cloneValue(local)

    if (Array.isArray(base) && Array.isArray(local) && Array.isArray(remote)) {
        const key = stableArrayKey([base, local, remote])
        if (key) return mergeKeyedArray(base, local, remote, key)
        // There is no identity-safe way to merge concurrent edits to a
        // positional array. Prefer the user's current local value.
        return cloneValue(local)
    }

    if (isObject(base) && isObject(local) && isObject(remote)) {
        const result: JsonObject = {}
        const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])
        for (const key of keys) {
            const inBase = Object.hasOwn(base, key)
            const inLocal = Object.hasOwn(local, key)
            const inRemote = Object.hasOwn(remote, key)

            if (inBase) {
                // A deletion on either side wins, matching the identity-array
                // rule and preventing stale state from resurrecting data.
                if (!inLocal || !inRemote) continue
                result[key] = mergeThreeWayValue(base[key], local[key], remote[key])
            }
            else if (inLocal && inRemote) {
                result[key] = mergeThreeWayValue(undefined, local[key], remote[key])
            }
            else if (inLocal) {
                result[key] = cloneValue(local[key])
            }
            else if (inRemote) {
                result[key] = cloneValue(remote[key])
            }
        }
        return result
    }

    // Both sides changed the same scalar or non-keyed value. Keep the local
    // edit: it is the action this save attempt is trying to preserve.
    return cloneValue(local)
}

export function mergeTrackedChanges(primary: toSaveType, pending: toSaveType): toSaveType {
    const characters = [...new Set([...primary.character, ...pending.character].filter(Boolean))]
    const seenChats = new Set<string>()
    const chats = [...primary.chat, ...pending.chat].filter(([chaId, chatId]) => {
        const key = `${chaId}|${chatId}`
        if (!chaId || !chatId || seenChats.has(key)) return false
        seenChats.add(key)
        return true
    })

    return {
        character: characters,
        chat: chats,
        root: primary.root || pending.root,
        botPreset: primary.botPreset || pending.botPreset,
        modules: primary.modules || pending.modules,
        plugins: primary.plugins || pending.plugins,
        pluginCustomStorage: primary.pluginCustomStorage || pending.pluginCustomStorage,
    }
}

export type TrackedDeletionConflict = {
    scope: 'character' | 'chat' | 'chat-metadata'
    charId: string
    chatId?: string
}

/**
 * Detect deletion/edit races that must be surfaced instead of auto-merged.
 * `chatMetadata` projects hydrated/placeholder chats to their server stub so
 * hydration alone is not mistaken for a local metadata edit.
 */
export function findTrackedDeletionConflict(
    base: any,
    local: any,
    remote: any,
    changes: toSaveType,
    chatMetadata: (chat: any) => any,
): TrackedDeletionConflict | null {
    const baseCharacters: any[] = Array.isArray(base?.characters) ? base.characters : []
    const localCharacters: any[] = Array.isArray(local?.characters) ? local.characters : []
    const remoteCharacters: any[] = Array.isArray(remote?.characters) ? remote.characters : []

    const characterById = (characters: any[], charId: string) => (
        characters.find((character) => character?.chaId === charId)
    )

    for (const charId of changes.character) {
        const baseChar = characterById(baseCharacters, charId)
        const localChar = characterById(localCharacters, charId)
        const remoteChar = characterById(remoteCharacters, charId)
        if (baseChar && localChar && !remoteChar) {
            return { scope: 'character', charId }
        }
        if (!baseChar || !localChar || !remoteChar) continue

        const remoteChatIds = new Set(
            (remoteChar.chats ?? []).map((chat: any) => chat?.id).filter(Boolean),
        )
        for (const baseChat of baseChar.chats ?? []) {
            if (!baseChat?.id || remoteChatIds.has(baseChat.id)) continue
            const localChat = localChar.chats?.find((chat: any) => chat?.id === baseChat.id)
            if (localChat && !jsonValuesEqual(chatMetadata(localChat), chatMetadata(baseChat))) {
                return { scope: 'chat-metadata', charId, chatId: baseChat.id }
            }
        }
    }

    for (const [charId, chatId] of changes.chat) {
        const baseChat = characterById(baseCharacters, charId)?.chats
            ?.find((chat: any) => chat?.id === chatId)
        const localChat = characterById(localCharacters, charId)?.chats
            ?.find((chat: any) => chat?.id === chatId)
        const remoteChat = characterById(remoteCharacters, charId)?.chats
            ?.find((chat: any) => chat?.id === chatId)
        if (baseChat && localChat && !remoteChat) {
            return { scope: 'chat', charId, chatId }
        }
    }

    return null
}

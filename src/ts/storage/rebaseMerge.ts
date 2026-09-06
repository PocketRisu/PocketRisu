import type { Database } from './database.svelte'
import type { toSaveType } from './risuSave'

/**
 * Merge the server's latest database with the changes this client still
 * tracks, for the full-write conflict path: root keys and tracked
 * presets/modules/characters come from the local copy, everything else from
 * the server. Pure — `clone` is injected so the caller keeps its own
 * structured-clone policy.
 *
 * Characters the server has deactivated meanwhile are NOT overlaid: putting
 * an archived chaId back into `characters` is rejected on every save, which
 * would leave this client unable to save at all. They are returned so the
 * caller can tell the user their unsaved edits to those characters were
 * dropped.
 *
 * The deactivated-character list is taken from the server and only this
 * client's own in-flight deactivations/activations are re-applied
 * (`baselineArchivedIds` = the list this client last synced against).
 *
 * Characters that come from the server carry `_stub` chats (the client view);
 * runtime code only understands placeholders, so `convertChats` (the boot
 * conversion) is applied to every character not overlaid from local.
 */
export function mergeServerDbWithTrackedLocalChanges(
    latestDb: Database,
    localDbSource: Database,
    toSave: toSaveType,
    clone: <T>(value: T) => T,
    convertChats: (chats: any[]) => any[],
    baselineArchivedIds: ReadonlySet<string> = new Set(),
    baselineDb: Database | null = null,
    normalizeValue: (value: any) => any = (value) => value,
): { mergedDb: Database; skippedArchivedCharIds: string[] } {
    const mergedDb = clone(latestDb)
    const localDb = clone(localDbSource)

    // Root keys (settings, personas, characterOrder, ...): with a baseline —
    // the view this client last synced against — only the keys this client
    // changed since then come from local; the rest keep the server's value,
    // which may carry another device's change. Copying every root key from
    // local would make the retried patch revert that change. Without a
    // baseline (non-patch mode) local wins as before. The baseline is the
    // patcher's normalized view, so the local value goes through the same
    // normalizer before comparing (a false "changed" only falls back to the
    // old local-wins behaviour).
    const localRootWins = (key: string): boolean => {
        if (!baselineDb) return true
        const localValue = (localDb as any)[key]
        const baselineValue = (baselineDb as any)[key]
        if (localValue === undefined && baselineValue === undefined) return false
        try {
            return JSON.stringify(normalizeValue(localValue)) !== JSON.stringify(baselineValue)
        } catch {
            return true
        }
    }
    for (const key in localDb) {
        if (
            key !== 'characters' && key !== 'botPresets' && key !== 'modules' &&
            key !== 'plugins' && key !== 'pluginCustomStorage' && key !== 'nodeOnlyArchivedCharacters'
        ) {
            if (localRootWins(key)) (mergedDb as any)[key] = clone((localDb as any)[key])
        }
    }

    if (toSave.botPreset) {
        mergedDb.botPresets = clone(localDb.botPresets)
        mergedDb.botPresetsId = localDb.botPresetsId
    }
    if (toSave.modules) {
        mergedDb.modules = clone(localDb.modules)
    }

    // Deactivation records are the server's: a device that deactivated a
    // character wrote the stub there, and copying this client's (possibly
    // stale) list over it would erase that record while the character is
    // also kept out of `characters` below — the character would vanish. Only
    // this client's own in-flight transitions are re-applied on top.
    type Stub = { chaId?: string }
    const idOf = (stub: Stub | undefined | null) => (typeof stub?.chaId === 'string' && stub.chaId.length > 0 ? stub.chaId : null)
    const localCharacters = Array.isArray(localDb.characters) ? localDb.characters : []
    const localArchived: Stub[] = Array.isArray((localDb as any).nodeOnlyArchivedCharacters) ? (localDb as any).nodeOnlyArchivedCharacters : []
    const localArchivedIds = new Set(localArchived.map(idOf).filter((id): id is string => id !== null))
    const localActiveIds = new Set(localCharacters.map(idOf).filter((id): id is string => id !== null))
    let mergedArchived: Stub[] = Array.isArray((latestDb as any).nodeOnlyArchivedCharacters)
        ? clone((latestDb as any).nodeOnlyArchivedCharacters as Stub[])
        : []
    const trackedCharIds = new Set<string>(toSave.character.filter(Boolean))
    // Deactivated here, not yet on the server: keep our stub, drop the
    // server's active copy. Only when the character was active at our last
    // sync — a stub that was already in the baseline and is now active on
    // the server means another device activated it, and the server wins.
    for (const stub of localArchived) {
        const id = idOf(stub)
        if (!id || localActiveIds.has(id) || baselineArchivedIds.has(id)) continue
        if (!mergedArchived.some((s) => idOf(s) === id)) mergedArchived.push(clone(stub))
        trackedCharIds.add(id)
    }
    // Activated here, not yet on the server: only when this client last saw
    // the character deactivated. Otherwise it was deactivated elsewhere while
    // this client still had it active, which is the skip case below.
    const activatedLocally = new Set<string>()
    for (const id of localActiveIds) {
        if (!localArchivedIds.has(id) && baselineArchivedIds.has(id) && mergedArchived.some((s) => idOf(s) === id)) {
            activatedLocally.add(id)
            trackedCharIds.add(id)
        }
    }
    if (activatedLocally.size > 0) mergedArchived = mergedArchived.filter((s) => !activatedLocally.has(idOf(s) ?? ''))
    ;(mergedDb as any).nodeOnlyArchivedCharacters = mergedArchived
    const archivedOnServer = new Set(mergedArchived.map(idOf).filter((id): id is string => id !== null))

    for (const trackedChat of toSave.chat) {
        if (trackedChat?.[0]) {
            trackedCharIds.add(trackedChat[0])
        }
    }
    const mergedCharacters = Array.isArray(mergedDb.characters) ? mergedDb.characters : []
    const skippedArchivedCharIds: string[] = []
    const overlaidFromLocal = new Set<any>()

    for (const charId of trackedCharIds) {
        const localChar = localCharacters.find((char) => char?.chaId === charId)
        const mergedIndex = mergedCharacters.findIndex((char) => char?.chaId === charId)
        if (localChar && archivedOnServer.has(charId)) {
            skippedArchivedCharIds.push(charId)
            continue
        }
        if (localChar) {
            const clonedLocalChar = clone(localChar)
            overlaidFromLocal.add(clonedLocalChar)
            if (mergedIndex >= 0) {
                mergedCharacters[mergedIndex] = clonedLocalChar
            }
            else {
                mergedCharacters.push(clonedLocalChar)
            }
        }
        else if (mergedIndex >= 0) {
            mergedCharacters.splice(mergedIndex, 1)
        }
    }
    for (const character of mergedCharacters) {
        if (!character || overlaidFromLocal.has(character) || !Array.isArray(character.chats)) continue
        character.chats = convertChats(character.chats)
    }
    mergedDb.characters = mergedCharacters
    return { mergedDb, skippedArchivedCharIds }
}

/**
 * `toSave` with extra chaIds added to its tracked list — the characters the
 * patcher saw change by hash in the save that hit the conflict, so a rebase
 * overlays every edited character, not only the tracked ones, without
 * touching characters the user did not edit.
 */
export function withTrackedCharacters(toSave: toSaveType, chaIds: readonly string[]): toSaveType {
    const extra = chaIds.filter((id) => id && !toSave.character.includes(id))
    if (extra.length === 0) return toSave
    return { ...toSave, character: [...toSave.character, ...new Set(extra)] }
}

/**
 * True when the character array has an entry without a chaId or two entries
 * sharing one. Rebase and the patcher's change detection both key by chaId,
 * so in that state an edit could be attributed to the wrong entry or dropped;
 * callers keep the pre-existing full-write fallback instead.
 */
export function hasAmbiguousCharacterIds(characters: ReadonlyArray<{ chaId?: string } | undefined | null>): boolean {
    const seen = new Set<string>()
    for (const character of characters) {
        const id = character?.chaId
        if (typeof id !== 'string' || id.length === 0) return true
        if (seen.has(id)) return true
        seen.add(id)
    }
    return false
}

/**
 * Character archive — shown to users as "deactivate / activate".
 *
 * A deactivated character leaves `db.characters` and is kept as a small stub in
 * `db.nodeOnlyArchivedCharacters`; its full body (chats, asset list) lives on
 * the server in kv `archive/<chaId>/<archivedAt>` (one immutable row per
 * deactivation; the stub names its row). Lists render the stub in place (dimmed)
 * and every other consumer — plugins, scripts, search, dataset export — sees
 * the character as if it had been deleted.
 *
 * Both moves happen here on the client, after the server has written/read the
 * payload, so the change reaches the server through the normal save path
 * (/api/patch) and dbCache, hashes and etag stay in one flow. The server
 * rejects a patch that would leave a chaId in both lists.
 */
import { get } from "svelte/store"
import { language } from "src/lang"
import { alertConfirm, alertError, notifySuccess } from "./alert"
import { changeChar, deselectCharacter } from "./characters"
import { checkCharOrder, forageStorage, requestImmediateSave, requiresFullEncoderReload } from "./globalApi.svelte"
import { DBState, loadingOverlayStore, selectedCharID } from "./stores.svelte"
import { convertStubsToPlaceholders } from "./storage/chatStorage"
import type { ArchivedCharacterStub, character } from "./storage/database.svelte"
import { CharacterArchiveError, type NodeStorage } from "./storage/nodeStorage"

export { CharacterArchiveError }

function storage(): NodeStorage {
    return forageStorage.realStorage as NodeStorage
}

export function getArchivedStubs(): ArchivedCharacterStub[] {
    return DBState.db.nodeOnlyArchivedCharacters ?? []
}

export function findArchivedStub(chaId: string): ArchivedCharacterStub | undefined {
    return getArchivedStubs().find((s) => s?.chaId === chaId)
}

export function isArchivedCharacter(chaId: string): boolean {
    return !!findArchivedStub(chaId)
}

function withOverlay<T>(fn: () => Promise<T>): Promise<T> {
    loadingOverlayStore.set({ active: true, text: language.loading ?? '', onCancel: null })
    return fn().finally(() => {
        loadingOverlayStore.set({ active: false, text: '', onCancel: null })
    })
}

/**
 * Deactivate the character at `index`. Asks for confirmation, then:
 * server writes + verifies the payload → the character moves from
 * `characters` to the stub list (one save tick) → selection is cleared.
 * Returns true when the character was deactivated.
 */
export async function archiveCharacter(index: number): Promise<boolean> {
    const db = DBState.db
    const char = db.characters[index]
    if (!char?.chaId) return false
    const name = char.name || 'Unnamed'
    if (!await alertConfirm(language.deactivateCharacterConfirm(name))) return false

    try {
        return await withOverlay(async () => {
            // The server builds the payload from its own view; push any edits
            // still sitting in the client's debounce first so nothing is lost.
            await requestImmediateSave()
            const stub = await storage().archiveCharacter(char.chaId)
            // Re-resolve: the array may have shifted while the server worked.
            const idx = db.characters.findIndex((c) => c?.chaId === char.chaId)
            if (idx === -1) return false
            if (!Array.isArray(db.nodeOnlyArchivedCharacters)) db.nodeOnlyArchivedCharacters = []
            db.nodeOnlyArchivedCharacters.push(stub)
            db.characters.splice(idx, 1)
            checkCharOrder()
            requiresFullEncoderReload.state = true
            // Indices shifted; mirror removeChar and drop the selection.
            deselectCharacter()
            void requestImmediateSave()
            notifySuccess(language.deactivateCharacterDone)
            return true
        })
    } catch (error) {
        if (error instanceof CharacterArchiveError && error.code === 'ARCHIVE_CHATS_UNAVAILABLE') {
            alertError(language.deactivateCharacterUnsaved)
        } else {
            alertError(language.deactivateCharacterFailed + (error instanceof Error ? error.message : String(error)))
        }
        return false
    }
}

/**
 * Re-activate a deactivated character. Server registers its chats and hands
 * back the client view; the character returns to `characters` and the stub is
 * removed (one save tick). Resolves to the new index, or -1 when there was
 * nothing to activate. Throws CharacterArchiveError on server failure.
 */
export async function activateCharacter(chaId: string): Promise<number> {
    const db = DBState.db
    const list = db.nodeOnlyArchivedCharacters ?? []
    const stubIndex = list.findIndex((s) => s?.chaId === chaId)
    const existing = db.characters.findIndex((c) => c?.chaId === chaId)
    if (existing !== -1) {
        // Already active (e.g. another device activated it): just drop the stub.
        if (stubIndex !== -1) list.splice(stubIndex, 1)
        return existing
    }
    if (stubIndex === -1) return -1

    let restored: character
    try {
        // Name the exact row this stub was made with (rows are versioned).
        restored = await storage().activateCharacter(chaId, list[stubIndex]?.archivedAt)
    } catch (error) {
        if (error instanceof CharacterArchiveError && error.code === 'ARCHIVE_ALREADY_ACTIVE') {
            // Server has it active but our view does not — rebase will bring it; drop the stub.
            list.splice(stubIndex, 1)
            return -1
        }
        throw error
    }
    // The server sends chats as stubs; the client works with placeholders
    // (same conversion bootstrap applies to the whole database).
    restored.chats = convertStubsToPlaceholders(restored.chats ?? [])
    db.characters.push(restored)
    const stubIdxNow = (db.nodeOnlyArchivedCharacters ?? []).findIndex((s) => s?.chaId === chaId)
    if (stubIdxNow !== -1) db.nodeOnlyArchivedCharacters!.splice(stubIdxNow, 1)
    checkCharOrder()
    requiresFullEncoderReload.state = true
    void requestImmediateSave()
    return db.characters.length - 1
}

/** Drop a stub whose payload is gone for good (recovery path; nothing else is deleted). */
export function removeArchivedStub(chaId: string): boolean {
    const list = DBState.db.nodeOnlyArchivedCharacters ?? []
    const idx = list.findIndex((s) => s?.chaId === chaId)
    if (idx === -1) return false
    list.splice(idx, 1)
    checkCharOrder()
    requiresFullEncoderReload.state = true
    void requestImmediateSave()
    return true
}

/**
 * List-click entry point: "This character is deactivated. Activate it?" →
 * activate → open it like a normal selection.
 */
export async function promptActivateCharacter(chaId: string, arg: { reseter?: () => any } = {}): Promise<boolean> {
    const stub = findArchivedStub(chaId)
    if (!stub) return false
    if (!await alertConfirm(language.activateCharacterConfirm(stub.name || 'Unnamed'))) return false
    try {
        const index = await withOverlay(() => activateCharacter(chaId))
        if (index < 0) return false
        changeChar(index, arg)
        return true
    } catch (error) {
        if (error instanceof CharacterArchiveError
            && (error.code === 'ARCHIVE_PAYLOAD_MISSING' || error.code === 'ARCHIVE_PAYLOAD_INVALID')) {
            // Nothing to restore from: offer to drop the stub so the dashboard,
            // orphan sweep and export stop failing closed on it.
            if (await alertConfirm(language.activateCharacterMissing + '\n\n' + language.activateCharacterRemoveStub)) {
                removeArchivedStub(chaId)
            }
        } else {
            alertError(language.activateCharacterFailed + (error instanceof Error ? error.message : String(error)))
        }
        return false
    }
}

/** Every deactivated character as a full record (for the client-assembled partial backup). */
export async function fetchArchivedCharactersInline(): Promise<character[]> {
    if (getArchivedStubs().length === 0) return []
    return await storage().fetchArchivedCharactersInline()
}

export function isCharacterSelected(index: number): boolean {
    return get(selectedCharID) === index
}

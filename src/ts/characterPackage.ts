import * as fflate from 'fflate'
import { v4 } from 'uuid'
import { alertConfirm, alertError, alertStore, alertWait, notifySuccess } from './alert'
import { exportCharacterCard, importCharacterProcess } from './characterCards'
import { LocalWriter, readImage, VirtualWriter } from './globalApi.svelte'
import { language } from 'src/lang'
import { type character, getDatabase, setDatabase, saveImage, normalizeChat } from './storage/database.svelte'
import type { Chat } from './storage/database.svelte'
import { fetchChatFromServer } from './storage/chatStorage'
import { selectSingleFile } from './util'
import { createBlankChar } from './characters'
import { CharXWriter } from './process/processzip'
import { checkCharOrder } from './globalApi.svelte'
import { getInlayAsset, setInlayAsset, getInlayInfosBatch, type InlayAsset } from './process/files/inlays'
import { getInlayMeta, setInlayMeta, type InlayAssetMeta } from './process/files/inlayMeta'
import { PngChunk } from './pngChunk'
import { reencodeImage } from './process/files/inlays'

// ── Types ──

interface PackageManifest {
    type: 'risuCharacterPackage'
    version: 1
    createdAt: string
    character: {
        name: string
        file: string
        isEmpty?: boolean
    }
    chats?: {
        count: number
        file: string
    }
    personas?: {
        name: string
        originalId: string
        file: string
        icon?: string
        note?: string
        largePortrait?: boolean
    }[]
    inlays?: {
        count: number
        metaFile: string
        files: string[]
    }
}

interface InlayMetaEntry {
    name: string
    ext: string
    type: string
    width?: number
    height?: number
    createdAt?: number
    updatedAt?: number
    charId?: string
    chatId?: string
}

// ── Helpers ──

const INLAY_REF_REGEX = /\{\{(?:inlay|inlayed|inlayeddata)::(.+?)\}\}/g

export function scanCharacterInlayIds(char: character): Set<string> {
    const ids = new Set<string>()
    if (!Array.isArray(char?.chats)) return ids
    for (const chat of char.chats) {
        if (!Array.isArray(chat?.message)) continue
        for (const msg of chat.message) {
            if (typeof msg?.data !== 'string') continue
            const regex = new RegExp(INLAY_REF_REGEX.source, 'g')
            let m: RegExpExecArray | null
            while ((m = regex.exec(msg.data)) !== null) {
                ids.add(m[1])
            }
        }
    }
    return ids
}

export function getCharacterBoundPersonas(char: character): { persona: typeof db.personas[0], id: string }[] {
    const db = getDatabase()
    const seenIds = new Set<string>()
    const result: { persona: typeof db.personas[0], id: string }[] = []
    if (!Array.isArray(char?.chats)) return result
    for (const chat of char.chats) {
        if (!chat.bindedPersona) continue
        if (seenIds.has(chat.bindedPersona)) continue
        seenIds.add(chat.bindedPersona)
        const persona = db.personas.find(p => p.id === chat.bindedPersona)
        if (persona) {
            result.push({ persona, id: chat.bindedPersona })
        }
    }
    return result
}

function sanitizeFilename(name: string): string {
    return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/[. ]+$/, '') || 'unnamed'
}

async function buildPersonaPng(persona: { name: string, personaPrompt: string, icon: string, note?: string }): Promise<Uint8Array> {
    let img: Uint8Array
    if (!persona.icon) {
        const canvas = document.createElement('canvas')
        canvas.width = 256
        canvas.height = 256
        const ctx = canvas.getContext('2d')
        if (ctx) {
            ctx.fillStyle = 'rgb(100, 116, 139)'
            ctx.fillRect(0, 0, 256, 256)
        }
        const dataUrl = canvas.toDataURL('image/png')
        const base64 = dataUrl.split(',')[1]
        img = new Uint8Array(Buffer.from(base64, 'base64'))
    } else {
        img = await readImage(persona.icon)
    }

    const card = {
        name: persona.name,
        personaPrompt: persona.personaPrompt,
        note: persona.note,
    }

    img = (await PngChunk.write(await reencodeImage(img), {
        "persona": Buffer.from(JSON.stringify(card)).toString('base64')
    })) as Uint8Array

    return img
}

function base64ToUint8Array(base64: string): Uint8Array {
    const raw = base64.includes(',') ? base64.split(',')[1] : base64
    return new Uint8Array(Buffer.from(raw, 'base64'))
}

// ── Shared import logic ──

async function parseAndValidatePackage(file: { name: string, data: Uint8Array }): Promise<{ unzipped: fflate.Unzipped, manifest: PackageManifest } | null> {
    alertWait(language.characterPackageProgressReading)

    const unzipped = await new Promise<fflate.Unzipped>((resolve, reject) => {
        fflate.unzip(file.data, (err, data) => {
            if (err) reject(err)
            else resolve(data)
        })
    })

    const manifestBytes = unzipped['manifest.json']
    if (!manifestBytes) {
        alertError(language.characterPackageInvalidZip)
        return null
    }
    const manifest: PackageManifest = JSON.parse(new TextDecoder().decode(manifestBytes))
    if (manifest.type !== 'risuCharacterPackage' || manifest.version !== 1) {
        alertError(language.characterPackageInvalidZip)
        return null
    }

    return { unzipped, manifest }
}

function buildImportSummary(manifest: PackageManifest): string {
    let summary = `${language.characterPackageImportSummary}\n\n`
    if (manifest.character.isEmpty) {
        summary += `• ${language.characterPackageCharacter}: (${language.characterPackageEmpty})\n`
    } else {
        summary += `• ${language.characterPackageCharacter}: ${manifest.character.name}\n`
    }
    if (manifest.chats) {
        summary += `• ${language.characterPackageChats}: ${manifest.chats.count}${language.characterPackageChatCount}\n`
    }
    if (manifest.personas && manifest.personas.length > 0) {
        summary += `• ${language.characterPackagePersona}: ${manifest.personas.map(p => p.name).join(', ')}\n`
    }
    if (manifest.inlays) {
        summary += `• ${language.characterPackageInlays}: ${manifest.inlays.count}${language.characterPackageInlayCount}\n`
    }
    return summary
}

type ProgressFn = (msg: string, subPct?: number) => void

async function importPersonas(
    manifest: PackageManifest,
    unzipped: fflate.Unzipped,
    progress: ProgressFn
): Promise<Record<string, string>> {
    const personaIdMap: Record<string, string> = {}
    if (!manifest.personas || manifest.personas.length === 0) return personaIdMap

    progress(language.characterPackageProgressImportPersona)
    const db = getDatabase()

    // Parse all persona PNGs first
    const parsed: { entry: typeof manifest.personas[0], pngBytes: Uint8Array, card: { name: string, personaPrompt: string, note?: string } }[] = []
    const { AppendableBuffer: AB } = await import('./globalApi.svelte')

    for (const personaEntry of manifest.personas) {
        const pngBytes = unzipped[personaEntry.file]
        if (!pngBytes) {
            console.warn(`[characterPackage] Persona file ${personaEntry.file} not found, skipping`)
            continue
        }

        const readGenerator = PngChunk.readGenerator(pngBytes)
        let decoded: string | undefined
        for await (const chunk of readGenerator) {
            if (chunk && !(chunk instanceof AB) && chunk.key === 'persona') {
                decoded = chunk.value
                break
            }
        }

        if (!decoded) {
            console.warn(`[characterPackage] No persona data in ${personaEntry.file}, skipping`)
            continue
        }

        parsed.push({
            entry: personaEntry,
            pngBytes,
            card: JSON.parse(Buffer.from(decoded, 'base64').toString('utf-8'))
        })
    }

    // Apply: skip exact duplicates (all 6 fields match), add new ones
    for (const { entry, pngBytes, card } of parsed) {
        const existing = db.personas.find(p =>
            p.id === entry.originalId
            && p.name === card.name
            && p.personaPrompt === card.personaPrompt
            && (p.note ?? '') === (card.note ?? '')
            && (p.largePortrait ?? false) === (entry.largePortrait ?? false)
            && p.icon === (entry.icon ?? '')
        )

        if (existing) {
            // Exact duplicate — reuse existing, skip import
            personaIdMap[entry.originalId] = existing.id
            continue
        }

        const newId = v4()
        db.personas.push({
            name: card.name,
            icon: await saveImage(await reencodeImage(pngBytes)),
            personaPrompt: card.personaPrompt,
            note: card.note,
            id: newId,
        })
        personaIdMap[entry.originalId] = newId
    }

    return personaIdMap
}

function importChatsToCharacter(
    manifest: PackageManifest,
    unzipped: fflate.Unzipped,
    targetChar: character,
    personaIdMap: Record<string, string>,
    progress: ProgressFn,
    mode: 'replace' | 'append' = 'replace'
): void {
    if (!manifest.chats) return

    progress(language.characterPackageProgressImportChats)
    const chatsBytes = unzipped[manifest.chats.file]
    if (!chatsBytes) return

    const chatsJson = JSON.parse(new TextDecoder().decode(chatsBytes))
    if (chatsJson.type !== 'risuAllChats' || chatsJson.ver !== 2 || !Array.isArray(chatsJson.data)) return

    const importedChats: Chat[] = chatsJson.data

    for (const chat of importedChats) {
        if (chat.bindedPersona && personaIdMap[chat.bindedPersona]) {
            chat.bindedPersona = personaIdMap[chat.bindedPersona]
        }
        chat.id = v4()
    }

    if (mode === 'append') {
        // Remap folder IDs that collide with existing ones
        if (chatsJson.folders && Array.isArray(chatsJson.folders)) {
            const importedFolders = chatsJson.folders as { id: string, name?: string, color?: string, folded: boolean }[]
            const existingFolders = targetChar.chatFolders ?? []
            const folderIdMap: Record<string, string> = {}
            for (const folder of importedFolders) {
                if (existingFolders.some(f => f.id === folder.id)) {
                    const newId = v4()
                    folderIdMap[folder.id] = newId
                    folder.id = newId
                } else {
                    folderIdMap[folder.id] = folder.id
                }
            }
            for (const chat of importedChats) {
                if (chat.folderId && folderIdMap[chat.folderId]) {
                    chat.folderId = folderIdMap[chat.folderId]
                }
            }
            targetChar.chatFolders = [...importedFolders, ...existingFolders]
        }
        targetChar.chats.unshift(...importedChats.map(chat => normalizeChat(chat)))
    } else {
        targetChar.chats = importedChats.map(chat => normalizeChat(chat))
        if (chatsJson.folders && Array.isArray(chatsJson.folders)) {
            targetChar.chatFolders = chatsJson.folders
        }
        targetChar.chatPage = 0
    }
}

async function importInlays(
    manifest: PackageManifest,
    unzipped: fflate.Unzipped,
    targetCharId: string,
    importCurrentStep: number,
    importTotalSteps: number,
    progressLabel: string
): Promise<void> {
    if (!manifest.inlays || manifest.inlays.files.length === 0) return

    let metaMap: Record<string, InlayMetaEntry> = {}
    if (manifest.inlays.metaFile) {
        const metaBytes = unzipped[manifest.inlays.metaFile]
        if (metaBytes) {
            metaMap = JSON.parse(new TextDecoder().decode(metaBytes))
        }
    }

    const allInlayIds = manifest.inlays.files.map(fp => {
        const fn = fp.split('/').pop() || ''
        const dot = fn.lastIndexOf('.')
        return dot > 0 ? fn.substring(0, dot) : fn
    })
    const existingInfos = await getInlayInfosBatch(allInlayIds)

    let processed = 0
    let skipped = 0
    for (const filePath of manifest.inlays.files) {
        processed++

        const fileBytes = unzipped[filePath]
        if (!fileBytes) continue

        const fileName = filePath.split('/').pop() || ''
        const lastDot = fileName.lastIndexOf('.')
        const id = lastDot > 0 ? fileName.substring(0, lastDot) : fileName
        const ext = lastDot > 0 ? fileName.substring(lastDot + 1) : 'png'

        if (existingInfos[id]) {
            skipped++
            continue
        }

        alertStore.set({
            type: 'progress',
            msg: `${progressLabel} (${importCurrentStep + 1}/${importTotalSteps})\n${language.characterPackageProgressImportInlays} (${processed - skipped}/${manifest.inlays.files.length - skipped})`,
            submsg: String(((importCurrentStep + (processed - skipped) / (manifest.inlays.files.length - skipped || 1)) / importTotalSteps * 100).toFixed(0))
        })

        const meta = metaMap[id]
        const blob = new Blob([fileBytes.buffer as ArrayBuffer], { type: `image/${ext}` })

        await setInlayAsset(id, {
            data: blob,
            ext: meta?.ext || ext,
            name: meta?.name || id,
            type: (meta?.type as InlayAsset['type']) || 'image',
            width: meta?.width,
            height: meta?.height,
        })

        if (meta?.createdAt) {
            await setInlayMeta(id, {
                createdAt: meta.createdAt,
                updatedAt: meta.updatedAt || Date.now(),
                charId: targetCharId,
                chatId: meta.chatId,
            })
        }
    }
}

// ── Export ──

export async function exportCharacterPackage(
    charIndex: number,
    options: {
        includeCharacter: boolean
        includeChats: boolean
        includePersona: boolean
        includeInlays: boolean
    }
): Promise<void> {
    try {
        const db = getDatabase({ snapshot: true })
        const char = safeStructuredClone(db.characters[charIndex]) as character
        if (!char) {
            alertError('Character not found')
            return
        }

        const charName = sanitizeFilename(char.name || 'character')

        // Hydrate placeholder chats from server before any scan/export
        for (let i = 0; i < char.chats.length; i++) {
            const chat = char.chats[i]
            if (chat._placeholder && chat.id) {
                const full = await fetchChatFromServer(char.chaId, i, chat.id)
                if (full) {
                    char.chats[i] = full as Chat
                } else {
                    alertError(`Chat data missing for "${char.name}" / "${chat.name}". Export aborted to prevent data loss.`)
                    return
                }
            }
        }

        // Confirm
        let summary = `${language.characterPackage}\n\n`
        if (options.includeCharacter) {
            summary += `• ${language.characterPackageCharacter}: ${char.name}\n`
        } else {
            summary += `• ${language.characterPackageCharacter}: (${language.characterPackageEmpty})\n`
        }
        if (options.includeChats) {
            summary += `• ${language.characterPackageChats}: ${char.chats.length}${language.characterPackageChatCount}\n`
        }
        const boundPersonas = options.includePersona ? getCharacterBoundPersonas(char) : []
        if (options.includePersona && boundPersonas.length > 0) {
            summary += `• ${language.characterPackagePersona}: ${boundPersonas.map(p => p.persona.name).join(', ')}\n`
        }
        const inlayIds = options.includeInlays ? scanCharacterInlayIds(char) : new Set<string>()
        if (options.includeInlays && inlayIds.size > 0) {
            summary += `• ${language.characterPackageInlays}: ${inlayIds.size}${language.characterPackageInlayCount}\n`
        }

        const confirmed = await alertConfirm(summary)
        if (!confirmed) return

        // Count total steps for progress
        const totalSteps =
            (options.includeCharacter ? 1 : 0)
            + (options.includeChats && char.chats.length > 0 ? 1 : 0)
            + (options.includePersona && boundPersonas.length > 0 ? 1 : 0)
            + (options.includeInlays && inlayIds.size > 0 ? 1 : 0)
            + 1 /* finalize */
        let currentStep = 0
        const progress = (msg: string) => {
            currentStep++
            alertStore.set({
                type: 'progress',
                msg: `${language.characterPackageExport} (${currentStep}/${totalSteps})\n${msg}`,
                submsg: String(((currentStep - 1) / totalSteps * 100).toFixed(0))
            })
        }

        // 2. Open outer package ZIP via streaming
        const localWriter = new LocalWriter()
        await localWriter.init(`${charName}_package`, ['zip'])
        const zipWriter = new CharXWriter(localWriter)

        const manifest: PackageManifest = {
            type: 'risuCharacterPackage',
            version: 1,
            createdAt: new Date().toISOString(),
            character: { name: char.name, file: '', isEmpty: !options.includeCharacter },
        }

        // 1. Build and write charx (only if character included)
        if (options.includeCharacter) {
            progress(language.characterPackageProgressCharacter)
            const virtualWriter = new VirtualWriter()
            const charClone = safeStructuredClone(char) as character
            charClone.image = charClone.image || ''
            if (!charClone.image) {
                const res = await fetch('/none.webp')
                const data = new Uint8Array(await res.arrayBuffer())
                const { saveAsset } = await import('./globalApi.svelte')
                charClone.image = await saveAsset(data)
            }
            await exportCharacterCard(charClone, 'charx', {
                writer: virtualWriter,
                spec: 'v3',
                onProgress: (msg, pct) => {
                    alertStore.set({
                        type: 'progress',
                        msg: `${language.characterPackageExport} (${currentStep}/${totalSteps})\n${msg}`,
                        submsg: String(((currentStep - 1 + pct / 100) / totalSteps * 100).toFixed(0))
                    })
                }
            })
            const charxPath = `character/${charName}.charx`
            await zipWriter.write(charxPath, virtualWriter.buf.buffer)
            manifest.character.file = charxPath
        }

        // 4. Write chats
        if (options.includeChats && char.chats.length > 0) {
            progress(language.characterPackageProgressChats)
            const chatsData = JSON.stringify({
                type: 'risuAllChats',
                ver: 2,
                data: char.chats,
                folders: char.chatFolders ?? []
            }, null, 2)
            const chatsPath = 'chats/chats.json'
            await zipWriter.write(chatsPath, chatsData, 6)
            manifest.chats = { count: char.chats.length, file: chatsPath }
        }

        // 5. Write personas
        if (options.includePersona && boundPersonas.length > 0) {
            progress(language.characterPackageProgressPersona)
            manifest.personas = []
            const usedNames = new Set<string>()
            for (const { persona, id } of boundPersonas) {
                let safeName = sanitizeFilename(persona.name || 'persona')
                let uniqueName = safeName
                let counter = 1
                while (usedNames.has(uniqueName)) {
                    uniqueName = `${safeName}_${counter++}`
                }
                usedNames.add(uniqueName)

                const pngBytes = await buildPersonaPng(persona)
                const personaPath = `persona/${uniqueName}.png`
                await zipWriter.write(personaPath, pngBytes)
                manifest.personas.push({
                    name: persona.name,
                    originalId: id,
                    file: personaPath,
                    icon: persona.icon,
                    note: persona.note,
                    largePortrait: persona.largePortrait,
                })
            }
        }

        // 6. Write inlays
        if (options.includeInlays && inlayIds.size > 0) {
            const ids = [...inlayIds]
            const metaMap: Record<string, InlayMetaEntry> = {}
            const inlayFiles: string[] = []
            let processed = 0

            const [infos, metas] = await Promise.all([
                getInlayInfosBatch(ids),
                Promise.all(ids.map(async id => [id, await getInlayMeta(id)] as const)).then(
                    entries => Object.fromEntries(entries.filter(([, v]) => v !== null)) as Record<string, InlayAssetMeta>
                )
            ])

            for (const id of ids) {
                processed++
                alertStore.set({
                    type: 'progress',
                    msg: `${language.characterPackageExport} (${currentStep + 1}/${totalSteps})\n${language.characterPackageProgressInlays} (${processed}/${ids.length})`,
                    submsg: String(((currentStep + processed / ids.length) / totalSteps * 100).toFixed(0))
                })

                const asset = await getInlayAsset(id)
                if (!asset) {
                    console.warn(`[characterPackage] Inlay ${id} not found, skipping`)
                    continue
                }

                const ext = asset.ext || 'png'
                const filePath = `inlays/${id}.${ext}`
                const imageData = base64ToUint8Array(asset.data as string)
                await zipWriter.write(filePath, imageData)
                inlayFiles.push(filePath)

                const info = infos[id]
                const meta = metas[id]
                metaMap[id] = {
                    name: asset.name || id,
                    ext,
                    type: asset.type || 'image',
                    width: asset.width ?? info?.width,
                    height: asset.height ?? info?.height,
                    createdAt: meta?.createdAt,
                    updatedAt: meta?.updatedAt,
                    charId: meta?.charId,
                    chatId: meta?.chatId,
                }
            }
            currentStep++

            if (inlayFiles.length > 0) {
                const metaPath = 'inlays/meta.json'
                await zipWriter.write(metaPath, JSON.stringify(metaMap, null, 2), 6)
                manifest.inlays = { count: inlayFiles.length, metaFile: metaPath, files: inlayFiles }
            }
        }

        // 7. Write manifest (last)
        progress(language.characterPackageProgressFinalizing)
        await zipWriter.write('manifest.json', JSON.stringify(manifest, null, 2), 6)
        await zipWriter.end()

        notifySuccess(language.characterPackageExportSuccess)
    } catch (error) {
        alertError(error)
    }
}

// ── Import (new character) ──

export async function importCharacterPackage(): Promise<void> {
    try {
        const file = await selectSingleFile(['zip'])
        if (!file) return

        const parsed = await parseAndValidatePackage(file)
        if (!parsed) return
        const { unzipped, manifest } = parsed

        // Warn if character is empty
        let summary = buildImportSummary(manifest)
        if (manifest.character.isEmpty) {
            summary += `\n⚠ ${language.characterPackageEmptyWarning}`
        }

        const confirmed = await alertConfirm(summary)
        if (!confirmed) return

        const progressLabel = language.characterPackageImport
        const importTotalSteps =
            1 /* character */
            + (manifest.personas && manifest.personas.length > 0 ? 1 : 0)
            + (manifest.chats ? 1 : 0)
            + (manifest.inlays && manifest.inlays.files.length > 0 ? 1 : 0)
        let importCurrentStep = 0
        const importProgress: ProgressFn = (msg) => {
            importCurrentStep++
            alertStore.set({
                type: 'progress',
                msg: `${progressLabel} (${importCurrentStep}/${importTotalSteps})\n${msg}`,
                submsg: String(((importCurrentStep - 1) / importTotalSteps * 100).toFixed(0))
            })
        }

        // Import character
        let newCharIndex: number
        if (manifest.character.isEmpty || !manifest.character.file) {
            importProgress(language.characterPackageProgressImportChar)
            const db = getDatabase()
            const blankChar = createBlankChar()
            blankChar.name = manifest.character.name || ''
            db.characters.push(blankChar)
            setDatabase(db)
            newCharIndex = db.characters.length - 1
        } else {
            importProgress(language.characterPackageProgressImportChar)
            const charxBytes = unzipped[manifest.character.file]
            if (!charxBytes) {
                alertError('Character file not found in package')
                return
            }
            // Take the card itself and add it here. A declined low-level access
            // prompt or an invalid card adds nothing, yet the importer still
            // returns the last index, and a count can match a character another
            // device added meanwhile: either would hand the package's chats to
            // an existing character.
            const imported = await importCharacterProcess({
                name: manifest.character.file.split('/').pop() || 'package.charx',
                data: charxBytes,
                returnCharacter: true
            })
            if (!imported || typeof imported === 'number') {
                alertError('Failed to import character from package')
                return
            }
            const importDb = getDatabase()
            importDb.characters.push(imported)
            newCharIndex = importDb.characters.length - 1
        }

        let db = getDatabase()
        const newChar = db.characters[newCharIndex] as character

        try {
            const personaIdMap = await importPersonas(manifest, unzipped, importProgress)
            importChatsToCharacter(manifest, unzipped, newChar, personaIdMap, importProgress)
            await importInlays(manifest, unzipped, newChar.chaId, importCurrentStep, importTotalSteps, progressLabel)

            setDatabase(db)
            checkCharOrder()
            notifySuccess(language.characterPackageImportSuccess)
        } catch (error) {
            // By id: the list can change while personas and inlays import.
            const index = db.characters.findIndex((c) => c.chaId === newChar.chaId)
            if (index !== -1) db.characters.splice(index, 1)
            setDatabase(db)
            throw error
        }
    } catch (error) {
        alertError(error)
    }
}

// ── Import to existing character ──

export async function importPackageToCharacter(charIndex: number): Promise<void> {
    try {
        const file = await selectSingleFile(['zip'])
        if (!file) return

        const parsed = await parseAndValidatePackage(file)
        if (!parsed) return
        const { unzipped, manifest } = parsed

        const db = getDatabase()
        const targetChar = db.characters[charIndex] as character
        if (!targetChar) {
            alertError('Character not found')
            return
        }

        // Warn if character names differ
        if (!manifest.character.isEmpty && manifest.character.name !== targetChar.name) {
            const nameConfirmed = await alertConfirm(language.characterPackageNameMismatch)
            if (!nameConfirmed) return
        }

        // Show summary
        const summary = buildImportSummary(manifest)
        const confirmed = await alertConfirm(summary)
        if (!confirmed) return

        const progressLabel = language.characterPackageImportToChar
        const importTotalSteps =
            (manifest.personas && manifest.personas.length > 0 ? 1 : 0)
            + (manifest.chats ? 1 : 0)
            + (manifest.inlays && manifest.inlays.files.length > 0 ? 1 : 0)
        if (importTotalSteps === 0) {
            notifySuccess(language.characterPackageImportSuccess)
            return
        }
        let importCurrentStep = 0
        const importProgress: ProgressFn = (msg) => {
            importCurrentStep++
            alertStore.set({
                type: 'progress',
                msg: `${progressLabel} (${importCurrentStep}/${importTotalSteps})\n${msg}`,
                submsg: String(((importCurrentStep - 1) / importTotalSteps * 100).toFixed(0))
            })
        }

        const personaIdMap = await importPersonas(manifest, unzipped, importProgress)
        importChatsToCharacter(manifest, unzipped, targetChar, personaIdMap, importProgress, 'append')
        await importInlays(manifest, unzipped, targetChar.chaId, importCurrentStep, importTotalSteps, progressLabel)

        setDatabase(db)
        notifySuccess(language.characterPackageImportSuccess)
    } catch (error) {
        alertError(error)
    }
}

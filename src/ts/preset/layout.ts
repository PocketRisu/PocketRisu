import { v4 as uuidv4 } from 'uuid'
import type { ModelPreset } from './types'

export interface ModelPresetLayoutPreset {
    type: 'preset'
    id: string
}

export interface ModelPresetLayoutFolder {
    type: 'folder'
    id: string
    name: string
    presetIds: string[]
}

export type ModelPresetLayoutEntry = ModelPresetLayoutPreset | ModelPresetLayoutFolder
export type ModelPresetContainer = { folderId: string | null, index: number }

function presetEntry(id: string): ModelPresetLayoutPreset {
    return { type: 'preset', id }
}

export function normalizeModelPresetLayout(layout: unknown, presets: readonly Pick<ModelPreset, 'id'>[]): ModelPresetLayoutEntry[] {
    const validIds = new Set(presets.map((preset) => preset.id).filter(Boolean))
    const seenPresets = new Set<string>()
    const seenFolders = new Set<string>()
    const normalized: ModelPresetLayoutEntry[] = []

    if (Array.isArray(layout)) {
        for (const raw of layout) {
            if (!raw || typeof raw !== 'object') continue
            const entry = raw as Record<string, unknown>
            if (entry.type === 'preset' && typeof entry.id === 'string') {
                if (validIds.has(entry.id) && !seenPresets.has(entry.id)) {
                    seenPresets.add(entry.id)
                    normalized.push(presetEntry(entry.id))
                }
                continue
            }
            if (entry.type !== 'folder' || typeof entry.id !== 'string' || !entry.id || seenFolders.has(entry.id)) continue
            seenFolders.add(entry.id)
            const presetIds: string[] = []
            if (Array.isArray(entry.presetIds)) {
                for (const id of entry.presetIds) {
                    if (typeof id === 'string' && validIds.has(id) && !seenPresets.has(id)) {
                        seenPresets.add(id)
                        presetIds.push(id)
                    }
                }
            }
            normalized.push({
                type: 'folder',
                id: entry.id,
                name: typeof entry.name === 'string' ? entry.name : '',
                presetIds,
            })
        }
    }

    for (const preset of presets) {
        if (preset.id && !seenPresets.has(preset.id)) {
            seenPresets.add(preset.id)
            normalized.push(presetEntry(preset.id))
        }
    }
    return normalized
}

export function orderedModelPresets(layout: readonly ModelPresetLayoutEntry[], presets: readonly ModelPreset[]): ModelPreset[] {
    const byId = new Map(presets.map((preset) => [preset.id, preset]))
    const ordered: ModelPreset[] = []
    for (const entry of layout) {
        if (entry.type === 'preset') {
            const preset = byId.get(entry.id)
            if (preset) ordered.push(preset)
        } else {
            for (const id of entry.presetIds) {
                const preset = byId.get(id)
                if (preset) ordered.push(preset)
            }
        }
    }
    return ordered
}

export function findModelPresetContainer(layout: readonly ModelPresetLayoutEntry[], presetId: string): ModelPresetContainer | null {
    for (let index = 0; index < layout.length; index++) {
        const entry = layout[index]
        if (entry.type === 'preset' && entry.id === presetId) return { folderId: null, index }
        if (entry.type === 'folder') {
            const childIndex = entry.presetIds.indexOf(presetId)
            if (childIndex >= 0) return { folderId: entry.id, index: childIndex }
        }
    }
    return null
}

export function moveModelPreset(layout: readonly ModelPresetLayoutEntry[], presetId: string, target: ModelPresetContainer): ModelPresetLayoutEntry[] {
    const source = findModelPresetContainer(layout, presetId)
    if (!source) return [...layout]
    if (target.folderId !== null && !layout.some((entry) => entry.type === 'folder' && entry.id === target.folderId)) return [...layout]

    const next = layout.map((entry) => entry.type === 'folder' ? { ...entry, presetIds: [...entry.presetIds] } : { ...entry })
    if (source.folderId === null) next.splice(source.index, 1)
    else {
        const folder = next.find((entry): entry is ModelPresetLayoutFolder => entry.type === 'folder' && entry.id === source.folderId)
        folder?.presetIds.splice(source.index, 1)
    }

    let index = target.index
    if (source.folderId === target.folderId && source.index < index) index--
    if (target.folderId === null) {
        next.splice(Math.max(0, Math.min(index, next.length)), 0, presetEntry(presetId))
    } else {
        const folder = next.find((entry): entry is ModelPresetLayoutFolder => entry.type === 'folder' && entry.id === target.folderId)
        if (!folder) return [...layout]
        folder.presetIds.splice(Math.max(0, Math.min(index, folder.presetIds.length)), 0, presetId)
    }
    return next
}

export function moveModelPresetFolder(layout: readonly ModelPresetLayoutEntry[], folderId: string, targetIndex: number): ModelPresetLayoutEntry[] {
    const sourceIndex = layout.findIndex((entry) => entry.type === 'folder' && entry.id === folderId)
    if (sourceIndex < 0) return [...layout]
    const next = [...layout]
    const [folder] = next.splice(sourceIndex, 1)
    if (sourceIndex < targetIndex) targetIndex--
    next.splice(Math.max(0, Math.min(targetIndex, next.length)), 0, folder)
    return next
}

export function createModelPresetFolderFromPresets(
    layout: readonly ModelPresetLayoutEntry[],
    sourceId: string,
    targetId: string,
    folder: Pick<ModelPresetLayoutFolder, 'id' | 'name'>,
): ModelPresetLayoutEntry[] {
    if (!sourceId || !targetId || sourceId === targetId || !folder.id) return [...layout]
    if (layout.some((entry) => entry.id === folder.id)) return [...layout]

    const source = findModelPresetContainer(layout, sourceId)
    const targetIsRootPreset = layout.some((entry) => entry.type === 'preset' && entry.id === targetId)
    if (!source || !targetIsRootPreset) return [...layout]

    let inserted = false
    const next: ModelPresetLayoutEntry[] = []
    for (const entry of layout) {
        if (entry.type === 'preset') {
            if (entry.id === sourceId) continue
            if (entry.id === targetId) {
                if (!inserted) {
                    next.push({ type: 'folder', ...folder, presetIds: [sourceId, targetId] })
                    inserted = true
                }
                continue
            }
            next.push({ ...entry })
        } else {
            next.push({
                ...entry,
                presetIds: entry.presetIds.filter((id) => id !== sourceId && id !== targetId),
            })
        }
    }
    return inserted ? next : [...layout]
}

export function renameModelPresetFolder(layout: readonly ModelPresetLayoutEntry[], folderId: string, name: string): ModelPresetLayoutEntry[] {
    return layout.map((entry) => entry.type === 'folder' && entry.id === folderId ? { ...entry, name } : entry)
}

export function dissolveModelPresetFolder(layout: readonly ModelPresetLayoutEntry[], folderId: string): ModelPresetLayoutEntry[] {
    const index = layout.findIndex((entry) => entry.type === 'folder' && entry.id === folderId)
    if (index < 0) return [...layout]
    const folder = layout[index] as ModelPresetLayoutFolder
    return [...layout.slice(0, index), ...folder.presetIds.map(presetEntry), ...layout.slice(index + 1)]
}

export function removeModelPresetFromLayout(layout: readonly ModelPresetLayoutEntry[], presetId: string): ModelPresetLayoutEntry[] {
    return layout
        .filter((entry) => entry.type !== 'preset' || entry.id !== presetId)
        .map((entry) => entry.type === 'folder' ? { ...entry, presetIds: entry.presetIds.filter((id) => id !== presetId) } : entry)
}

export function duplicateModelPreset(
    presets: readonly ModelPreset[],
    layout: readonly ModelPresetLayoutEntry[],
    sourceId: string,
    id = uuidv4(),
    now = Date.now(),
): { presets: ModelPreset[], layout: ModelPresetLayoutEntry[], copy: ModelPreset } | null {
    const sourceIndex = presets.findIndex((preset) => preset.id === sourceId)
    const sourceContainer = findModelPresetContainer(layout, sourceId)
    if (sourceIndex < 0 || !sourceContainer) return null
    const copy = safeStructuredClone(presets[sourceIndex])
    copy.id = id
    copy.name = `${copy.name} Copy`
    copy.createdAt = now
    copy.updatedAt = now
    const nextPresets = [...presets]
    nextPresets.splice(sourceIndex + 1, 0, copy)
    const nextLayout = moveModelPreset(
        [...layout, presetEntry(copy.id)],
        copy.id,
        { folderId: sourceContainer.folderId, index: sourceContainer.index + 1 },
    )
    return { presets: nextPresets, layout: nextLayout, copy }
}

import { describe, expect, test } from 'vitest'
import {
    createModelPresetFolderFromPresets,
    dissolveModelPresetFolder,
    duplicateModelPreset,
    moveModelPreset,
    moveModelPresetFolder,
    normalizeModelPresetLayout,
} from './layout'

const presets = (ids: string[]) => ids.map((id) => ({ id, name: id })) as any[]

describe('model preset layout', () => {
    test('normalizes stale and duplicate references while retaining empty folders and appending missing presets', () => {
        const layout = normalizeModelPresetLayout([
            { type: 'preset', id: 'b' },
            { type: 'preset', id: 'stale' },
            { type: 'folder', id: 'f', name: 'Folder', presetIds: ['a', 'b', 'stale'] },
            { type: 'folder', id: 'empty', name: 'Empty', presetIds: [] },
            { type: 'folder', id: 'f', name: 'Duplicate folder', presetIds: ['c'] },
        ], presets(['a', 'b', 'c']))

        expect(layout).toEqual([
            { type: 'preset', id: 'b' },
            { type: 'folder', id: 'f', name: 'Folder', presetIds: ['a'] },
            { type: 'folder', id: 'empty', name: 'Empty', presetIds: [] },
            { type: 'preset', id: 'c' },
        ])
    })

    test('migrates an old database in canonical array order', () => {
        expect(normalizeModelPresetLayout(undefined, presets(['c', 'a', 'b']))).toEqual([
            { type: 'preset', id: 'c' },
            { type: 'preset', id: 'a' },
            { type: 'preset', id: 'b' },
        ])
    })

    test('does not create duplicate references for duplicate canonical ids', () => {
        expect(normalizeModelPresetLayout(undefined, presets(['a', 'a']))).toEqual([
            { type: 'preset', id: 'a' },
        ])
    })

    test('moves presets between root and folders and rejects a missing folder', () => {
        const layout = normalizeModelPresetLayout([
            { type: 'preset', id: 'a' },
            { type: 'folder', id: 'f', name: 'F', presetIds: ['b'] },
            { type: 'preset', id: 'c' },
        ], presets(['a', 'b', 'c']))
        const inFolder = moveModelPreset(layout, 'c', { folderId: 'f', index: 0 })
        expect(inFolder).toEqual([
            { type: 'preset', id: 'a' },
            { type: 'folder', id: 'f', name: 'F', presetIds: ['c', 'b'] },
        ])
        expect(moveModelPreset(inFolder, 'a', { folderId: 'missing', index: 0 })).toEqual(inFolder)
        expect(moveModelPreset(inFolder, 'b', { folderId: null, index: 1 })).toEqual([
            { type: 'preset', id: 'a' },
            { type: 'preset', id: 'b' },
            { type: 'folder', id: 'f', name: 'F', presetIds: ['c'] },
        ])
    })

    test('uses original root insertion slots for moves before, between, and after entries', () => {
        const layout = normalizeModelPresetLayout([
            { type: 'preset', id: 'a' },
            { type: 'folder', id: 'f', name: 'F', presetIds: ['b'] },
            { type: 'preset', id: 'c' },
            { type: 'preset', id: 'd' },
        ], presets(['a', 'b', 'c', 'd']))

        expect(moveModelPreset(layout, 'd', { folderId: null, index: 0 }).map((entry) => entry.id)).toEqual(['d', 'a', 'f', 'c'])
        expect(moveModelPreset(layout, 'a', { folderId: null, index: 3 }).map((entry) => entry.id)).toEqual(['f', 'c', 'a', 'd'])
        expect(moveModelPreset(layout, 'b', { folderId: null, index: layout.length }).map((entry) => entry.id)).toEqual(['a', 'f', 'c', 'd', 'b'])
    })

    test('uses exact child insertion slots when reordering and entering a folder', () => {
        const layout = normalizeModelPresetLayout([
            { type: 'preset', id: 'a' },
            { type: 'folder', id: 'f', name: 'F', presetIds: ['b', 'c', 'd'] },
        ], presets(['a', 'b', 'c', 'd']))

        expect((moveModelPreset(layout, 'd', { folderId: 'f', index: 0 })[1] as any).presetIds).toEqual(['d', 'b', 'c'])
        expect((moveModelPreset(layout, 'b', { folderId: 'f', index: 2 })[1] as any).presetIds).toEqual(['c', 'b', 'd'])
        expect((moveModelPreset(layout, 'a', { folderId: 'f', index: 3 })[0] as any).presetIds).toEqual(['b', 'c', 'd', 'a'])
    })

    test('reorders root folders without nesting them', () => {
        const layout = normalizeModelPresetLayout([
            { type: 'folder', id: 'one', name: 'One', presetIds: [] },
            { type: 'preset', id: 'a' },
            { type: 'folder', id: 'two', name: 'Two', presetIds: [] },
        ], presets(['a']))
        expect(moveModelPresetFolder(layout, 'two', 0).map((entry) => entry.id)).toEqual(['two', 'one', 'a'])
        expect(moveModelPresetFolder(layout, 'one', layout.length).map((entry) => entry.id)).toEqual(['a', 'two', 'one'])
    })

    test('creates a folder from two root presets at the target position', () => {
        const layout = normalizeModelPresetLayout([
            { type: 'preset', id: 'a' },
            { type: 'folder', id: 'existing', name: 'Existing', presetIds: [] },
            { type: 'preset', id: 'b' },
            { type: 'preset', id: 'c' },
        ], presets(['a', 'b', 'c']))

        expect(createModelPresetFolderFromPresets(layout, 'a', 'b', { id: 'new', name: 'New folder' })).toEqual([
            { type: 'folder', id: 'existing', name: 'Existing', presetIds: [] },
            { type: 'folder', id: 'new', name: 'New folder', presetIds: ['a', 'b'] },
            { type: 'preset', id: 'c' },
        ])
    })

    test('creates a folder from a preset in another folder without moving that folder', () => {
        const layout = normalizeModelPresetLayout([
            { type: 'preset', id: 'a' },
            { type: 'folder', id: 'source', name: 'Source', presetIds: ['b', 'c'] },
            { type: 'preset', id: 'd' },
        ], presets(['a', 'b', 'c', 'd']))

        expect(createModelPresetFolderFromPresets(layout, 'b', 'd', { id: 'new', name: 'New folder' })).toEqual([
            { type: 'preset', id: 'a' },
            { type: 'folder', id: 'source', name: 'Source', presetIds: ['c'] },
            { type: 'folder', id: 'new', name: 'New folder', presetIds: ['b', 'd'] },
        ])
    })

    test('rejects self, nested targets, and duplicate folder ids', () => {
        const layout = normalizeModelPresetLayout([
            { type: 'preset', id: 'a' },
            { type: 'folder', id: 'f', name: 'F', presetIds: ['b'] },
        ], presets(['a', 'b']))

        expect(createModelPresetFolderFromPresets(layout, 'a', 'a', { id: 'new', name: 'New' })).toEqual(layout)
        expect(createModelPresetFolderFromPresets(layout, 'a', 'b', { id: 'new', name: 'New' })).toEqual(layout)
        expect(createModelPresetFolderFromPresets(layout, 'b', 'a', { id: 'f', name: 'New' })).toEqual(layout)
    })

    test('does not retain duplicate source or target references', () => {
        const layout = [
            { type: 'preset' as const, id: 'a' },
            { type: 'folder' as const, id: 'f', name: 'F', presetIds: ['a', 'b'] },
            { type: 'preset' as const, id: 'b' },
        ]

        expect(createModelPresetFolderFromPresets(layout, 'a', 'b', { id: 'new', name: 'New' })).toEqual([
            { type: 'folder', id: 'f', name: 'F', presetIds: [] },
            { type: 'folder', id: 'new', name: 'New', presetIds: ['a', 'b'] },
        ])
    })

    test('dissolves a folder at its root position without deleting children', () => {
        const layout = normalizeModelPresetLayout([
            { type: 'preset', id: 'a' },
            { type: 'folder', id: 'f', name: 'F', presetIds: ['b', 'c'] },
        ], presets(['a', 'b', 'c']))
        expect(dissolveModelPresetFolder(layout, 'f')).toEqual([
            { type: 'preset', id: 'a' },
            { type: 'preset', id: 'b' },
            { type: 'preset', id: 'c' },
        ])
    })

    test('duplicates immediately after the source in both stores', () => {
        const sourcePresets = presets(['a', 'b', 'c'])
        const layout = normalizeModelPresetLayout([
            { type: 'preset', id: 'a' },
            { type: 'folder', id: 'f', name: 'F', presetIds: ['b', 'c'] },
        ], sourcePresets)
        const result = duplicateModelPreset(sourcePresets, layout, 'b', 'copy', 123)!
        expect(result.presets.map((preset) => preset.id)).toEqual(['a', 'b', 'copy', 'c'])
        expect((result.layout[1] as any).presetIds).toEqual(['b', 'copy', 'c'])
        expect(result.copy).toMatchObject({ id: 'copy', name: 'b Copy', createdAt: 123, updatedAt: 123 })
    })
})

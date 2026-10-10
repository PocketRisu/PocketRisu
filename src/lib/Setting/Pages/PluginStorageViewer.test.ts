import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import { Blob as NativeBlob, File as NativeFile } from 'node:buffer'

vi.stubGlobal('Blob', NativeBlob)
vi.stubGlobal('File', NativeFile)
const values = new Map<string, unknown>()
const savedValues = new Map<string, unknown>()
const getSaveItem = vi.fn(async (key: string) => savedValues.get(key))
const setItem = vi.fn(async (key: string, value: unknown) => { values.set(key, value) })
vi.mock('src/ts/plugins/pluginSafeClass', () => ({
    SafeLocalStorage: class { keys() { return [] } },
    SafeLocalPluginStorage: class {
        async keys() { return [...values.keys()] }
        async getItem(key: string) { return values.get(key) }
        setItem = setItem
    },
}))
vi.mock('src/ts/plugins/pluginStorageStore', () => ({
    refreshIndex: async () => {}, keys: () => [...savedValues.keys()], size: () => 4096,
    getItem: (key: string) => getSaveItem(key),
}))
vi.mock('src/ts/plugins/pluginStorageMeta', () => ({ getOwners: async () => ({}) }))
vi.mock('src/ts/alert', () => ({ notifySuccess: vi.fn(), notifyError: vi.fn(), alertConfirm: async () => false }))
vi.mock('src/lang', () => ({
    language: new Proxy({
        pluginStorageSaved: (key: string) => key,
        pluginStorageBulkDeleteAll: (count: number) => `Clear ${count}`,
        pluginStorageBulkDeleteShown: (count: number) => `Delete ${count}`,
    }, {
        get: (target, key) => Reflect.get(target, key) ?? key,
    }),
}))

import PluginStorageViewer from './PluginStorageViewer.svelte'

let component: ReturnType<typeof mount> | undefined

function button(label: string) {
    const found = [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find((element) => element.textContent.trim() === label)
    expect(found).toBeDefined()
    return found!
}

async function mountViewer() {
    const target = document.createElement('div')
    document.body.appendChild(target)
    component = mount(PluginStorageViewer, { target })
    await tick()
}

async function openLocalEntry(value: unknown) {
    values.set('entry', value)
    await mountViewer()
    button('pluginStorageBackendIdb').click()
    await vi.waitFor(() => expect(document.querySelector('[role="button"]')).not.toBeNull())
    document.querySelector<HTMLElement>('[role="button"]').click()
    await vi.waitFor(() => expect(button('edit')).toBeDefined())
}

beforeEach(() => { values.clear(); savedValues.clear(); setItem.mockClear(); getSaveItem.mockClear() })
afterEach(async () => {
    if (component) await unmount(component)
    component = undefined
    document.body.replaceChildren()
})

describe('plugin storage binary display', () => {
    test.each([
        ['Blob', () => new Blob([new Uint8Array(2048)], { type: 'audio/wav' }), '2.0 KB', 'audio/wav'],
        ['File', () => new File([new Uint8Array(7)], 'clip.wav', { type: 'audio/wav' }), '7 B', 'clip.wav'],
        ['ArrayBuffer', () => new ArrayBuffer(1024), '1.0 KB', '1024 B'],
        ['Uint16Array', () => new Uint16Array(new ArrayBuffer(32), 4, 3), '6 B', '6 B'],
        ['DataView', () => new DataView(new ArrayBuffer(32), 8, 5), '5 B', '5 B'],
        ['Blob', () => new Blob([]), '0 B', '0 B'],
    ] as const)('shows %s metadata without reading or expanding its bytes', async (type, makeValue, size, summary) => {
        const value = makeValue()
        const readBytes = value instanceof Blob ? vi.spyOn(value, 'arrayBuffer') : undefined
        await openLocalEntry(value)
        const row = document.querySelector('[role="button"]')
        expect(row.textContent).toContain(type)
        expect(row.textContent).toContain(size)
        expect(document.querySelector('pre').textContent).toContain(summary)
        expect(document.body.textContent).toContain('pluginStorageMetaBinarySize')
        expect(document.body.textContent).not.toContain('pluginStorageMetaChars')
        expect(button('edit').disabled).toBe(true)
        if (value instanceof Blob && value.type) {
            expect(row.textContent).toContain(value.type)
            expect(document.body.textContent).toContain('pluginStorageMetaMime')
        }
        if (readBytes) expect(readBytes).not.toHaveBeenCalled()
    })

    test('preserves nested structure and handles shared binary values and cycles', async () => {
        const audio = new Blob([new Uint8Array(3)], { type: 'audio/wav' })
        const buffer = new ArrayBuffer(12)
        const value: any = {
            title: 'clip', audio, again: audio,
            views: new Map([['first', new Uint8Array(buffer, 2, 4)], ['second', new Uint8Array(buffer, 4, 4)]]),
            attachments: new Set([audio]),
        }
        value.self = value
        await openLocalEntry(value)
        expect(document.querySelector('[role="button"]').textContent).toContain('9 B')
        const preview = document.querySelector('pre').textContent
        expect(preview).toContain('"title": "clip"')
        expect(preview).toContain('Blob')
        expect(preview).toContain('audio/wav')
        expect(preview).toContain('Map')
        expect(preview).toContain('Set')
        expect(preview).toContain('Uint8Array')
        expect(preview).toContain('Reference')
        expect(button('edit').disabled).toBe(true)
    })

    test('keeps save rows lazy and retains their indexed storage size after opening', async () => {
        savedValues.set('saved-entry', { text: 'value' })
        await mountViewer()
        await vi.waitFor(() => expect(document.querySelector('[role="button"]')).not.toBeNull())
        const row = document.querySelector<HTMLElement>('[role="button"]')
        expect(row.textContent).toContain('4.0 KB')
        expect(row.textContent).toContain('pluginStorageNotLoaded')
        expect(getSaveItem).not.toHaveBeenCalled()
        row.click()
        await vi.waitFor(() => expect(button('edit')).toBeDefined())
        expect(getSaveItem).toHaveBeenCalledTimes(1)
        expect(row.textContent).toContain('4.0 KB')
        expect(document.querySelector('pre').textContent).toContain('"text": "value"')
        expect(button('edit').disabled).toBe(false)
    })
})

describe('plugin storage JSON editor', () => {
    test.each([
        ['Blob', () => new Blob([new Uint8Array([1, 2])], { type: 'audio/wav' })],
        ['ArrayBuffer', () => new Uint8Array([1, 2]).buffer],
        ['typed array', () => new Uint8Array([1, 2])],
        ['nested binary', () => ({ text: 'clip', audio: new Blob([new Uint8Array([1, 2])]) })],
        ['Map with binary', () => new Map([['clip', new Uint8Array([1])]])],
        ['Date', () => new Date('2026-01-01')],
        ['shared references', () => { const child = {}; return { a: child, b: child } }],
        ['cyclic object', () => { const value: any = {}; value.self = value; return value }],
        ['legacy special primitives', () => ({ missing: undefined, number: NaN, array: [undefined, , 3] })],
    ] as const)('prevents a JSON edit from replacing %s with its lossy display', async (_type, makeValue) => {
        const value = makeValue()
        await openLocalEntry(value)
        const edit = button('edit')
        expect(edit.disabled).toBe(true)
        edit.click()
        await tick()
        expect(document.querySelector('textarea')).toBeNull()
        expect(setItem).not.toHaveBeenCalled()
        expect(values.get('entry')).toBe(value)
    })

    test('continues to edit and save ordinary JSON entries', async () => {
        await openLocalEntry({ text: 'old' })
        const edit = button('edit')
        expect(edit.disabled).toBe(false)
        edit.click()
        await tick()
        const input = document.querySelector<HTMLTextAreaElement>('textarea')
        input.value = '{"text":"new"}'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()
        button('pluginStorageSave').click()
        await vi.waitFor(() => expect(setItem).toHaveBeenCalledWith('entry', { text: 'new' }))
        expect(values.get('entry')).toEqual({ text: 'new' })
    })

    test('allows editing ordinary values after lossy JSON persistence', async () => {
        const { encodeLocalPluginStorageValue, decodeLocalPluginStorageValue } = await import('src/ts/plugins/localPluginStorageValue')
        const persisted = decodeLocalPluginStorageValue(await encodeLocalPluginStorageValue({ opt: undefined, score: NaN, array: [1, , 3] }))
        await openLocalEntry(persisted)
        button('edit').click()
        await tick()
        expect(document.querySelector('textarea')).not.toBeNull()
    })
})

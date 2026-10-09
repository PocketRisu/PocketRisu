import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import { Blob as NativeBlob } from 'node:buffer'

vi.stubGlobal('Blob', NativeBlob)
const values = new Map<string, unknown>()
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
    refreshIndex: async () => {}, keys: () => [], size: () => 0,
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

async function openLocalEntry(value: unknown) {
    values.set('entry', value)
    const target = document.createElement('div')
    document.body.appendChild(target)
    component = mount(PluginStorageViewer, { target })
    await tick()
    button('pluginStorageBackendIdb').click()
    await vi.waitFor(() => expect(document.querySelector('[role="button"]')).not.toBeNull())
    document.querySelector<HTMLElement>('[role="button"]').click()
    await vi.waitFor(() => expect(button('edit')).toBeDefined())
}

beforeEach(() => { values.clear(); setItem.mockClear() })
afterEach(async () => {
    if (component) await unmount(component)
    component = undefined
    document.body.replaceChildren()
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
})

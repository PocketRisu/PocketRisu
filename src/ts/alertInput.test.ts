import { beforeEach, expect, test, vi } from 'vitest'
import { get, writable } from 'svelte/store'

vi.mock('./stores.svelte', () => ({
    alertStore: writable({ type: 'none', msg: '' }),
    togglePresetsOpenStore: writable(false),
}))
vi.mock('./storage/database.svelte', () => ({ getDatabase: () => ({}), nodeOnlyVer: 'test' }))
vi.mock('../lang', () => ({ language: {} }))
vi.mock('./util', () => ({ sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)) }))
vi.mock('./log', () => ({ addLog: () => {} }))
vi.mock('./log-capture', () => ({ nativeConsoleError: () => {} }))
vi.mock('svelte-sonner', () => ({ toast: Object.assign(() => {}, { error: () => {}, success: () => {}, info: () => {}, warning: () => {} }) }))

const { alertInput } = await import('./alert')
const { alertStore } = await import('./stores.svelte')

beforeEach(() => alertStore.set({ type: 'none', msg: '' }))

test('ordinary inputs remain visible and preserve their suggestions and default', async () => {
    const pending = alertInput('Name', [['name', 'Name']], 'existing')
    expect(get(alertStore)).toMatchObject({ type: 'input', hideText: false, defaultValue: 'existing', datalist: [['name', 'Name']] })
    alertStore.set({ type: 'none', msg: 'renamed' })
    expect(await pending).toBe('renamed')
})

test('password inputs request masking and return the unchanged value', async () => {
    const pending = alertInput('Password', undefined, undefined, { hideText: true })
    expect(get(alertStore)).toMatchObject({ type: 'input', hideText: true, defaultValue: '' })
    alertStore.set({ type: 'none', msg: 'dummy-password' })
    expect(await pending).toBe('dummy-password')
})

test('a following ordinary input does not inherit password masking', async () => {
    const password = alertInput('Password', undefined, undefined, { hideText: true })
    alertStore.set({ type: 'none', msg: '' })
    expect(await password).toBe('')
    const name = alertInput('Name')
    expect(get(alertStore).hideText).toBe(false)
    alertStore.set({ type: 'none', msg: '' })
    expect(await name).toBe('')
})

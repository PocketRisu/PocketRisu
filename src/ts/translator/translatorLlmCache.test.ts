import { describe, it, expect, vi, beforeEach } from 'vitest'

const store = new Map<string, unknown>()
vi.mock('../storage/persistentKv', () => ({
    makeHashedStorageKey: async (prefix: string, text: string) => prefix + text,
    readPersistentJson: async (key: string) => store.get(key) ?? null,
    writePersistentJson: async (key: string, value: unknown) => { store.set(key, value) },
    clearPersistentPrefix: async () => { store.clear() },
    listPersistentKeys: async () => [...store.keys()],
}))
const requestChatData = vi.fn(async (..._args: unknown[]) => ({ type: 'success', result: '' }))
vi.mock('../process/request/request', () => ({ requestChatData }))
vi.mock('../storage/database.svelte', () => ({
    getDatabase: () => ({ translatorType: 'llm', characters: [], translatorPrompt: '' }),
}))
vi.mock('../globalApi.svelte', () => ({ globalFetch: vi.fn() }))
vi.mock('../alert', () => ({ notifyError: vi.fn() }))
vi.mock('../process/index.svelte', () => ({ doingChat: { subscribe: (fn: (v: boolean) => void) => { fn(false); return () => {} } } }))
vi.mock('../parser/parser.svelte', () => ({ applyMarkdownToNode: vi.fn(), risuChatParser: (t: string) => t }))
vi.mock('../stores.svelte', () => ({ selectedCharID: { subscribe: (fn: (v: number) => void) => { fn(0); return () => {} } } }))
vi.mock('../process/modules', () => ({ getModuleRegexScripts: () => [] }))
vi.mock('../process/scripts', () => ({ processScriptFull: vi.fn() }))
vi.mock('../notificationSound', () => ({ playNotificationSound: vi.fn() }))
vi.mock('./presets', async (orig) => ({
    ...(await orig<object>()),
    getCurrentTranslatorPreset: () => ({ prompt: '', maxResponse: 100 }),
}))

// A fresh module stands in for a reload: the persistent store survives it.
const load = async () => {
    vi.resetModules()
    return import('./translator')
}

describe('LLM translation cache', () => {
    beforeEach(() => {
        store.clear()
        requestChatData.mockClear()
    })

    it('remembers an empty reply for the session only and never stores it', async () => {
        let t = await load()
        requestChatData.mockResolvedValueOnce({ type: 'success', result: '' })
        expect(await t.runTranslator('Hello there', false, 'ko', 'en')).toBe('')
        expect(store.size).toBe(0)
        expect(await t.getLLMCache('Hello there')).toBeNull()
        // Same text again in this session (a different runTranslator input, so its
        // own result list does not answer): no second request.
        expect(await t.runTranslator('Hello there\n', false, 'ko', 'en')).toBe('')
        expect(requestChatData).toHaveBeenCalledTimes(1)

        t = await load()
        requestChatData.mockResolvedValueOnce({ type: 'success', result: '안녕하세요' })
        expect(await t.runTranslator('Hello there', false, 'ko', 'en')).toBe('안녕하세요')
        expect(requestChatData).toHaveBeenCalledTimes(2)
        expect(await t.getLLMCache('Hello there')).toBe('안녕하세요')
    })

    it('serves a stored translation without a request', async () => {
        const t = await load()
        await t.setLLMCache('Good night', '잘 자요')
        expect(await t.runTranslator('Good night', false, 'ko', 'en')).toBe('잘 자요')
        expect(requestChatData).not.toHaveBeenCalled()
    })

    it('keeps the cached translation when a regenerate comes back empty', async () => {
        const t = await load()
        await t.setLLMCache('Morning', '좋은 아침')
        requestChatData.mockResolvedValueOnce({ type: 'success', result: '' })
        expect(await t.translateHTML('Morning', false, '', -1, true)).toBe('')
        // The next view, the edit dialog and a reload all still see the old one.
        expect(await t.translateHTML('Morning', false, '', -1)).toBe('좋은 아침')
        expect(await t.getLLMCache('Morning')).toBe('좋은 아침')
        const reloaded = await load()
        expect(await reloaded.getLLMCache('Morning')).toBe('좋은 아침')
        expect(requestChatData).toHaveBeenCalledTimes(1)
    })

    it('serves a translation imported after an empty reply', async () => {
        const t = await load()
        requestChatData.mockResolvedValueOnce({ type: 'success', result: '' })
        expect(await t.translateHTML('Evening', false, '', -1)).toBe('')
        await t.importLLMCacheFromJSON({ Evening: '좋은 저녁' })
        expect(await t.translateHTML('Evening', false, '', -1)).toBe('좋은 저녁')
        expect(requestChatData).toHaveBeenCalledTimes(1)
    })

    it('skips an empty entry stored by an older version', async () => {
        store.set('cache/llm-translate/Old blank', { key: 'Old blank', value: '' })
        const t = await load()
        expect(await t.getLLMCache('Old blank')).toBeNull()
        requestChatData.mockResolvedValueOnce({ type: 'success', result: '예전 빈칸' })
        expect(await t.runTranslator('Old blank', false, 'ko', 'en')).toBe('예전 빈칸')
        expect(requestChatData).toHaveBeenCalledTimes(1)
    })
})

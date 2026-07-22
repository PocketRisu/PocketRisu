import { afterEach, beforeEach, describe, test, expect, vi } from 'vitest'

const storageMock = vi.hoisted(() => ({ realStorage: null as any }))
const tickMock = vi.hoisted(() => vi.fn(async () => {}))

// Stub out the heavy reactive modules so loading chatStorage.ts doesn't trigger
// unrelated $effect chains that fail in a stripped-down test environment.
// Mirror the production isChatStub semantics including the hybrid guard so
// the chat-data-loss tests below exercise the real intent.
vi.mock('../globalApi.svelte', () => ({ forageStorage: storageMock }))
vi.mock('svelte', () => ({ tick: tickMock }))
vi.mock('./database.svelte', () => ({
    isChatStub: (chat: any) => chat
        && chat._stub === true
        && !Array.isArray(chat.message),
}))

const {
    chatToStub,
    stubToPlaceholder,
    convertStubsToPlaceholders,
    classifyChat,
    ensureChatHydrated,
    hydrationInFlight,
    hydrationJustApplied,
} = await import('./chatStorage')
type Chat = any
type ChatStub = any

// Round-trip tests for stub ↔ placeholder conversions. The server merge layer
// relies on key presence ('in' semantics) to distinguish "user cleared this
// field" from "field is absent". Both client converters must preserve key
// presence end-to-end, otherwise null clears get dropped on the way out and
// stale fullChat metadata resurfaces on the next persist.

const blankChat = (overrides: Partial<Chat> = {}): Chat => ({
    message: [],
    note: '',
    name: 'test',
    localLore: [],
    id: 'c1',
    ...overrides,
})

describe('chatToStub', () => {
    test('preserves explicit null folderId as a key', () => {
        const stub = chatToStub(blankChat({ folderId: null as any }))
        expect('folderId' in stub).toBe(true)
        expect(stub.folderId).toBeNull()
    })

    test('omits folderId when the chat has no such key', () => {
        const stub = chatToStub(blankChat())
        expect('folderId' in stub).toBe(false)
    })

    test('preserves a non-null folderId', () => {
        const stub = chatToStub(blankChat({ folderId: 'F1' }))
        expect(stub.folderId).toBe('F1')
    })

    test('same key-presence semantics applies to modules', () => {
        expect('modules' in chatToStub(blankChat({ modules: null as any }))).toBe(true)
        expect('modules' in chatToStub(blankChat({ modules: [] }))).toBe(true)
        expect('modules' in chatToStub(blankChat())).toBe(false)
    })

    test('same key-presence semantics applies to lastDate', () => {
        expect('lastDate' in chatToStub(blankChat({ lastDate: null as any }))).toBe(true)
        expect('lastDate' in chatToStub(blankChat({ lastDate: 0 }))).toBe(true)
        expect('lastDate' in chatToStub(blankChat())).toBe(false)
    })

    test('returns input untouched when already a stub', () => {
        const stub: ChatStub = { id: 'c1', name: 't', _stub: true }
        expect(chatToStub(stub)).toBe(stub)
    })
})

describe('stubToPlaceholder', () => {
    test('preserves explicit null folderId from server', () => {
        const stub: ChatStub = {
            id: 'c1',
            name: 't',
            _stub: true,
            folderId: null as any,
        }
        const placeholder = stubToPlaceholder(stub)
        expect('folderId' in placeholder).toBe(true)
        expect(placeholder.folderId).toBeNull()
    })

    test('omits folderId when stub has no such key', () => {
        const stub: ChatStub = { id: 'c1', name: 't', _stub: true }
        const placeholder = stubToPlaceholder(stub)
        expect('folderId' in placeholder).toBe(false)
    })

    test('marks placeholder for hydration', () => {
        const stub: ChatStub = { id: 'c1', name: 't', _stub: true }
        const placeholder = stubToPlaceholder(stub)
        expect(placeholder._placeholder).toBe(true)
        expect(placeholder.fmIndex).toBe(-1)
        expect(placeholder.message).toEqual([])
    })

    test('preserves modules key (null and array)', () => {
        const nullStub: ChatStub = { id: 'c1', name: 't', _stub: true, modules: null as any }
        expect('modules' in stubToPlaceholder(nullStub)).toBe(true)
        expect(stubToPlaceholder(nullStub).modules).toBeNull()

        const arrStub: ChatStub = { id: 'c1', name: 't', _stub: true, modules: ['m1'] }
        expect(stubToPlaceholder(arrStub).modules).toEqual(['m1'])
    })
})

// The bug this branch fixes: a user clearing folderId would round-trip into
// a "remove" patch op once the placeholder dropped the null key. With key
// presence preserved end-to-end, the explicit null survives placeholder →
// stub conversion and reaches the server merge layer as a real value.
describe('chat → stub → placeholder → stub round-trip', () => {
    test('null folderId survives the full round-trip', () => {
        const original = blankChat({ folderId: null as any })
        const stub1 = chatToStub(original)
        const placeholder = stubToPlaceholder({ ...stub1, _stub: true })
        const stub2 = chatToStub(placeholder)
        expect('folderId' in stub2).toBe(true)
        expect(stub2.folderId).toBeNull()
    })

    test('null modules survives the full round-trip', () => {
        const original = blankChat({ modules: null as any })
        const stub1 = chatToStub(original)
        const placeholder = stubToPlaceholder({ ...stub1, _stub: true })
        const stub2 = chatToStub(placeholder)
        expect('modules' in stub2).toBe(true)
        expect(stub2.modules).toBeNull()
    })

    test('absent folderId stays absent through the round-trip', () => {
        const original = blankChat()
        const stub1 = chatToStub(original)
        const placeholder = stubToPlaceholder({ ...stub1, _stub: true })
        const stub2 = chatToStub(placeholder)
        expect('folderId' in stub2).toBe(false)
    })

    test('non-null folderId survives the round-trip unchanged', () => {
        const original = blankChat({ folderId: 'F1' })
        const stub1 = chatToStub(original)
        const placeholder = stubToPlaceholder({ ...stub1, _stub: true })
        const stub2 = chatToStub(placeholder)
        expect(stub2.folderId).toBe('F1')
    })
})

// Hybrid corruption: a chat with `_stub: true` AND a real message array.
// Came from v1.4.x disk corruption. The lazy-loading invariants assume
// `_stub: true` means "metadata only", so the hybrid leaks Chat fields into
// patcher diffs and trips the chat-data guard. The fix self-heals by
// excluding hybrids from isChatStub (so chatToStub strips them properly)
// and by stripping the corrupt _stub flag in convertStubsToPlaceholders
// (preserving the real message data instead of resetting to placeholder).
describe('hybrid corruption (chat with _stub:true + message)', () => {
    const hybridChat = (overrides: any = {}): any => ({
        message: [{ role: 'user', data: 'hello' }],
        note: 'old note',
        name: 'h',
        localLore: [{ key: 'k' }],
        id: 'c-hybrid',
        _stub: true,
        ...overrides,
    })

    test('classifyChat tags _stub + message as "hybrid"', () => {
        expect(classifyChat(hybridChat())).toBe('hybrid')
    })

    test('chatToStub collapses hybrid down to a real stub (drops message)', () => {
        const result = chatToStub(hybridChat()) as any
        expect(result._stub).toBe(true)
        expect('message' in result).toBe(false)
        expect('note' in result).toBe(false)
        expect('localLore' in result).toBe(false)
        expect(result.id).toBe('c-hybrid')
        expect(result.name).toBe('h')
    })

    test('convertStubsToPlaceholders keeps hybrid as a Chat with message preserved', () => {
        const [recovered] = convertStubsToPlaceholders([hybridChat()])
        // _stub flag must be gone — leaving it would re-enter the hybrid loop.
        expect((recovered as any)._stub).toBeUndefined()
        // Original message must survive — converting to a placeholder would
        // reset it to [], which IS the data-loss bug we're guarding against.
        expect(Array.isArray(recovered.message)).toBe(true)
        expect(recovered.message.length).toBe(1)
        expect(recovered.message[0].data).toBe('hello')
        expect(recovered.note).toBe('old note')
        expect(recovered.localLore.length).toBe(1)
    })

    test('convertStubsToPlaceholders still converts real stubs to placeholders', () => {
        const realStub: ChatStub = { id: 'c1', name: 't', _stub: true }
        const [result] = convertStubsToPlaceholders([realStub])
        expect((result as any)._placeholder).toBe(true)
        expect(result.message).toEqual([])
        expect(result.fmIndex).toBe(-1)
    })

    test('convertStubsToPlaceholders leaves real Chats alone', () => {
        const realChat: Chat = {
            message: [], note: '', name: 'x', localLore: [], id: 'c2',
        }
        const [result] = convertStubsToPlaceholders([realChat])
        expect(result).toBe(realChat)   // same reference, untouched
    })

    test('hybrid round-trip self-heals: convert → chatToStub → no message leakage', () => {
        // Simulate the actual v1.4.x bug path:
        //   disk → decoded chat is hybrid → convertStubsToPlaceholders → patcher diff
        const [recovered] = convertStubsToPlaceholders([hybridChat()])
        const stub = chatToStub(recovered) as any
        expect(stub._stub).toBe(true)
        expect('message' in stub).toBe(false)
        expect('note' in stub).toBe(false)
        // Once stripped, the chat-data guard would see no chat-internal field
        // ops in a baseline-vs-current diff between two of these stubs.
    })
})

describe('lazy chat hydration safety', () => {
    const placeholder = (id = 'chat-1'): Chat => ({
        message: [],
        note: '',
        name: 'placeholder',
        localLore: [],
        id,
        fmIndex: -1,
        _placeholder: true,
    })
    const fullChat = (id = 'chat-1'): Chat => ({
        message: [{ role: 'user', data: 'hello' }],
        note: '',
        name: 'hydrated',
        localLore: [],
        id,
        fmIndex: -1,
    })

    beforeEach(() => {
        vi.useFakeTimers()
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            callback(0)
            return 1
        })
        tickMock.mockReset()
        tickMock.mockResolvedValue(undefined)
        hydrationInFlight.clear()
        hydrationJustApplied.clear()
    })

    afterEach(() => {
        vi.useRealTimers()
        vi.unstubAllGlobals()
        storageMock.realStorage = null
    })

    test('hydrates a valid matching chat payload', async () => {
        const chats = [placeholder()]
        const full = fullChat()
        storageMock.realStorage = {
            fetchChatContent: vi.fn().mockResolvedValue(full),
        }

        await expect(ensureChatHydrated(chats, 0, 'character-1')).resolves.toBe(full)
        expect(chats[0]).toBe(full)
        expect(hydrationInFlight.size).toBe(0)
        expect(hydrationJustApplied.size).toBe(0)
    })

    test.each([
        ['a mismatched id', fullChat('other-chat')],
        ['a missing message array', { ...fullChat(), message: undefined }],
        ['a server stub', { id: 'chat-1', name: 'stub', _stub: true }],
    ])('rejects %s without replacing the placeholder', async (_label, payload) => {
        const original = placeholder()
        const chats = [original]
        storageMock.realStorage = {
            fetchChatContent: vi.fn().mockResolvedValue(payload),
        }

        await expect(ensureChatHydrated(chats, 0, 'character-1')).resolves.toBeNull()
        expect(chats[0]).toBe(original)
    })

    test('uses the timer fallback when requestAnimationFrame never fires', async () => {
        vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
        const chats = [placeholder()]
        const full = fullChat()
        storageMock.realStorage = {
            fetchChatContent: vi.fn().mockResolvedValue(full),
        }

        const hydration = ensureChatHydrated(chats, 0, 'character-1')
        await vi.advanceTimersByTimeAsync(49)
        expect(chats[0]._placeholder).toBe(true)
        await vi.advanceTimersByTimeAsync(1)

        await expect(hydration).resolves.toBe(full)
        expect(chats[0]).toBe(full)
    })

    test('always clears suppression flags when the Svelte tick rejects', async () => {
        const chats = [placeholder()]
        storageMock.realStorage = {
            fetchChatContent: vi.fn().mockResolvedValue(fullChat()),
        }
        tickMock.mockRejectedValueOnce(new Error('tick failed'))

        await expect(ensureChatHydrated(chats, 0, 'character-1')).rejects.toThrow('tick failed')
        expect(hydrationInFlight.size).toBe(0)
        expect(hydrationJustApplied.size).toBe(0)
    })

    test('does not apply an old response after the placeholder slot is replaced', async () => {
        let resolveFetch!: (chat: Chat) => void
        const fetchPromise = new Promise<Chat>(resolve => { resolveFetch = resolve })
        storageMock.realStorage = {
            fetchChatContent: vi.fn().mockReturnValue(fetchPromise),
        }
        const original = placeholder()
        const replacement = placeholder()
        const chats = [original]

        const hydration = ensureChatHydrated(chats, 0, 'character-1')
        chats[0] = replacement
        resolveFetch(fullChat())

        await expect(hydration).resolves.toBeNull()
        expect(chats[0]).toBe(replacement)
    })

    test('rechecks deletion while waiting for the paint yield', async () => {
        let frameCallback: FrameRequestCallback | undefined
        vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
            frameCallback = callback
            return 1
        }))
        const chats = [placeholder()]
        storageMock.realStorage = {
            fetchChatContent: vi.fn().mockResolvedValue(fullChat()),
        }

        const hydration = ensureChatHydrated(chats, 0, 'character-1')
        for (let i = 0; i < 6 && !frameCallback; i++) await Promise.resolve()
        expect(frameCallback).toBeTypeOf('function')
        chats.splice(0, 1)
        frameCallback!(0)

        await expect(hydration).resolves.toBeNull()
        expect(chats).toHaveLength(0)
    })

    test('deduplicates requests for one array but not a replacement database array', async () => {
        const fetchChatContent = vi.fn().mockResolvedValue(fullChat())
        storageMock.realStorage = { fetchChatContent }
        const firstDatabaseChats = [placeholder()]
        const replacementDatabaseChats = [placeholder()]

        const first = ensureChatHydrated(firstDatabaseChats, 0, 'character-1')
        const duplicate = ensureChatHydrated(firstDatabaseChats, 0, 'character-1')
        const replacement = ensureChatHydrated(replacementDatabaseChats, 0, 'character-1')

        await Promise.all([first, duplicate, replacement])
        expect(fetchChatContent).toHaveBeenCalledTimes(2)
        expect(firstDatabaseChats[0]._placeholder).toBeUndefined()
        expect(replacementDatabaseChats[0]._placeholder).toBeUndefined()
        expect(hydrationInFlight.size).toBe(0)
        expect(hydrationJustApplied.size).toBe(0)
    })
})

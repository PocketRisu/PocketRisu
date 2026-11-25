// @vitest-environment node

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { beforeAll, expect, test, vi } from 'vitest'

vi.mock('../parser/parser.svelte', () => ({
  hasher: vi.fn(),
  risuChatParser: vi.fn(),
}))

vi.mock('../alert', () => ({
  alertConfirm: vi.fn(),
  alertError: vi.fn(),
  alertInput: vi.fn(),
  alertNormal: vi.fn(),
  alertSelect: vi.fn(),
}))

vi.mock('../globalApi.svelte', () => ({ fetchNative: vi.fn(), readImage: vi.fn() }))
vi.mock('../tokenizer', () => ({ tokenize: vi.fn() }))
vi.mock('../util', () => ({
  asBuffer: vi.fn(),
  getPersonaPrompt: vi.fn(),
  getUserIcon: vi.fn(),
  getUserName: vi.fn(),
  parseKeyValue: (template?: string) =>
    template ? template.split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]) : [],
}))

vi.mock('../storage/database.svelte', () => ({
  getCurrentCharacter: vi.fn(() => ({})),
  getCurrentChat: vi.fn(() => ({ message: [] })),
  getDatabase: vi.fn(() => ({ characters: [] })),
  setDatabase: vi.fn(),
}))

vi.mock('../stores.svelte', () => ({
  DBState: { db: {} },
  ReloadChatPointer: { update: vi.fn() },
  ReloadGUIPointer: { update: vi.fn() },
  selectedCharID: { subscribe: (run: (value: number) => void) => (run(0), () => undefined) },
}))

vi.mock('./modules', () => ({
  getModuleLorebooks: vi.fn(() => []),
  getModuleTriggers: vi.fn(() => []),
}))

vi.mock('./files/inlays', () => ({ getInlayAsset: vi.fn(), writeInlayImage: vi.fn() }))
vi.mock('./lorebook.svelte', () => ({ loadLoreBookV3Prompt: vi.fn() }))
vi.mock('./memory/hypamemory', () => ({ HypaProcesser: vi.fn() }))
vi.mock('./request/request', () => ({ requestChatData: vi.fn(async () => ({ type: 'success', result: 'ok' })) }))
vi.mock('./stableDiff', () => ({ generateAIImage: vi.fn() }))

let runScripted: typeof import('./scriptings').runScripted
let runLuaInteractionTrigger: typeof import('./scriptings').runLuaInteractionTrigger

beforeAll(async () => {
  const jsonLua = await readFile(resolve(process.cwd(), 'public/lua/json.lua'), 'utf8')
  vi.stubGlobal('fetch', vi.fn(async () => new Response(jsonLua, { status: 200 })))
  const scriptings = await import('./scriptings')
  runScripted = scriptings.runScripted
  runLuaInteractionTrigger = scriptings.runLuaInteractionTrigger
})

test('does not stop generation when setStateChanged is a no-op', async () => {
  const result = await runScripted(
    `
      function onStart(id)
        return setStateChanged(id, "unchanged", "value")
      end
    `,
    {
      char: {} as never,
      chat: { message: [] } as never,
      setVar: () => false,
      getVar: () => 'null',
      mode: 'start',
    }
  )

  expect(result.stopSending).toBe(false)
  expect(result.res).toBeNull()
})

test('keeps explicit false as the generation stop signal', async () => {
  const result = await runScripted('function onStart() return false end', {
    char: {} as never,
    chat: { message: [] } as never,
    mode: 'start',
  })

  expect(result.res).toBe(false)
  expect(result.stopSending).toBe(true)
})

test.each(['editDisplay', 'editInput', 'editOutput', 'editRequest'])(
  'skips %s without listeners after initializing the script once',
  async (mode) => {
    const getVar = vi.fn(() => 'initialized')
    const code = `
      getChatVar('', 'initialization')
      json.decode = function() error('Unexpected listener dispatch') end
      json.encode = function() error('Unexpected listener dispatch') end
    `
    const data = mode === 'editRequest' ? [{ content: 'hello', role: 'user' as const }] : 'hello'

    for (let index = 0; index < 2; index++) {
      const result = await runScripted(code, {
        char: {} as never,
        chat: { message: [] } as never,
        data,
        getVar,
        meta: {},
        mode,
      })

      expect(result.res).toBe(data)
      expect(result.stopSending).toBe(false)
    }
    expect(getVar).toHaveBeenCalledExactlyOnceWith('initialization')
  }
)

test.each(['editDisplay', 'editInput', 'editOutput', 'editRequest'])(
  'executes registered %s listeners',
  async (mode) => {
    const result = await runScripted(
      `
        local event = '${mode}'
        listenEdit(event, function(id, value, meta)
          return value .. meta.suffix
        end)
      `,
      {
        char: {} as never,
        chat: { message: [] } as never,
        data: 'hello',
        meta: { suffix: ' world' },
        mode,
      }
    )

    expect(result.res).toBe('hello world')
  }
)

test('runs editDisplay without JSON-encoding its value or result', async () => {
  const data = '"quoted"\nline'
  const result = await runScripted(
    `
      listenEdit('editDisplay', function(id, value)
        json.encode = function() error('Unexpected JSON encoding') end
        return value .. ' edited'
      end)
    `,
    {
      char: {} as never,
      chat: { message: [] } as never,
      data,
      meta: {},
      mode: 'editDisplay',
    }
  )

  expect(result.res).toBe(`${data} edited`)
})

test('clears listener registration when script replacement recreates the engine', async () => {
  const options = {
    char: {} as never,
    chat: { message: [] } as never,
    data: 'original',
    mode: 'editDisplay',
  }
  const registered = await runScripted(
    `
      listenEdit('editDisplay', function() return 'edited' end)
    `,
    options
  )
  expect(registered.res).toBe('edited')

  const unregistered = await runScripted(
    `
      json.decode = function() error('Stale listener registration') end
    `,
    options
  )
  expect(unregistered.res).toBe('original')
})

test('tracks a listener registered after initialization', async () => {
  let register: () => void = () => {
    throw new Error('Missing registration callback')
  }
  const code = `
    getChatVar('', function()
      listenEdit('editDisplay', function(id, value) return value .. ' edited' end)
    end)
  `
  const options = {
    char: {} as never,
    chat: { message: [] } as never,
    data: 'original',
    getVar: vi.fn((callback: unknown) => {
      register = callback as () => void
      return ''
    }),
    mode: 'editDisplay',
  }

  const before = await runScripted(code, options)
  expect(before.res).toBe('original')
  register()
  const after = await runScripted(code, options)
  expect(after.res).toBe('original edited')
})

test('passes API results to Lua as plain tables without JS constructors', async () => {
  const result = await runScripted(
    `
      onStart = async(function(id)
        local response = simpleLLM(id, "prompt"):await()
        return { type = type(response), hasConstructor = response.constructor ~= nil }
      end)
    `,
    {
      char: { type: 'character' } as never,
      chat: { message: [] } as never,
      lowLevelAccess: true,
      mode: 'start',
    }
  )

  expect(result.res).toEqual({ type: 'table', hasConstructor: false })
})

test.each(['button', 'form'] as const)('keeps a %s script on the chat it started on', async (type) => {
  const started = { message: [], scriptstate: {} }
  const opened = { message: [], scriptstate: {} }
  const { getCurrentChat } = await import('../storage/database.svelte')
  vi.mocked(getCurrentChat).mockReturnValue(opened as never)
  const code = `
    function onButtonClick(id, data)
      setChatVar(id, 'picked', data .. ':' .. getChatVar(id, 'fallback'))
      addChat(id, 'char', 'clicked')
    end
    function onFormSubmit(id, data)
      onButtonClick(id, data)
    end
  `
  const char = {
    type: 'character',
    defaultVariables: 'fallback=default',
    triggerscript: [{ comment: '', type: 'manual', conditions: [], effect: [{ type: 'triggerlua', code }] }],
  }

  const result = await runLuaInteractionTrigger(type, char as never, 'A', undefined, started as never)

  expect(started.scriptstate).toEqual({ $picked: 'A:default' })
  expect(started.message).toEqual([{ role: 'char', data: 'clicked' }])
  expect(opened).toEqual({ message: [], scriptstate: {} })
  expect(result.chat).toBe(started)
})

test('setFullChat preserves message metadata on an identity round-trip', async () => {
  const message = [
    {
      role: 'user',
      data: 'hello',
      chatId: 'id-user',
      time: 100,
      name: 'alice',
      otherUser: true,
    },
    {
      role: 'char',
      data: 'hi',
      chatId: 'id-char',
      time: 200,
      saying: 'char-a',
      generationInfo: { generationId: 'gen-1', model: 'model-x' },
      promptInfo: { promptText: [] },
    },
  ]

  const result = await runScripted(
    `
      function onStart(id)
        setFullChat(id, getFullChat(id))
      end
    `,
    {
      char: {} as never,
      chat: { message: structuredClone(message) } as never,
      mode: 'start',
    }
  )

  expect(result.chat.message).toEqual(message)
})

test('setFullChat matches messages by chatId and only overwrites role and data', async () => {
  const result = await runScripted(
    `
      function onStart(id)
        local chat = getFullChat(id)
        chat[1].data = "edited"
        chat[2].role = "user"
        chat[2].time = 999
        table.insert(chat, 1, { role = "char", data = "prepended" })
        setFullChat(id, chat)
      end
    `,
    {
      char: {} as never,
      chat: {
        message: [
          { role: 'user', data: 'first', chatId: 'id-1', time: 1 },
          { role: 'char', data: 'second', chatId: 'id-2', time: 2, generationInfo: { generationId: 'gen-2' } },
        ],
      } as never,
      mode: 'start',
    }
  )

  expect(result.chat.message).toEqual([
    { role: 'char', data: 'prepended' },
    { role: 'user', data: 'edited', chatId: 'id-1', time: 1 },
    { role: 'user', data: 'second', chatId: 'id-2', time: 2, generationInfo: { generationId: 'gen-2' } },
  ])
})

test('setFullChat drops messages that are no longer present and does not alias duplicated chatIds', async () => {
  const result = await runScripted(
    `
      function onStart(id)
        local chat = getFullChat(id)
        table.remove(chat, 1)
        table.insert(chat, { role = chat[1].role, data = "copy", chatId = chat[1].chatId })
        setFullChat(id, chat)
      end
    `,
    {
      char: {} as never,
      chat: {
        message: [
          { role: 'user', data: 'first', chatId: 'id-1', time: 1 },
          { role: 'char', data: 'second', chatId: 'id-2', time: 2 },
        ],
      } as never,
      mode: 'start',
    }
  )

  expect(result.chat.message).toEqual([
    { role: 'char', data: 'second', chatId: 'id-2', time: 2 },
    { role: 'char', data: 'copy' },
  ])
  expect(result.chat.message[0]).not.toBe(result.chat.message[1])
})

// PocketRisu: scripts written before getFullChat exposed chatId rebuild the
// table as { role, data }. Their metadata is kept by position while the length
// is unchanged (86f2fe41f); after an insert or a delete it is not guessed.
test('setFullChat keeps metadata by position for a same-length rebuild without chatId', async () => {
  const result = await runScripted(
    `
      function onStart(id)
        local chat = getFullChat(id)
        local rebuilt = {}
        for i, m in ipairs(chat) do
          rebuilt[i] = { role = m.role, data = m.data .. "!" }
        end
        setFullChat(id, rebuilt)
      end
    `,
    {
      char: {} as never,
      chat: {
        message: [
          { role: 'user', data: 'first', chatId: 'id-1', time: 1 },
          { role: 'char', data: 'second', chatId: 'id-2', time: 2, generationInfo: { generationId: 'gen-2' } },
        ],
      } as never,
      mode: 'start',
    }
  )

  expect(result.chat.message).toEqual([
    { role: 'user', data: 'first!', chatId: 'id-1', time: 1 },
    { role: 'char', data: 'second!', chatId: 'id-2', time: 2, generationInfo: { generationId: 'gen-2' } },
  ])
})

test('setFullChat does not guess metadata by position after an insert without chatId', async () => {
  const result = await runScripted(
    `
      function onStart(id)
        setFullChat(id, {
          { role = "char", data = "new" },
          { role = "user", data = "first" },
          { role = "char", data = "second" },
        })
      end
    `,
    {
      char: {} as never,
      chat: {
        message: [
          { role: 'user', data: 'first', chatId: 'id-1', time: 1 },
          { role: 'char', data: 'second', chatId: 'id-2', time: 2 },
        ],
      } as never,
      mode: 'start',
    }
  )

  expect(result.chat.message).toEqual([
    { role: 'char', data: 'new' },
    { role: 'user', data: 'first' },
    { role: 'char', data: 'second' },
  ])
})

test('setFullChat does not reuse a message already claimed by chatId for a position fallback', async () => {
  const result = await runScripted(
    `
      function onStart(id)
        local chat = getFullChat(id)
        setFullChat(id, {
          { role = "user", data = "a" },
          { role = chat[1].role, data = "moved", chatId = chat[1].chatId },
        })
      end
    `,
    {
      char: {} as never,
      chat: {
        message: [
          { role: 'user', data: 'first', chatId: 'id-1', time: 1 },
          { role: 'char', data: 'second', chatId: 'id-2', time: 2 },
        ],
      } as never,
      mode: 'start',
    }
  )

  expect(result.chat.message).toEqual([
    { role: 'user', data: 'a' },
    { role: 'user', data: 'moved', chatId: 'id-1', time: 1 },
  ])
})

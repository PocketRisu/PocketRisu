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

beforeAll(async () => {
  const jsonLua = await readFile(resolve(process.cwd(), 'public/lua/json.lua'), 'utf8')
  vi.stubGlobal('fetch', vi.fn(async () => new Response(jsonLua, { status: 200 })))
  const scriptings = await import('./scriptings')
  runScripted = scriptings.runScripted
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

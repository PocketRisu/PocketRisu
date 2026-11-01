/**
 * "Keep using this tab" on the deactivated dialog claims the write lock
 * through the real server: a tab left open elsewhere that keeps saving on its
 * own no longer locks every other device out, and the page that asked stays
 * locked out with its old copy until it reloads under the claimed id.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { fileURLToPath } from 'node:url'
import { access, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Packr } from 'msgpackr'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'

const utils = require('../../server/node/utils.cjs') as typeof import('../../server/node/utils.cjs')

const MAGIC_RAW = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])
const packr = new Packr({ useRecords: false })
const encode = (data: unknown) => new Uint8Array(Buffer.concat([MAGIC_RAW, packr.encode(data)]))

const CHA = 'test-char-0'
const CHAT = 'chat-0-0'

let srv: ServerHandle
let client: RisuClient

beforeAll(async () => {
  const preload = fileURLToPath(new URL('./helpers/slow-decode-preload.cjs', import.meta.url))
  srv = await spawnServer({ env: { NODE_OPTIONS: `--require ${JSON.stringify(preload)}` } })
  client = await createClient(srv.port, srv.password)
})

afterAll(async () => {
  await srv?.cleanup()
})

// A page load: registers the boot of this session id.
async function boot(sessionId: string) {
  const res = await client.fetch('/api/session', { method: 'POST', headers: { 'x-session-id': sessionId } })
  expect(res.status).toBe(200)
}

// A data write from a page of this session.
function write(sessionId: string, userActive = false) {
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream',
    'file-path': Buffer.from('test/session-claim.txt').toString('hex'),
    'x-session-id': sessionId,
  }
  if (userActive) headers['x-user-active'] = '1'
  return client.fetch('/api/write', { method: 'POST', headers, body: new Uint8Array(Buffer.from('x')) })
}

function claim(sessionId?: string) {
  return client.fetch('/api/session/claim', { method: 'POST', headers: sessionId ? { 'x-session-id': sessionId } : {} })
}

async function readChat() {
  const res = await client.fetch(`/api/chat-content/${CHA}/0`, { headers: { 'x-chat-id': CHAT } })
  expect(res.status).toBe(200)
  return await utils.decodeRisuSave(Buffer.from(await res.arrayBuffer())) as any
}

async function waitForFile(file: string) {
  for (let i = 0; i < 200; i++) {
    try {
      await access(file)
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  throw new Error(`${file} never appeared`)
}

describe('session claim', () => {
  test('takes the lock from a holder that keeps saving on its own', async () => {
    await boot('home')
    expect((await write('home')).status).toBe(200)
    await boot('phone')
    expect((await write('home')).status).toBe(200)       // the unattended tab saves again
    expect((await write('phone', true)).status).toBe(423) // phone is stale

    expect((await claim('phone-next')).status).toBe(200)
    expect((await write('home')).status).toBe(423)        // the unattended tab is locked out
    expect((await write('phone', true)).status).toBe(423) // so is the asking page's old copy

    await boot('phone-next')                              // the reload under the claimed id
    expect((await write('phone-next')).status).toBe(200)
    const lock = await (await client.fetch('/api/session/lock-status', { headers: { 'x-session-id': 'phone-next' } })).json() as any
    expect(lock.state).toBe('active')
  })

  test('needs a session id', async () => {
    expect((await claim()).status).toBe(400)
  })

  test('refuses an id a page already booted with', async () => {
    await boot('booted-early')
    expect((await claim('booted-early')).status).toBe(409)
  })

  // The reload that follows a claim must read every write accepted before
  // it, or its later save would put back a copy without them.
  test('answers only after writes accepted before it have landed', async () => {
    const imported = await client.importBackup(createSeedBackup({ characterCount: 1, messagesPerChat: 2 }))
    expect(imported.ok).toBe(true)
    await boot('home-2')
    expect((await write('home-2', true)).status).toBe(200) // home-2 holds the lock
    const base = await readChat()

    const flag = path.join(srv.cwd, 'slow-decode')
    const entered = path.join(srv.cwd, 'decode-entered')
    await rm(entered, { force: true })
    await writeFile(flag, '')
    let homeSave: Promise<Response>
    try {
      homeSave = client.fetch(`/api/chat-content/${CHA}/0`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'x-chat-id': CHAT, 'x-session-id': 'home-2' },
        body: encode({ ...base, message: [...base.message, { role: 'user', data: 'home-new' }] }),
      })
      await waitForFile(entered)                           // the save is in the queue, decoding
      expect((await claim('phone-next-2')).status).toBe(200)
    } finally {
      await rm(flag, { force: true })
    }
    // Read right after the claim answered, as the reloaded page does.
    expect((await readChat()).message.at(-1).data).toBe('home-new')
    expect((await homeSave).status).toBe(200)
  })

  // A page reads its data right after its boot is registered. A write
  // accepted before that must have landed by then: the page would otherwise
  // count as booted after it while holding a copy without it, take the lock
  // with its first action and save that copy over it.
  test('registers a boot only after writes under way have landed', async () => {
    await boot('home-3')
    expect((await write('home-3', true)).status).toBe(200) // home-3 holds the lock
    const base = await readChat()

    const flag = path.join(srv.cwd, 'slow-decode')
    const entered = path.join(srv.cwd, 'decode-entered')
    await rm(entered, { force: true })
    await writeFile(flag, '')
    let homeSave: Promise<Response>
    try {
      homeSave = client.fetch(`/api/chat-content/${CHA}/0`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'x-chat-id': CHAT, 'x-session-id': 'home-3' },
        body: encode({ ...base, message: [...base.message, { role: 'user', data: 'home-3-new' }] }),
      })
      await waitForFile(entered)                           // the save is under way, decoding
      await boot('late-page')
    } finally {
      await rm(flag, { force: true })
    }
    // Read right after the boot answered, as the page does.
    expect((await readChat()).message.at(-1).data).toBe('home-3-new')
    expect((await homeSave).status).toBe(200)
    expect((await write('late-page', true)).status).toBe(200) // and it takes over as usual
  })

  // The connection can drop while the route is still writing (here: waiting
  // in the storage queue). The route goes on and commits, so a page booting
  // after the drop must still wait for it.
  test('a save whose connection dropped holds boots back until it lands', async () => {
    await boot('home-4')
    expect((await write('home-4', true)).status).toBe(200) // home-4 holds the lock
    const base = await readChat()

    const flag = path.join(srv.cwd, 'slow-decode')
    const entered = path.join(srv.cwd, 'decode-entered')
    await rm(entered, { force: true })
    await writeFile(flag, '')
    try {
      const abort = new AbortController()
      const homeSave = client.fetch(`/api/chat-content/${CHA}/0`, {
        method: 'POST',
        signal: abort.signal,
        headers: { 'content-type': 'application/octet-stream', 'x-chat-id': CHAT, 'x-session-id': 'home-4' },
        body: encode({ ...base, message: [...base.message, { role: 'user', data: 'home-4-new' }] }),
      }).catch(() => null)
      await waitForFile(entered)                           // the save is in the queue, decoding
      abort.abort()                                        // and its connection drops
      await homeSave
      await new Promise((resolve) => setTimeout(resolve, 20)) // the server sees the drop
      await boot('late-page-2')
    } finally {
      await rm(flag, { force: true })
    }
    expect((await readChat()).message.at(-1).data).toBe('home-4-new')
  })
})

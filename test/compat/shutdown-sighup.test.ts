/**
 * Closing the window or terminal sends SIGHUP (Windows console, Termux
 * session). The server must flush and exit like on SIGTERM, not die at once
 * with the debounced save still pending.
 */
import { describe, test, expect, afterAll } from 'vitest'
import { cp } from 'node:fs/promises'
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

const servers: ServerHandle[] = []
afterAll(async () => {
  await Promise.allSettled(servers.map(s => s.cleanup()))
})

async function getChat(client: RisuClient) {
  const res = await client.fetch(`/api/chat-content/${CHA}/0`, { headers: { 'x-chat-id': CHAT } })
  expect(res.status).toBe(200)
  return utils.decodeRisuSave(Buffer.from(await res.arrayBuffer())) as any
}

describe('shutdown', () => {
  test('SIGHUP writes a pending chat save before exiting', async () => {
    const srv = await spawnServer()
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)
    expect((await client.importBackup(createSeedBackup({ characterCount: 1 }))).ok).toBe(true)

    // A chat save is written to disk after a 5 s debounce.
    const chat = await getChat(client)
    chat.message.push({ role: 'user', data: 'written right before the window closed' })
    const saved = await client.fetch(`/api/chat-content/${CHA}/0`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-chat-id': CHAT },
      body: encode(chat),
    })
    expect(saved.status).toBe(200)

    let stdout = ''
    srv.child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    const exited = new Promise<{ code: number | null, signal: NodeJS.Signals | null }>((resolve) => {
      srv.child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    srv.child.kill('SIGHUP')
    expect(await exited).toEqual({ code: 0, signal: null })
    expect(stdout).toContain('Received SIGHUP, flushing pending data')

    // Boot a new server on a copy of that save folder.
    const next = await spawnServer({
      seedSave: (saveDir) => cp(path.join(srv.cwd, 'save'), saveDir, { recursive: true }),
    })
    servers.push(next)
    const reread = await getChat(await createClient(next.port, next.password))
    expect(reread.message.at(-1).data).toBe('written right before the window closed')
  })
})

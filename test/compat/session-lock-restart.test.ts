/**
 * The write lock holder survives a server restart. Before, the first page to
 * write after a restart took the free lock, so a page loaded before newer
 * writes on another device saved its older copy over them.
 */
import { afterAll, describe, expect, test } from 'vitest'
import { cp } from 'node:fs/promises'
import path from 'node:path'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'

const servers: ServerHandle[] = []
afterAll(async () => {
  await Promise.allSettled(servers.map((s) => s.cleanup()))
})

async function boot(client: RisuClient, sessionId: string) {
  const res = await client.fetch('/api/session', { method: 'POST', headers: { 'x-session-id': sessionId } })
  expect(res.status).toBe(200)
}

function write(client: RisuClient, sessionId: string) {
  return client.fetch('/api/write', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'file-path': Buffer.from('test/session-lock-restart.txt').toString('hex'),
      'x-session-id': sessionId,
      'x-user-active': '1',
    },
    body: new Uint8Array(Buffer.from(sessionId)),
  })
}

describe('session lock across a restart', () => {
  test('a page loaded before the last write stays locked out', async () => {
    const first = await spawnServer()
    servers.push(first)
    const before = await createClient(first.port, first.password)
    await boot(before, 'phone')          // opened, then left
    await boot(before, 'pc')
    expect((await write(before, 'pc')).status).toBe(200)  // newer than the phone's copy
    const stopped = new Promise((resolve) => first.child.once('exit', resolve))
    first.child.kill('SIGTERM')
    await stopped

    const second = await spawnServer({
      seedSave: (saveDir) => cp(path.join(first.cwd, 'save'), saveDir, { recursive: true }),
    })
    servers.push(second)
    const after = await createClient(second.port, second.password)
    expect((await write(after, 'phone')).status).toBe(423)
    expect((await write(after, 'pc')).status).toBe(200)
  })
})

import { afterAll, describe, expect, test } from 'vitest'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'

const servers: ServerHandle[] = []
afterAll(async () => {
  await Promise.allSettled(servers.map(server => server.cleanup()))
})

const hex = (value: string) => Buffer.from(value, 'utf-8').toString('hex')

describe('confirmed orphan cleanup scan', () => {
  test('deletes only reviewed candidates that remain eligible', async () => {
    const server = await spawnServer()
    servers.push(server)
    const client = await createClient(server.port, server.password)
    await client.importBackup(createSeedBackup({ characterCount: 0 }))
    await client.fetch('/api/read', {
      headers: { 'file-path': hex('database/database.bin') },
    })
    const sessionId = 'cleanup-intersection'

    await client.fetch('/api/session', {
      method: 'POST',
      headers: { 'x-session-id': sessionId },
    })

    const write = async (key: string, data: Uint8Array) => {
      const response = await client.fetch('/api/write', {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'file-path': hex(key),
          'x-session-id': sessionId,
          'x-user-active': '1',
        },
        body: data,
      })
      expect(response.ok).toBe(true)
    }
    const read = async (key: string) => {
      const response = await client.fetch('/api/read', {
        headers: { 'file-path': hex(key) },
      })
      return Buffer.from(await response.arrayBuffer())
    }
    const makeOldRemote = async (name: string) => {
      await write(`remotes/${name}.local.bin`, new Uint8Array([1, 2, 3]))
      await write(
        `remotes/${name}.local.bin.meta`,
        new TextEncoder().encode(JSON.stringify({ lastUsed: 1 })),
      )
    }

    await makeOldRemote('a')
    await makeOldRemote('b')
    const dryResponse = await client.fetch('/api/cleanup/orphan-assets', {
      method: 'POST',
      headers: { 'x-session-id': sessionId },
    })
    expect(dryResponse.ok).toBe(true)
    const dry = await dryResponse.json() as {
      scanId: string
      expiresAt: number
      count: number
    }
    expect(dry.scanId).toEqual(expect.any(String))
    expect(dry.expiresAt).toBeGreaterThan(Date.now())
    expect(dry.count).toBe(2)

    // A is no longer stale; C became orphaned only after the reviewed scan.
    await write(
      'remotes/a.local.bin.meta',
      new TextEncoder().encode(JSON.stringify({ lastUsed: Date.now() })),
    )
    await makeOldRemote('c')

    const confirm = await client.fetch('/api/cleanup/orphan-assets?confirm=true', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-session-id': sessionId,
      },
      body: JSON.stringify({ scanId: dry.scanId }),
    })
    expect(confirm.ok).toBe(true)
    expect(await confirm.json()).toMatchObject({
      count: 1,
      requestedCount: 2,
      skippedCount: 1,
    })
    expect(await read('remotes/a.local.bin')).toHaveLength(3)
    expect(await read('remotes/b.local.bin')).toHaveLength(0)
    expect(await read('remotes/c.local.bin')).toHaveLength(3)

    const retry = await client.fetch('/api/cleanup/orphan-assets?confirm=true', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-session-id': sessionId,
      },
      body: JSON.stringify({ scanId: dry.scanId }),
    })
    expect(retry.status).toBe(409)
    expect(await read('remotes/c.local.bin')).toHaveLength(3)
  })

  test('rejects replaced and cross-session scans without deleting', async () => {
    const server = await spawnServer()
    servers.push(server)
    const client = await createClient(server.port, server.password)
    await client.importBackup(createSeedBackup({ characterCount: 0 }))
    await client.fetch('/api/read', {
      headers: { 'file-path': hex('database/database.bin') },
    })
    const sessionId = 'cleanup-scan-owner'

    await client.fetch('/api/session', {
      method: 'POST',
      headers: { 'x-session-id': sessionId },
    })
    const write = await client.fetch('/api/write', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'file-path': hex('remotes/keep.local.bin'),
        'x-session-id': sessionId,
        'x-user-active': '1',
      },
      body: new Uint8Array([9]),
    })
    expect(write.ok).toBe(true)
    await client.fetch('/api/write', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'file-path': hex('remotes/keep.local.bin.meta'),
        'x-session-id': sessionId,
        'x-user-active': '1',
      },
      body: new TextEncoder().encode(JSON.stringify({ lastUsed: 1 })),
    })

    const scan = async (sid: string) => {
      const response = await client.fetch('/api/cleanup/orphan-assets', {
        method: 'POST',
        headers: { 'x-session-id': sid, 'x-user-active': '1' },
      })
      expect(response.ok).toBe(true)
      return (await response.json() as { scanId: string }).scanId
    }
    const confirm = (scanId: string, sid: string) => client.fetch(
      '/api/cleanup/orphan-assets?confirm=true',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-session-id': sid,
          'x-user-active': '1',
        },
        body: JSON.stringify({ scanId }),
      },
    )

    const replaced = await scan(sessionId)
    const current = await scan(sessionId)
    expect((await confirm(replaced, sessionId)).status).toBe(409)

    await client.fetch('/api/session', {
      method: 'POST',
      headers: { 'x-session-id': 'cleanup-other-session' },
    })
    expect((await confirm(current, 'cleanup-other-session')).status).toBe(409)
    const read = await client.fetch('/api/read', {
      headers: { 'file-path': hex('remotes/keep.local.bin') },
    })
    expect(Buffer.from(await read.arrayBuffer())).toEqual(Buffer.from([9]))
  })
})

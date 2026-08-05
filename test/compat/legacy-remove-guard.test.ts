import { afterAll, describe, expect, test } from 'vitest'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient } from './helpers/client.js'

const servers: ServerHandle[] = []
afterAll(async () => {
  await Promise.allSettled(servers.map(server => server.cleanup()))
})

const hex = (value: string) => Buffer.from(value, 'utf-8').toString('hex')

describe('legacy GET /api/remove guard', () => {
  test('preserves assets/remotes and keeps other namespace deletion working', async () => {
    const server = await spawnServer()
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const sessionId = 'legacy-remove-guard'

    await client.fetch('/api/session', {
      method: 'POST',
      headers: { 'x-session-id': sessionId },
    })

    const write = async (key: string) => {
      const response = await client.fetch('/api/write', {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'file-path': hex(key),
          'x-session-id': sessionId,
          'x-user-active': '1',
        },
        body: new Uint8Array([1, 2, 3]),
      })
      expect(response.ok).toBe(true)
    }
    const read = async (key: string) => {
      const response = await client.fetch('/api/read', {
        headers: { 'file-path': hex(key) },
      })
      return Buffer.from(await response.arrayBuffer())
    }

    for (const key of ['assets/keep.png', 'remotes/keep.local.bin']) {
      await write(key)
      const response = await client.fetch('/api/remove', {
        headers: { 'file-path': hex(key) },
      })
      expect(response.status).toBe(409)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toMatchObject({
        code: 'DIRECT_ASSET_REMOVE_DISABLED',
      })
      expect(await read(key)).toEqual(Buffer.from([1, 2, 3]))
    }

    await write('draft/delete.bin')
    const remove = await client.fetch('/api/remove', {
      headers: { 'file-path': hex('draft/delete.bin') },
    })
    expect(remove.ok).toBe(true)
    expect(remove.headers.get('cache-control')).toBe('no-store')
    expect(await read('draft/delete.bin')).toHaveLength(0)
  })
})

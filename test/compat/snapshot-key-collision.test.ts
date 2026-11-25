/**
 * The forced snapshot taken right before a backup import must survive the
 * snapshot the plugin-storage split forces right after it. Both used to land
 * on the same 100 ms key, so the imported data replaced the pre-import copy.
 */
import { describe, test, expect, afterAll } from 'vitest'
import { cp } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'

const servers: ServerHandle[] = []
afterAll(async () => {
  await Promise.allSettled(servers.map(s => s.cleanup()))
})

describe('pre-import snapshot', () => {
  test('keeps the old library after importing a backup with plugin storage', async () => {
    const srv = await spawnServer()
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)

    // The library before: one character, no plugin storage.
    expect((await client.importBackup(createSeedBackup({ characterCount: 1 }))).ok).toBe(true)
    // A small import with plugin storage: snapshot before, split snapshot after.
    const imported = createSeedBackup({
      characterCount: 3,
      pluginCustomStorage: { 'plugin/key': 'value' },
    })
    expect((await client.importBackup(imported)).ok).toBe(true)

    const snapshots: Array<{ key: string, timestamp: number }> =
      (await (await client.fetch('/api/db/snapshots')).json()).snapshots
    expect(snapshots.length).toBeGreaterThanOrEqual(2)
    expect(new Set(snapshots.map((s) => s.key)).size).toBe(snapshots.length)

    // The oldest snapshot is the pre-import one: restoring it brings back one character.
    const oldest = [...snapshots].sort((a, b) => a.timestamp - b.timestamp)[0]
    const res = await client.fetch('/api/db/snapshots/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: oldest.key }),
    })
    expect(res.status).toBe(200)
    const chars = await (await client.fetch('/api/db/stats/characters')).json()
    expect(chars.characters).toHaveLength(1)
  })

  test('a server whose clock went back still keeps its new pre-import snapshot', async () => {
    // First run: a snapshot of a one-character library, at the real time.
    const first = await spawnServer()
    servers.push(first)
    const firstClient = await createClient(first.port, first.password)
    expect((await firstClient.importBackup(createSeedBackup({ characterCount: 1 }))).ok).toBe(true)
    expect((await firstClient.importBackup(createSeedBackup({ characterCount: 2 }))).ok).toBe(true)
    const stopped = new Promise((resolve) => first.child.once('exit', resolve))
    first.child.kill('SIGTERM')
    await stopped

    // Second run on the same save folder, one day behind, keeping one snapshot.
    const preload = fileURLToPath(new URL('./helpers/clock-behind-preload.cjs', import.meta.url))
    const second = await spawnServer({
      env: { NODE_OPTIONS: `--require ${JSON.stringify(preload)}` },
      seedSave: (saveDir) => cp(path.join(first.cwd, 'save'), saveDir, { recursive: true }),
    })
    servers.push(second)
    const client = await createClient(second.port, second.password)
    await setOneSnapshot(client)
    // The forced snapshot before this import holds the two-character library.
    expect((await client.importBackup(createSeedBackup({ characterCount: 3 }))).ok).toBe(true)
    expect(await restoreNewest(client)).toBe(2)
  })

  test('keeps the pre-import snapshot when only one snapshot is allowed', async () => {
    const srv = await spawnServer()
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)

    expect((await client.importBackup(createSeedBackup({ characterCount: 1 }))).ok).toBe(true)
    const limits = await client.fetch('/api/db/snapshots/limits', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxCount: 1, maxBytes: 500 * 1024 * 1024 }),
    })
    expect(limits.status).toBe(200)
    // The split's snapshot right after the import used to trim the pre-import one.
    const imported = createSeedBackup({
      characterCount: 3,
      pluginCustomStorage: { 'plugin/key': 'value' },
    })
    expect((await client.importBackup(imported)).ok).toBe(true)

    const snapshots: Array<{ key: string, timestamp: number }> =
      (await (await client.fetch('/api/db/snapshots')).json()).snapshots
    const oldest = [...snapshots].sort((a, b) => a.timestamp - b.timestamp)[0]
    const res = await client.fetch('/api/db/snapshots/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: oldest.key }),
    })
    expect(res.status).toBe(200)
    const chars = await (await client.fetch('/api/db/stats/characters')).json()
    expect(chars.characters).toHaveLength(1)
  })
})

async function setOneSnapshot(client: RisuClient) {
  const res = await client.fetch('/api/db/snapshots/limits', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ maxCount: 1, maxBytes: 500 * 1024 * 1024 }),
  })
  expect(res.status).toBe(200)
}

// Restores the newest snapshot and returns the character count it brought back.
async function restoreNewest(client: RisuClient) {
  const snapshots: Array<{ key: string, timestamp: number }> =
    (await (await client.fetch('/api/db/snapshots')).json()).snapshots
  const newest = [...snapshots].sort((a, b) => b.timestamp - a.timestamp)[0]
  const res = await client.fetch('/api/db/snapshots/restore', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: newest.key }),
  })
  expect(res.status).toBe(200)
  return (await (await client.fetch('/api/db/stats/characters')).json()).characters.length
}

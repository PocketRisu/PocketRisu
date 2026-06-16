/**
 * Chunking lifecycle integration tests.
 *
 * Boots a real server with a LOW chunk threshold (POCKETRISU_CHUNK_THRESHOLD)
 * so the DB blob actually chunks, then drives the full lifecycle over HTTP:
 *   import (chunks) → stats (chunk-aware) → export → re-import (round-trip) →
 *   snapshots/limits → optimize/gc, plus the save-folder import paths.
 *
 * The default compat fixtures use tiny DBs (< 16 MB) that never chunk, so this
 * is the only suite that exercises the chunked path through db.cjs + server.cjs
 * end-to-end — exactly the wiring the unit tests can't reach.
 */
import { describe, test, expect, afterAll } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { zipSync } from 'fflate'
import { Packr } from 'msgpackr'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'
import { decodeBackup } from './helpers/decode.js'

function dbBlobFromExport(exported: Buffer): Buffer {
  const entry = decodeBackup(exported).find((e) => e.name === 'database.risudat')
  if (!entry) throw new Error('export has no database.risudat')
  return entry.data
}

// Chunk anything larger than 4 KB so a normal seed DB chunks.
const CHUNK_ENV = { POCKETRISU_CHUNK_THRESHOLD: '4096' }

const servers: ServerHandle[] = []
afterAll(async () => { await Promise.allSettled(servers.map((s) => s.cleanup())) })

async function boot(extraEnv: Record<string, string> = {}): Promise<{ client: RisuClient; srv: ServerHandle }> {
  const srv = await spawnServer({ env: { ...CHUNK_ENV, ...extraEnv } })
  servers.push(srv)
  const client = await createClient(srv.port, srv.password)
  return { client, srv }
}

// A .bin backup whose DB comfortably exceeds the 4 KB threshold and spans
// several CDC chunks (avg ~16 KB, max 64 KB).
function oversizedSeed(): Buffer {
  return createSeedBackup({ characterCount: 5, chatsPerCharacter: 2, messagesPerChat: 1000 })
}

// Raw database.risudat blob (~400 KB) — used by the save-folder import paths,
// which feed hex-named files rather than a .bin backup.
const MAGIC_RAW = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])
const packr = new Packr({ useRecords: false })
// salt makes two blobs differ so a snapshot of one has chunks the other lacks.
function bigDbBlob(salt = ''): Buffer {
  const characters = Array.from({ length: 5 }, (_, ci) => ({
    name: `Char${ci}`, chaId: `c${ci}`, type: 'character', chatPage: 0, image: '', desc: 'x', firstMessage: 'hi',
    chats: [{
      id: `chat${ci}`, name: 'c', lastDate: 0, localLore: [], scriptstate: {}, note: '',
      message: Array.from({ length: 2000 }, (_, mi) => ({ role: mi % 2 ? 'char' : 'user', data: `msg ${mi} of char ${ci} ${salt} ${'x'.repeat(20)}` })),
    }],
  }))
  const database = { characters, apiType: 'openai', personas: [{ name: 'D', icon: '', personaPrompt: '' }], botPresets: [], botPresetsId: 0, selectedCharacter: 0 }
  return Buffer.concat([MAGIC_RAW, packr.encode(database)])
}
const DB_BLOB_HEX = Buffer.from('database/database.bin', 'utf-8').toString('hex')
function saveFolderZip(blob: Buffer): Buffer {
  return Buffer.from(zipSync({ [DB_BLOB_HEX]: new Uint8Array(blob) }))
}
async function uploadZip(client: RisuClient, blob: Buffer): Promise<Response> {
  return client.fetch('/api/migrate/save-folder/upload', {
    method: 'POST',
    headers: { 'content-type': 'application/zip' },
    body: new Uint8Array(saveFolderZip(blob)),
  })
}

async function getStats(client: RisuClient): Promise<any> {
  const res = await client.fetch('/api/db/stats')
  expect(res.status).toBe(200)
  return res.json()
}

describe('chunking lifecycle (real server, low threshold)', () => {
  test('importing an oversized DB chunks the blob through the real server', async () => {
    const { client } = await boot()
    const r = await client.importBackup(oversizedSeed())
    expect(r.ok).toBe(true)

    const s = await getStats(client)
    expect(s.chunks.liveChunked).toBe(true)
    expect(s.chunks.count).toBeGreaterThan(1)
    expect(s.chunks.bytes).toBeGreaterThan(0)
  })

  test('chunked DB exports to standard .bin and round-trips into a fresh server', async () => {
    const { client } = await boot()
    await client.importBackup(oversizedSeed())

    const exported = await client.exportBackup()
    expect(exported.byteLength).toBeGreaterThan(4096)

    const { client: client2 } = await boot()
    const r2 = await client2.importBackup(exported)
    expect(r2.ok).toBe(true)

    const s2 = await getStats(client2)
    expect(s2.chunks.liveChunked).toBe(true)
    const charRes = await client2.fetch('/api/db/stats/characters')
    expect(charRes.status).toBe(200)
    const chars = await charRes.json()
    expect(chars.characters.length).toBeGreaterThanOrEqual(5)
  })

  test('a chunked snapshot reports a real footprint, not the 13-byte marker', async () => {
    // No backup cooldown so the 2nd import snapshots the 1st (chunked) DB.
    const { client } = await boot({ POCKETRISU_BACKUP_INTERVAL_MS: '0' })
    expect((await uploadZip(client, bigDbBlob('AAA'))).status).toBe(200) // v1 chunked
    expect((await uploadZip(client, bigDbBlob('BBB'))).status).toBe(200) // snapshots v1, then v2

    const snaps = await (await client.fetch('/api/db/snapshots')).json()
    // The vacuous-pass guard: there must actually be a snapshot to check.
    expect(snaps.snapshots.length).toBeGreaterThan(0)
    for (const sn of snaps.snapshots) {
      expect(sn.size).not.toBe(13) // 13 = CHUNK_MARKER length (the old bug)
    }
    // The chunked snapshot of v1 differs from live v2, so its footprint is real.
    const maxSize = Math.max(...snaps.snapshots.map((s: any) => s.size))
    expect(maxSize).toBeGreaterThan(1000)

    const lim = await (await client.fetch('/api/db/snapshots/limits')).json()
    expect(lim.currentBytes).toBeGreaterThan(1000)
  })

  test('optimize runs gc and reports chunksReclaimed', async () => {
    const { client } = await boot()
    await client.importBackup(oversizedSeed())

    const res = await client.fetch('/api/db/optimize', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(typeof body.chunksReclaimed).toBe('number')
  })

  // The two save-folder import paths were where the raw-bind regressions hid.
  test('save-folder ZIP upload chunks an oversized DB blob (importHexEntries)', async () => {
    const { client } = await boot()
    const res = await uploadZip(client, bigDbBlob())
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)

    const s = await getStats(client)
    expect(s.chunks.liveChunked).toBe(true)
    expect(s.chunks.count).toBeGreaterThan(1)
  })

  test('save-folder directory import chunks an oversized DB blob (importHexFilesFromDir)', async () => {
    const { client, srv } = await boot()
    const dir = path.join(srv.cwd, 'migrate-src')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, DB_BLOB_HEX), bigDbBlob())

    const res = await client.fetch('/api/migrate/save-folder/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: dir }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)

    const s = await getStats(client)
    expect(s.chunks.liveChunked).toBe(true)
    expect(s.chunks.count).toBeGreaterThan(1)
  })

  test('restoring a chunked snapshot brings its data back (recovery path)', async () => {
    const { client } = await boot({ POCKETRISU_BACKUP_INTERVAL_MS: '0' })
    await uploadZip(client, bigDbBlob('AAA')) // v1
    await uploadZip(client, bigDbBlob('BBB')) // snapshots v1 (chunked), live = v2

    // Sanity: live is currently v2, not v1.
    expect(dbBlobFromExport(await client.exportBackup()).includes(Buffer.from('BBB'))).toBe(true)

    const snaps = (await (await client.fetch('/api/db/snapshots')).json()).snapshots
    expect(snaps.length).toBeGreaterThan(0)
    const res = await client.fetch('/api/db/snapshots/restore', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: snaps[0].key }), // newest = the v1 snapshot
    })
    expect(res.status).toBe(200)

    // Live is now v1 again, still chunked and valid.
    const restored = dbBlobFromExport(await client.exportBackup())
    expect(restored.includes(Buffer.from('AAA'))).toBe(true)
    expect((await getStats(client)).chunks.liveChunked).toBe(true)
  })

  test('optimize reclaims orphan chunks left by re-imports', async () => {
    const { client } = await boot() // default cooldown → 2nd import takes no snapshot
    await uploadZip(client, bigDbBlob('AAA')) // v1 chunked
    await uploadZip(client, bigDbBlob('BBB')) // v2 chunked; v1's chunks now unreferenced

    const before = await getStats(client)
    expect(before.chunks.orphanBytes).toBeGreaterThan(0)

    const opt = await (await client.fetch('/api/db/optimize', { method: 'POST' })).json()
    expect(opt.ok).toBe(true)
    expect(opt.chunksReclaimed).toBeGreaterThan(0)

    const after = await getStats(client)
    expect(after.chunks.orphanBytes).toBeLessThan(before.chunks.orphanBytes)
  })

  test('pre-SQLite hex save folder migrates and chunks the DB blob (migrateFromSaveDir)', async () => {
    // Plant an old file-based save folder (hex-named files, no SQLite marker)
    // with an oversized database.bin before the server boots.
    const srv = await spawnServer({
      env: CHUNK_ENV,
      seedSave: async (saveDir) => {
        await writeFile(path.join(saveDir, DB_BLOB_HEX), bigDbBlob('HEX'))
      },
    })
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)

    // Boot ran migrateFromSaveDir → the blob is now in SQLite, chunked.
    const s = await getStats(client)
    expect(s.chunks.liveChunked).toBe(true)
    expect(s.chunks.count).toBeGreaterThan(1)
    // And the migrated data is intact (exports the seeded content back out).
    expect(dbBlobFromExport(await client.exportBackup()).includes(Buffer.from('HEX'))).toBe(true)
  })

  test('downgrade escape: a chunked DB exports a standard blob a non-chunking server reads', async () => {
    const { client } = await boot()
    await uploadZip(client, bigDbBlob('XYZ'))
    expect((await getStats(client)).chunks.liveChunked).toBe(true)

    // The export is the full reassembled DB (not a 13-byte marker) — readable by
    // any version, including one with no chunking at all.
    const blob = dbBlobFromExport(await client.exportBackup())
    expect(blob.length).toBeGreaterThan(4096)
    expect(blob.includes(Buffer.from('XYZ'))).toBe(true)

    // Simulate an "old" server (chunking effectively off via a huge threshold):
    // it must import and store the blob raw.
    const exported = await client.exportBackup()
    const { client: oldish } = await boot({ POCKETRISU_CHUNK_THRESHOLD: '9999999999' })
    expect((await oldish.importBackup(exported)).ok).toBe(true)
    const s2 = await getStats(oldish)
    expect(s2.chunks.liveChunked).toBe(false) // stored raw, like a pre-chunking server
  })
})

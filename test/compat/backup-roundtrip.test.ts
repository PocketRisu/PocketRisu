/**
 * Backup round-trip integration tests.
 *
 * Flow:  seed → import → export → import(new server) → export → compare
 *
 * These tests spin up real server instances in temp directories, so they
 * exercise the actual backup/import code paths including SQLite, KV layer,
 * and binary encoding.
 */
import { describe, test, expect, afterAll } from 'vitest'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'
import { normalizeBackup, fingerprintAssets } from './helpers/normalize.js'
import { encodeBackup } from './helpers/encode.js'
import { decodeBackup } from './helpers/decode.js'

// Track servers so we can clean them all up even if a test fails.
const servers: ServerHandle[] = []
afterAll(async () => {
  await Promise.allSettled(servers.map(s => s.cleanup()))
})

// ─── Smoke ──────────────────────────────────────────────────────────────────

describe('server smoke', () => {
  test('starts and responds to login', async () => {
    const srv = await spawnServer()
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)
    expect(client.token).toBeTruthy()
  })

  test('backup path config rejects app-managed dirs and records safe custom dirs', async () => {
    const srv = await spawnServer()
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)

    const pathInfoRes = await client.fetch('/api/backup/server/path')
    expect(pathInfoRes.status).toBe(200)
    const pathInfo = await pathInfoRes.json() as { default: string }
    const serverRoot = path.dirname(pathInfo.default)

    const managedPath = path.join(serverRoot, 'server', 'backups')
    const managedRes = await client.fetch('/api/backup/server/path', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: managedPath }),
    })
    expect(managedRes.status).toBe(400)
    const managedBody = await managedRes.json() as { error?: string }
    expect(managedBody.error).toContain('PocketRisu app files')

    const safePath = path.join(serverRoot, 'data', 'backups')
    const safeRes = await client.fetch('/api/backup/server/path', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: safePath }),
    })
    expect(safeRes.status).toBe(200)
    const safeBody = await safeRes.json() as { path: string; isDefault: boolean }
    expect(safeBody.path).toBe(safePath)
    expect(safeBody.isDefault).toBe(false)

    const marker = await readFile(path.join(srv.cwd, 'save', '__backup_path'), 'utf-8')
    expect(marker.trim()).toBe(safePath)
  })
})

// ─── Round-trip ─────────────────────────────────────────────────────────────

describe('backup round-trip', () => {
  test('round-trip preserves core database', async () => {
    // 1. Server A: import seed, export
    const srvA = await spawnServer()
    servers.push(srvA)
    const clientA = await createClient(srvA.port, srvA.password)

    const seed = createSeedBackup({ characterCount: 2, chatsPerCharacter: 2, messagesPerChat: 3 })
    const importResult = await clientA.importBackup(seed)
    expect(importResult.ok).toBe(true)

    const exportA = await clientA.exportBackup()
    expect(exportA.length).toBeGreaterThan(0)

    // 2. Server B: import A's export, re-export
    const srvB = await spawnServer()
    servers.push(srvB)
    const clientB = await createClient(srvB.port, srvB.password)

    const importB = await clientB.importBackup(exportA)
    expect(importB.ok).toBe(true)

    const exportB = await clientB.exportBackup()

    // 3. Compare normalized databases
    const normA = normalizeBackup(exportA)
    const normB = normalizeBackup(exportB)

    expect(normB.normalized.characterCount).toBe(normA.normalized.characterCount)
    expect(normB.normalized.characters).toEqual(normA.normalized.characters)
    expect(normB.normalized.personaCount).toBe(normA.normalized.personaCount)
    // Setting keys may gain defaults from the server, but seed keys must survive
    for (const key of normA.normalized.settingKeys) {
      expect(normB.normalized.settingKeys).toContain(key)
    }
    // Message content spot-check
    for (let i = 0; i < normA.normalized.characters.length; i++) {
      expect(normB.normalized.characters[i].firstMessages)
        .toEqual(normA.normalized.characters[i].firstMessages)
    }
  })

  test('round-trip with multiple characters preserves message counts', async () => {
    const srv = await spawnServer()
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)

    const seed = createSeedBackup({ characterCount: 3, chatsPerCharacter: 3, messagesPerChat: 5 })
    await client.importBackup(seed)
    const exported = await client.exportBackup()

    const { normalized } = normalizeBackup(exported)
    expect(normalized.characterCount).toBe(3)
    for (const char of normalized.characters) {
      expect(char.chatCount).toBe(3)
      for (const count of char.messageCounts) {
        expect(count).toBe(5)
      }
    }
  })
})

// ─── Asset round-trip ──────────────────────────────────────────────────────

describe('asset round-trip', () => {
  test('asset count and payload survive import and re-export', async () => {
    const srv = await spawnServer()
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)

    const seed = createSeedBackup({ characterCount: 2, includeAssets: true })
    const beforeFingerprints = fingerprintAssets(seed)
    expect(beforeFingerprints.length).toBe(2)

    await client.importBackup(seed)
    const exported = await client.exportBackup()
    const afterFingerprints = fingerprintAssets(exported)

    // Both count and content (sha256) must match
    expect(afterFingerprints).toEqual(beforeFingerprints)
  })
})

// ─── Upstream-compatible export ────────────────────────────────────────────

describe('upstream-compatible backup export', () => {
  test('excludes NodeOnly-only inlay namespaces while regular export preserves them', async () => {
    const srv = await spawnServer()
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)

    const seed = Buffer.concat([
      createSeedBackup({ characterCount: 1 }),
      encodeBackup([
        { name: 'inlay/test-inlay.png', data: Buffer.from('fake-inlay-image') },
        {
          name: 'inlay_sidecar/test-inlay',
          data: Buffer.from(JSON.stringify({
            ext: 'png',
            name: 'test-inlay.png',
            type: 'image',
          })),
        },
        {
          name: 'inlay_meta/test-inlay',
          data: Buffer.from(JSON.stringify({
            createdAt: 1,
            updatedAt: 2,
            charId: 'test-char-0',
            chatId: 'chat-0-0',
          })),
        },
      ]),
    ])

    const importResult = await client.importBackup(seed)
    expect(importResult.ok).toBe(true)

    const regularNames = decodeBackup(await client.exportBackup()).map(e => e.name)
    expect(regularNames).toEqual(expect.arrayContaining([
      'database.risudat',
      'inlay/test-inlay.png',
      'inlay_sidecar/test-inlay',
      'inlay_meta/test-inlay',
    ]))

    const upstreamRes = await client.fetch('/api/backup/export?target=upstream')
    expect(upstreamRes.ok).toBe(true)
    expect(upstreamRes.headers.get('content-disposition')).toContain('-upstream.bin')

    const upstreamBackup = Buffer.from(await upstreamRes.arrayBuffer())
    const upstreamNames = decodeBackup(upstreamBackup).map(e => e.name)

    expect(upstreamNames).toContain('database.risudat')
    expect(upstreamNames.some(name => name.startsWith('inlay/'))).toBe(false)
    expect(upstreamNames.some(name => name.startsWith('inlay_sidecar/'))).toBe(false)
    expect(upstreamNames.some(name => name.startsWith('inlay_meta/'))).toBe(false)

    const regularDb = normalizeBackup(await client.exportBackup()).normalized
    const upstreamDb = normalizeBackup(upstreamBackup).normalized
    expect(upstreamDb).toEqual(regularDb)
  })
})

// ─── Content-type compatibility ────────────────────────────────────────────

describe('content-type compatibility', () => {
  test('import works with application/octet-stream', async () => {
    const srv = await spawnServer()
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)

    const seed = createSeedBackup({ characterCount: 1 })
    const before = normalizeBackup(seed)

    // Bypass the normal importBackup (which uses x-risu-backup) and
    // send with octet-stream directly to verify the fix.
    const prepRes = await client.fetch('/api/backup/import/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ size: seed.byteLength }),
    })
    expect(prepRes.ok).toBe(true)

    const impRes = await client.fetch('/api/backup/import', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(seed),
    })
    const result = await impRes.json() as { ok: boolean }
    expect(result.ok).toBe(true)

    const exported = await client.exportBackup()
    const after = normalizeBackup(exported)
    expect(after.normalized.characterCount).toBe(before.normalized.characterCount)
    expect(after.normalized.characters).toEqual(before.normalized.characters)
  })
})

// ─── NDJSON streaming response ──────────────────────────────────────────────
//
// The NDJSON import path was added to keep the response socket alive during
// long post-upload work (WAL checkpoint, cold-storage migration, etc.) so a
// reverse proxy in front of the Node server doesn't time out and bounce a 502
// back to the client. Backup import is one of the most destructive operations
// in the app — a silent failure or partial import would wipe user data — so
// these tests guard the contract end-to-end:
//
//   T1  database content survives the NDJSON path identically
//   T2  asset bytes survive the NDJSON path identically
//   T3  cold-storage migration (runs in the silent post-upload phase) succeeds
//   T4  a malformed backup ends in an `error` event with prior data intact
//       (the worst case here is `done.ok=true` arriving on a botched import)
//   T5  `progress` events fire with monotonically increasing bytes
//   T6  heartbeats actually fire during processing (proves the keepalive
//       mechanism — without it the fix degrades to a silent 502 again)

type NdjsonEvent =
  | { type: 'progress'; bytes: number; totalBytes: number }
  | { type: 'heartbeat' }
  | { type: 'done'; ok: boolean; assetsRestored?: number; coldStorageFailed?: number }
  | { type: 'error'; message: string; code?: string }

interface NdjsonImportResult {
  response: Response
  events: NdjsonEvent[]
  done?: Extract<NdjsonEvent, { type: 'done' }>
  errors: Array<Extract<NdjsonEvent, { type: 'error' }>>
  progresses: Array<Extract<NdjsonEvent, { type: 'progress' }>>
  heartbeats: Array<Extract<NdjsonEvent, { type: 'heartbeat' }>>
}

async function importViaNdjson(
  client: { fetch: (path: string, init?: RequestInit) => Promise<Response> },
  seed: Buffer,
): Promise<NdjsonImportResult> {
  const prepRes = await client.fetch('/api/backup/import/prepare', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ size: seed.byteLength }),
  })
  if (!prepRes.ok) throw new Error(`prepare failed: ${prepRes.status} ${await prepRes.text()}`)

  const response = await client.fetch('/api/backup/import', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-risu-backup',
      'accept': 'application/x-ndjson',
    },
    body: new Uint8Array(seed),
  })
  const text = await response.text()
  const events: NdjsonEvent[] = text
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as NdjsonEvent)

  return {
    response,
    events,
    done: events.find((e): e is Extract<NdjsonEvent, { type: 'done' }> => e.type === 'done'),
    errors: events.filter((e): e is Extract<NdjsonEvent, { type: 'error' }> => e.type === 'error'),
    progresses: events.filter((e): e is Extract<NdjsonEvent, { type: 'progress' }> => e.type === 'progress'),
    heartbeats: events.filter((e): e is Extract<NdjsonEvent, { type: 'heartbeat' }> => e.type === 'heartbeat'),
  }
}

describe('ndjson streaming import', () => {
  // T1 — DB content must come through unchanged via the NDJSON path. A
  // regression that bypassed importBackupFromSource (or short-circuited it)
  // would be the worst-case silent corruption; we compare normalized output
  // to a baseline produced by the existing non-NDJSON path on a peer server.
  test('T1: round-trip database matches non-NDJSON path byte-for-byte (normalized)', async () => {
    const seed = createSeedBackup({ characterCount: 3, chatsPerCharacter: 2, messagesPerChat: 4 })

    const srvBaseline = await spawnServer()
    servers.push(srvBaseline)
    const clientBaseline = await createClient(srvBaseline.port, srvBaseline.password)
    await clientBaseline.importBackup(seed)
    const baselineExport = await clientBaseline.exportBackup()

    const srvNdjson = await spawnServer()
    servers.push(srvNdjson)
    const clientNdjson = await createClient(srvNdjson.port, srvNdjson.password)
    const ndjson = await importViaNdjson(clientNdjson, seed)
    expect(ndjson.response.ok).toBe(true)
    expect(ndjson.done?.ok).toBe(true)
    const ndjsonExport = await clientNdjson.exportBackup()

    const baseline = normalizeBackup(baselineExport)
    const fromNdjson = normalizeBackup(ndjsonExport)
    expect(fromNdjson.normalized.characterCount).toBe(baseline.normalized.characterCount)
    expect(fromNdjson.normalized.characters).toEqual(baseline.normalized.characters)
    expect(fromNdjson.normalized.personaCount).toBe(baseline.normalized.personaCount)
  })

  // T2 — asset bytes are written via a different code path than the DB
  // (kv writes vs sqlite restore). Fingerprint compare guards against any
  // off-by-one truncation or accidental skipping when streaming the body.
  test('T2: assets survive the NDJSON path with identical fingerprints', async () => {
    const seed = createSeedBackup({ characterCount: 2, includeAssets: true })
    const seedFingerprints = fingerprintAssets(seed)
    expect(seedFingerprints.length).toBe(2)

    const srv = await spawnServer()
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)

    const ndjson = await importViaNdjson(client, seed)
    expect(ndjson.done?.ok).toBe(true)
    expect(ndjson.errors).toEqual([])

    const exported = await client.exportBackup()
    expect(fingerprintAssets(exported)).toEqual(seedFingerprints)
  })

  // T3 — cold-storage migration runs *after* the body finishes streaming,
  // which is exactly the silent phase the heartbeat is meant to cover. We
  // assert both that the migration succeeded (coldStorageFailed=0) and that
  // the restored character is present in the re-export.
  test('T3: cold-storage character is restored when imported via NDJSON', async () => {
    const fullCharData = {
      character: {
        name: 'NdjsonColdChar',
        chaId: 'cold-char-ndjson-key',
        image: '', type: 'character',
        desc: 'Imported via NDJSON',
        firstMessage: 'Hello from NDJSON path!',
        chats: [{
          message: [{ role: 'char', data: 'Hello from NDJSON path!' }],
          note: '', name: 'Chat 1', localLore: [],
        }],
        chatPage: 0, firstMsgIndex: -1,
        notes: '', emotionImages: [], bias: [], globalLore: [],
        viewScreen: 'none', sdData: [], utilityBot: false,
        customscript: [], triggerscript: [],
        exampleMessage: '', creatorNotes: '', systemPrompt: '',
        postHistoryInstructions: '', alternateGreetings: [],
        tags: [], creator: '', characterVersion: '',
        personality: '', scenario: '', replaceGlobalNote: '',
        additionalText: '', chatFolders: [],
      },
    }

    const seed = createSeedBackup({
      characterCount: 1,
      coldStorageCharacters: [
        { name: 'NdjsonColdChar', coldKey: 'ndjson-key', fullData: fullCharData },
      ],
    })

    const srv = await spawnServer()
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)

    const ndjson = await importViaNdjson(client, seed)
    expect(ndjson.done?.ok).toBe(true)
    expect(ndjson.done?.coldStorageFailed ?? 0).toBe(0)

    const { normalized } = normalizeBackup(await client.exportBackup())
    const restored = normalized.characters.find(c => c.chaId === 'cold-char-ndjson-key')
    expect(restored).toBeDefined()
    expect(restored!.name).toBe('NdjsonColdChar')
    expect(restored!.firstMessages[0]).toBe('Hello from NDJSON path!')
  })

  // T4 — silent failure is the worst-case bug. If a malformed backup got
  // anywhere near a `done.ok=true` event the UI would tell the user that
  // their import succeeded while their existing data was actually wiped.
  // The NDJSON path must surface an `error` event AND leave prior data intact.
  test('T4: malformed backup emits error event, no done, prior data intact', async () => {
    const srv = await spawnServer()
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)

    const goodSeed = createSeedBackup({ characterCount: 1 })
    await client.importBackup(goodSeed)
    const beforeExport = await client.exportBackup()
    const before = normalizeBackup(beforeExport)

    const badBackup = encodeBackup([
      { name: 'some-random-asset.png', data: Buffer.from('not-a-real-png') },
    ])

    const ndjson = await importViaNdjson(client, badBackup)
    expect(ndjson.errors.length).toBeGreaterThanOrEqual(1)
    expect(ndjson.done).toBeUndefined()

    const afterExport = await client.exportBackup()
    const after = normalizeBackup(afterExport)
    expect(after.normalized.characterCount).toBe(before.normalized.characterCount)
    expect(after.normalized.characters).toEqual(before.normalized.characters)
  })

  // T5 — progress events are the contract the UI relies on to drive its
  // upload progress bar. If a refactor accidentally drops the onProgress
  // callback or rewires it to fire only once, the UI silently regresses.
  test('T5: emits at least one progress event with monotonically increasing bytes', async () => {
    const seed = createSeedBackup({ characterCount: 5, chatsPerCharacter: 3, messagesPerChat: 6, includeAssets: true })

    const srv = await spawnServer()
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)

    const ndjson = await importViaNdjson(client, seed)
    expect(ndjson.done?.ok).toBe(true)
    expect(ndjson.progresses.length).toBeGreaterThanOrEqual(1)

    let last = -1
    for (const p of ndjson.progresses) {
      expect(p.bytes).toBeGreaterThanOrEqual(last)
      expect(p.totalBytes).toBe(seed.byteLength)
      last = p.bytes
    }
    expect(last).toBeLessThanOrEqual(seed.byteLength)
  })

  // T6 — this is *the* reason the patch exists. If a future change drops
  // the setInterval call, every data test above keeps passing (small fixtures
  // finish before one heartbeat tick) but the production 502 would come back.
  //
  // Two things have to line up to observe a heartbeat at all:
  //   1. The heartbeat interval has to be short. We pin it to the floor
  //      (100 ms) via env override.
  //   2. The server has to spend more than one interval on the request, AND
  //      yield to the event loop while doing so (setInterval can't fire while
  //      JS is in a sync block). With a single-chunk Uint8Array body the
  //      whole import collapses into one for-await tick. So we stream the
  //      body in pieces with deliberate 60 ms gaps to force several yields.
  test('T6: heartbeats fire during processing when interval is tight', async () => {
    const srv = await spawnServer({ env: { BACKUP_NDJSON_HEARTBEAT_MS: '100' } })
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)

    const seed = createSeedBackup({ characterCount: 2, includeAssets: true })

    const prepRes = await client.fetch('/api/backup/import/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ size: seed.byteLength }),
    })
    expect(prepRes.ok).toBe(true)

    const chunkSize = Math.max(1, Math.ceil(seed.byteLength / 5))
    let offset = 0
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (offset >= seed.byteLength) { controller.close(); return }
        const end = Math.min(offset + chunkSize, seed.byteLength)
        const chunk = new Uint8Array(seed.subarray(offset, end))
        offset = end
        if (offset < seed.byteLength) await new Promise(r => setTimeout(r, 60))
        controller.enqueue(chunk)
      },
    })

    const response = await client.fetch('/api/backup/import', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-risu-backup',
        'accept': 'application/x-ndjson',
        'content-length': String(seed.byteLength),
      },
      body: body as unknown as BodyInit,
      // Node's fetch requires this flag for streaming request bodies.
      duplex: 'half',
    } as RequestInit & { duplex: 'half' })

    const text = await response.text()
    const events: NdjsonEvent[] = text
      .split('\n')
      .filter(line => line.length > 0)
      .map(line => JSON.parse(line) as NdjsonEvent)
    const done = events.find((e): e is Extract<NdjsonEvent, { type: 'done' }> => e.type === 'done')
    const heartbeats = events.filter(e => e.type === 'heartbeat')

    expect(done?.ok).toBe(true)
    expect(heartbeats.length).toBeGreaterThanOrEqual(1)
  })

  // Backwards-compat sanity: a client that doesn't advertise NDJSON must
  // still get the legacy JSON response. The non-NDJSON branch is what every
  // integration helper in this file already exercises, but an explicit
  // negative test makes the contract surface visible.
  test('legacy clients without Accept header receive JSON, not NDJSON', async () => {
    const srv = await spawnServer()
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)

    const seed = createSeedBackup({ characterCount: 1 })

    const prepRes = await client.fetch('/api/backup/import/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ size: seed.byteLength }),
    })
    expect(prepRes.ok).toBe(true)

    const impRes = await client.fetch('/api/backup/import', {
      method: 'POST',
      headers: { 'content-type': 'application/x-risu-backup' },
      body: new Uint8Array(seed),
    })
    expect(impRes.headers.get('content-type')).toContain('application/json')
    const body = await impRes.json() as { ok: boolean }
    expect(body.ok).toBe(true)
  })
})

// ─── Malformed import safety ────────────────────────────────────────────────

describe('malformed import safety', () => {
  test('import rejects backup missing database.risudat without wiping existing data', async () => {
    const srv = await spawnServer()
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)

    // Seed valid data first
    const seed = createSeedBackup({ characterCount: 1 })
    await client.importBackup(seed)
    const beforeExport = await client.exportBackup()
    const before = normalizeBackup(beforeExport)

    // Try importing a backup with no database.risudat
    const badBackup = encodeBackup([
      { name: 'some-random-asset.png', data: Buffer.from('not-a-real-png') },
    ])

    // The server should reject this (importBackupFromSource validates database presence)
    const res = await client.fetch('/api/backup/import', {
      method: 'POST',
      headers: { 'content-type': 'application/x-risu-backup' },
      body: new Uint8Array(badBackup),
    })
    // Expect a non-2xx or an error in the JSON response
    const body = await res.json().catch(() => ({ error: res.statusText })) as Record<string, unknown>
    const rejected = !res.ok || body.error || !body.ok
    expect(rejected).toBe(true)

    // Verify original data is still intact
    const afterExport = await client.exportBackup()
    const after = normalizeBackup(afterExport)
    expect(after.normalized.characterCount).toBe(before.normalized.characterCount)
    expect(after.normalized.characters).toEqual(before.normalized.characters)
  })

  test('import rejects truncated backup', async () => {
    const srv = await spawnServer()
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)

    // Seed valid data
    const seed = createSeedBackup()
    await client.importBackup(seed)

    // Create a truncated backup (cut a valid backup in half)
    const validBackup = createSeedBackup({ characterCount: 2 })
    const truncated = validBackup.subarray(0, Math.floor(validBackup.length / 2))

    const res = await client.fetch('/api/backup/import', {
      method: 'POST',
      headers: { 'content-type': 'application/x-risu-backup' },
      body: new Uint8Array(truncated),
    })
    const body = await res.json().catch(() => ({})) as Record<string, unknown>
    const rejected = !res.ok || body.error || !body.ok
    expect(rejected).toBe(true)

    // Original data should survive
    const afterExport = await client.exportBackup()
    const after = normalizeBackup(afterExport)
    expect(after.normalized.characterCount).toBe(1)
  })
})

// ─── Unreadable database payloads ───────────────────────────────────────────
// v1.11.2 field report: upstream RisuAI web-account backups carry an
// `encryption.risudat` marker and an AES-GCM encrypted database.risudat. The
// import stored the ciphertext as database.bin and only then tried to decode
// it, so every following boot failed in /api/read with HTTP 500 ("invalid
// distance" / "invalid length/literal" from fflate) — infinite loading.

async function readDatabaseStatus(
  client: { fetch: (path: string, init?: RequestInit) => Promise<Response> },
): Promise<number> {
  const res = await client.fetch('/api/read', {
    headers: { 'file-path': Buffer.from('database/database.bin', 'utf-8').toString('hex') },
  })
  return res.status
}

// Deterministic "ciphertext": no RisuSave magic header, not valid deflate.
function pseudoRandomBytes(length: number, seed = 0x9e3779b9): Buffer {
  const out = Buffer.alloc(length)
  let x = seed >>> 0
  for (let i = 0; i < length; i++) {
    x ^= x << 13; x >>>= 0
    x ^= x >>> 17
    x ^= x << 5; x >>>= 0
    out[i] = x & 0xff
  }
  return out
}

describe('unreadable database payloads', () => {
  test('encrypted upstream account backup is rejected with BACKUP_ENCRYPTED, prior data intact, server still serves', async () => {
    const srv = await spawnServer()
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)

    await client.importBackup(createSeedBackup({ characterCount: 1 }))
    const before = normalizeBackup(await client.exportBackup())

    // Same entry order upstream writes: assets, marker, then the database.
    const encrypted = encodeBackup([
      { name: 'some-asset.png', data: Buffer.from('not-a-real-png') },
      { name: 'encryption.risudat', data: Buffer.from(JSON.stringify({ time: 1700000000000, type: 'account' })) },
      { name: 'database.risudat', data: pseudoRandomBytes(4096) },
    ])

    const ndjson = await importViaNdjson(client, encrypted)
    expect(ndjson.done).toBeUndefined()
    expect(ndjson.errors.length).toBeGreaterThanOrEqual(1)
    expect(ndjson.errors[0].code).toBe('BACKUP_ENCRYPTED')

    expect(await readDatabaseStatus(client)).toBe(200)
    const after = normalizeBackup(await client.exportBackup())
    expect(after.normalized.characters).toEqual(before.normalized.characters)
  })

  test('undecodable database.risudat without a marker is rejected before it replaces the live database', async () => {
    const srv = await spawnServer()
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)

    await client.importBackup(createSeedBackup({ characterCount: 1 }))
    const before = normalizeBackup(await client.exportBackup())

    const garbage = encodeBackup([
      { name: 'database.risudat', data: pseudoRandomBytes(4096, 0x1234567) },
    ])

    const ndjson = await importViaNdjson(client, garbage)
    expect(ndjson.done).toBeUndefined()
    expect(ndjson.errors.length).toBeGreaterThanOrEqual(1)
    expect(ndjson.errors[0].code).toBe('BACKUP_DATABASE_UNREADABLE')

    expect(await readDatabaseStatus(client)).toBe(200)
    const after = normalizeBackup(await client.exportBackup())
    expect(after.normalized.characters).toEqual(before.normalized.characters)
  })

  test('fresh install survives an unreadable backup (the reported first-boot brick)', async () => {
    const srv = await spawnServer()
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)

    const encrypted = encodeBackup([
      { name: 'encryption.risudat', data: Buffer.from(JSON.stringify({ time: 1700000000000, type: 'account' })) },
      { name: 'database.risudat', data: pseudoRandomBytes(4096, 0xabcdef) },
    ])
    const ndjson = await importViaNdjson(client, encrypted)
    expect(ndjson.done).toBeUndefined()
    expect(ndjson.errors[0]?.code).toBe('BACKUP_ENCRYPTED')

    // Before the fix this was HTTP 500 on every subsequent load.
    expect(await readDatabaseStatus(client)).toBe(200)

    // And a proper backup still imports afterwards.
    const res = await client.importBackup(createSeedBackup({ characterCount: 1 }))
    expect(res.ok).toBe(true)
    expect(normalizeBackup(await client.exportBackup()).normalized.characterCount).toBe(1)
  })
})

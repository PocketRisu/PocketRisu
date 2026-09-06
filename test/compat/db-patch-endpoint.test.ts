/**
 * /api/patch integration tests against a real server.
 *
 * The unit tests for patch-hash-cache and patch-selective-clone exercise the
 * helpers in isolation; this file drives the actual endpoint so the helpers,
 * the hash protocol and persistence are verified together.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'

const utils = require('../../server/node/utils.cjs') as typeof import('../../server/node/utils.cjs')

const DB_KEY_HEX = Buffer.from('database/database.bin').toString('hex')

let srv: ServerHandle
let client: RisuClient

beforeAll(async () => {
  srv = await spawnServer()
  client = await createClient(srv.port, srv.password)
  const imported = await client.importBackup(createSeedBackup({ characterCount: 2 }))
  expect(imported.ok).toBe(true)
})
afterAll(async () => { await srv?.cleanup() })

async function readDb() {
  const res = await client.fetch('/api/read', { headers: { 'file-path': DB_KEY_HEX } })
  expect(res.status).toBe(200)
  const db = utils.normalizeJSON(await utils.decodeRisuSave(Buffer.from(await res.arrayBuffer()))) as any
  return { db, etag: res.headers.get('x-db-etag'), hash: utils.calculateHash(db).toString(16) }
}

function sendPatch(patch: unknown[], expectedHash: string) {
  return client.fetch('/api/patch', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'file-path': DB_KEY_HEX },
    body: JSON.stringify({ patch, expectedHash }),
  })
}

describe('/api/patch endpoint', () => {
  test('applies a nested op, persists it, and rejects a stale hash afterwards', async () => {
    const before = await readDb()
    const res = await sendPatch([{ op: 'replace', path: '/characters/0/name', value: 'patched' }], before.hash)
    expect(res.status).toBe(200)
    const body = await res.json() as { success: boolean; appliedOperations: number; etag?: string }
    expect(body).toMatchObject({ success: true, appliedOperations: 1 })
    expect(typeof body.etag).toBe('string')

    const after = await readDb()
    expect(after.db.characters[0].name).toBe('patched')
    expect(after.db.characters[1].name).toBe(before.db.characters[1].name)

    const stale = await sendPatch([{ op: 'replace', path: '/characters/0/name', value: 'again' }], before.hash)
    expect(stale.status).toBe(409)

    // The 409 names what diverged: per-root-key and per-character hashes of
    // the server's current view, in the same hex form the client computes.
    const conflict = await stale.json() as {
      code: string
      serverHash: string
      keyHashes: Record<string, string>
      characterHashes: Record<string, string>
      duplicateCharIds: string[]
    }
    expect(conflict.code).toBe('HASH_MISMATCH')
    expect(conflict.serverHash).toBe(after.hash)
    for (const key of Object.keys(after.db)) {
      expect(conflict.keyHashes[key]).toBe(utils.calculateHash(after.db[key]).toString(16))
    }
    expect(Object.keys(conflict.keyHashes).sort()).toEqual(Object.keys(after.db).sort())
    for (const character of after.db.characters) {
      expect(conflict.characterHashes[character.chaId]).toBe(utils.calculateHash(character).toString(16))
    }
    expect(Object.keys(conflict.characterHashes)).toHaveLength(after.db.characters.length)
    expect(conflict.duplicateCharIds).toEqual([])
  })

  test('consecutive patches keep the cached hash in sync with the client', async () => {
    for (let i = 0; i < 3; i++) {
      const { hash } = await readDb()
      const res = await sendPatch([{ op: 'replace', path: '/characters/1/name', value: `round-${i}` }], hash)
      expect(res.status).toBe(200)
    }
    // Without an intervening /api/read the client's next hash is computed
    // locally; mirror that by hashing the object we last read plus our edit.
    const { db, hash } = await readDb()
    db.characters[1].name = 'local-edit'
    const first = await sendPatch([{ op: 'replace', path: '/characters/1/name', value: 'local-edit' }], hash)
    expect(first.status).toBe(200)
    const second = await sendPatch(
      [{ op: 'replace', path: '/characters/1/name', value: 'local-edit-2' }],
      utils.calculateHash(db).toString(16),
    )
    expect(second.status).toBe(200)
    expect((await readDb()).db.characters[1].name).toBe('local-edit-2')
  })

  test('full write reports the hashes of the persisted client view, and they match the next read', async () => {
    const before = await readDb()
    before.db.characters[0].name = 'written-in-full'
    const res = await client.fetch('/api/write', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'file-path': DB_KEY_HEX, 'x-if-match': before.etag! },
      body: Buffer.from(utils.encodeRisuSaveLegacy(before.db)),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as {
      success: boolean
      etag: string
      serverHash: string
      keyHashes: Record<string, string>
      characterHashes: Record<string, string>
      duplicateCharIds: string[]
    }
    expect(body.success).toBe(true)

    // What the server persisted is what the next read serves — same etag,
    // same document hash, same per-key hashes. This is the invariant the
    // client's post-write baseline re-seed relies on.
    const after = await readDb()
    expect(after.db.characters[0].name).toBe('written-in-full')
    expect(after.etag).toBe(body.etag)
    expect(body.serverHash).toBe(after.hash)
    expect(Object.keys(body.keyHashes).sort()).toEqual(Object.keys(after.db).sort())
    for (const key of Object.keys(after.db)) {
      expect(body.keyHashes[key]).toBe(utils.calculateHash(after.db[key]).toString(16))
    }
    for (const character of after.db.characters) {
      expect(body.characterHashes[character.chaId]).toBe(utils.calculateHash(character).toString(16))
    }
    expect(body.duplicateCharIds).toEqual([])

    // And a patch against that read succeeds: the loop this guards against
    // is "write → next patch 409 → write …".
    const next = await sendPatch([{ op: 'replace', path: '/characters/0/name', value: 'patched-after-write' }], after.hash)
    expect(next.status).toBe(200)
  })

  test('a full write with the etag from before another writer is rejected and told the current etag', async () => {
    const mine = await readDb()
    // Another device lands a patch in between.
    const theirs = await sendPatch([{ op: 'replace', path: '/characters/1/name', value: 'from-other-device' }], mine.hash)
    expect(theirs.status).toBe(200)
    const theirEtag = (await theirs.json() as { etag: string }).etag
    expect(theirEtag).not.toBe(mine.etag)

    // My stale patch is a 409 that names the current revision without adopting it for me.
    mine.db.characters[0].name = 'mine-stale'
    const stalePatch = await sendPatch([{ op: 'replace', path: '/characters/0/name', value: 'mine-stale' }], mine.hash)
    expect(stalePatch.status).toBe(409)
    expect((await stalePatch.json() as { currentEtag: string }).currentEtag).toBe(theirEtag)

    // And a full write that still carries my old etag must not overwrite theirs.
    const staleWrite = await client.fetch('/api/write', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'file-path': DB_KEY_HEX, 'x-if-match': mine.etag! },
      body: Buffer.from(utils.encodeRisuSaveLegacy(mine.db)),
    })
    expect(staleWrite.status).toBe(409)
    expect((await staleWrite.json() as { currentEtag: string }).currentEtag).toBe(theirEtag)
    expect((await readDb()).db.characters[1].name).toBe('from-other-device')
  })

  test('empty patch returns the current revision without touching the database', async () => {
    const { etag, hash } = await readDb()
    const res = await sendPatch([], hash)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, appliedOperations: 0, etag })
  })

  test('root-level replace is honored and the hash cache is rebuilt for the new root', async () => {
    const { db, hash } = await readDb()
    const value = { ...db, characters: db.characters.map((c: any, i: number) => (i === 0 ? { ...c, name: 'root-replaced' } : c)) }
    const res = await sendPatch([{ op: 'replace', path: '', value }], hash)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, appliedOperations: 1 })

    const after = await readDb()
    expect(after.db.characters[0].name).toBe('root-replaced')

    const followUp = await sendPatch([{ op: 'replace', path: '/characters/0/name', value: 'after-root' }], after.hash)
    expect(followUp.status).toBe(200)
    expect((await readDb()).db.characters[0].name).toBe('after-root')
  })

  test('a root op that leaves a non-object document is rejected', async () => {
    const before = await readDb()
    for (const value of [1, null, 'text', [1, 2]]) {
      const res = await sendPatch([{ op: 'replace', path: '', value }], before.hash)
      expect(res.status).toBe(400)
    }
    const after = await readDb()
    expect(after.db).toEqual(before.db)
  })

  test('a failing patch leaves the live database untouched', async () => {
    const before = await readDb()
    const res = await sendPatch([
      { op: 'replace', path: '/characters/0/name', value: 'partial' },
      { op: 'replace', path: '/characters/99/name', value: 'missing' },
    ], before.hash)
    expect(res.status).toBe(500)

    const after = await readDb()
    expect(after.db.characters[0].name).toBe(before.db.characters[0].name)
    const recovered = await sendPatch([{ op: 'replace', path: '/characters/0/name', value: 'recovered' }], after.hash)
    expect(recovered.status).toBe(200)
  })
})

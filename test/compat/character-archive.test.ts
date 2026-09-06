/**
 * Character archive (user-facing "deactivate / activate") against a real
 * server. Covers the payload round trip, the client-driven move through
 * /api/patch, the orphan-asset protections, export re-inlining, the guards,
 * and the fail-closed behaviour when a payload disappears.
 *
 * Runs with a low chunk threshold so the payload takes the chunked kv path.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { Packr } from 'msgpackr'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'
import { encodeBackup } from './helpers/encode.js'
import { decodeBackup } from './helpers/decode.js'
import { decodeRisuDat } from './helpers/normalize.js'

const utils = require('../../server/node/utils.cjs') as typeof import('../../server/node/utils.cjs')

const MAGIC_RAW = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])
const packr = new Packr({ useRecords: false })
const encodeDb = (data: unknown) => Buffer.concat([MAGIC_RAW, packr.encode(data)])
const hex = (s: string) => Buffer.from(s, 'utf-8').toString('hex')
const DB_KEY_HEX = hex('database/database.bin')

const ARCH = 'arch-a'
const KEEP = 'keep-b'
const ASSETS = ['a-profile.png', 'a-emo.png', 'a-add.png', 'b-profile.png', 'orphan.png']

function buildBackup(): Buffer {
  const bigMessage = (i: number) => `message ${i} ` + (i === 0 ? '{{inlay::img-hello}} ' : '') + 'lorem ipsum dolor sit amet '.repeat(12)
  const mkChat = (id: string, n: number) => ({
    id, name: `Chat ${id}`, lastDate: Date.now(), localLore: [], scriptstate: {}, note: '',
    message: Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'char' : 'user', data: bigMessage(i) })),
  })
  const characters = [
    {
      chaId: ARCH, type: 'character', name: 'Archived One', desc: 'to be deactivated', firstMessage: 'hi',
      image: 'assets/a-profile.png',
      emotionImages: [['happy', 'assets/a-emo.png']],
      additionalAssets: [['bg', 'assets/a-add.png', 'png']],
      globalLore: [{ key: 'k', content: 'lore '.repeat(50), mode: 'normal', insertorder: 100, alwaysActive: false }],
      chats: [mkChat('a-chat-0', 6), mkChat('a-chat-1', 4)],
      chatPage: 0, lastInteraction: 1000, tags: ['t1'],
    },
    {
      chaId: KEEP, type: 'character', name: 'Kept One', desc: 'stays active', firstMessage: 'yo',
      image: 'assets/b-profile.png',
      chats: [mkChat('b-chat-0', 2)],
      chatPage: 0, lastInteraction: 2000,
    },
  ]
  const database = {
    characters,
    characterOrder: [ARCH, KEEP],
    apiType: 'openai', mainPrompt: '', jailbreak: '', globalNote: '',
    temperature: 80, maxContext: 4000, maxResponse: 300, frequencyPenalty: 70, PresensePenalty: 70,
    personas: [{ name: 'Default', icon: '', personaPrompt: '' }],
    botPresets: [], botPresetsId: 0, moduleIntergration: [], selectedCharacter: 0,
  }
  const entries: Array<{ name: string; data: Buffer }> = [{ name: 'database.risudat', data: encodeDb(database) }]
  // Real exports name asset entries by their key basename; the server stores them as assets/<name>.
  for (const name of ASSETS) entries.push({ name, data: Buffer.from(`fake-png-${name}`) })
  return encodeBackup(entries)
}

let srv: ServerHandle
let client: RisuClient

beforeAll(async () => {
  srv = await spawnServer({ env: { POCKETRISU_CHUNK_THRESHOLD: '4096' } })
  client = await createClient(srv.port, srv.password)
  const imported = await client.importBackup(buildBackup())
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

async function stats() {
  const res = await client.fetch('/api/db/stats')
  expect(res.status).toBe(200)
  return await res.json() as any
}
async function charStats() {
  const res = await client.fetch('/api/db/stats/characters')
  expect(res.status).toBe(200)
  return await res.json() as any
}
async function assetExists(name: string) {
  const res = await client.fetch('/api/read', { headers: { 'file-path': hex(`assets/${name}`) } })
  if (res.status !== 200) return false
  return (await res.arrayBuffer()).byteLength > 0
}
async function exportDb() {
  const bin = await client.exportBackup()
  const entries = decodeBackup(bin)
  const dbEntry = entries.find((e) => e.name === 'database.risudat')
  expect(dbEntry).toBeTruthy()
  return decodeRisuDat(dbEntry!.data) as any
}

let stub: any

describe('character archive', () => {
  test('inlay references are scanned server-side, including lazy-loaded chats', async () => {
    const res = await client.fetch('/api/inlays/references')
    expect(res.status).toBe(200)
    const scan = await res.json() as any
    // Every chat in the seed has the inlay in message 0: 2 chats for arch-a + 1 for keep-b.
    expect(scan.refCounts['img-hello']).toBe(3)
    expect(scan.totalMessages).toBe(12)
  })

  test('archive writes a verified payload without touching the client view', async () => {
    const before = await readDb()
    const res = await client.fetch(`/api/characters/${ARCH}/archive`, { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.ok).toBe(true)
    stub = body.stub
    expect(stub).toMatchObject({ chaId: ARCH, name: 'Archived One', image: 'assets/a-profile.png', chatCount: 2 })
    expect(stub.chatIds).toEqual(['a-chat-0', 'a-chat-1'])
    expect(stub.bytes).toBeGreaterThan(4096) // above the chunk threshold → chunked row

    const after = await readDb()
    expect(after.etag).toBe(before.etag)
    expect(after.db.characters).toHaveLength(2)

    // Rows are versioned: a repeated call would write a second (orphan) row,
    // so the client calls this exactly once per deactivation.
    expect((await stats()).prefixes['archive/'].count).toBe(1)
  })

  test('the client moves the character to the stub list through /api/patch', async () => {
    const before = await readDb()
    const idx = before.db.characters.findIndex((c: any) => c.chaId === ARCH)
    const res = await sendPatch([
      { op: 'remove', path: `/characters/${idx}` },
      { op: 'add', path: '/nodeOnlyArchivedCharacters', value: [stub] },
    ], before.hash)
    expect(res.status).toBe(200)

    const after = await readDb()
    expect(after.db.characters.map((c: any) => c.chaId)).toEqual([KEEP])
    expect(after.db.nodeOnlyArchivedCharacters).toHaveLength(1)
    expect(after.db.nodeOnlyArchivedCharacters[0].chaId).toBe(ARCH)

    // The deactivated chats left fullChatStore on persist; their inlay
    // references now come from the archive index.
    await exportDb() // persist
    const scan = await (await client.fetch('/api/inlays/references')).json() as any
    expect(scan.refCounts['img-hello']).toBe(3)
    expect(scan.sources.archived).toBe(1)
  })

  test('export re-inlines the deactivated character as a complete legacy record', async () => {
    const db = await exportDb() // also flushes the pending persist
    expect(db.nodeOnlyArchivedCharacters).toBeUndefined()
    const ids = db.characters.map((c: any) => c.chaId).sort()
    expect(ids).toEqual([ARCH, KEEP].sort())
    const arch = db.characters.find((c: any) => c.chaId === ARCH)
    expect(arch.chats).toHaveLength(2)
    expect(arch.chats[0].message).toHaveLength(6)
    expect(arch.chats[0]._stub).toBeUndefined()
    expect(Array.isArray(arch.additionalAssets)).toBe(true)
    expect(arch.additionalAssetManifest).toBeUndefined()
    expect(db.characterOrder).toContain(ARCH)
  })

  test('orphan stats and purge keep the deactivated character\'s assets', async () => {
    const s = await stats()
    expect(s.orphan.available).toBe(true)
    expect(s.orphan.count).toBe(1) // only orphan.png
    expect(s.prefixes['archive/'].count).toBe(1)
    expect(s.prefixes['archive/'].totalSize).toBe(stub.bytes)
    expect(s.prefixes['archive-meta/'].count).toBe(1)

    const cs = await charStats()
    const row = cs.characters.find((c: any) => c.chaId === ARCH)
    expect(row).toMatchObject({ archived: true, archiveMissing: false })
    expect(row.imgBytes).toBeGreaterThan(0)
    expect(row.chatBytes).toBeGreaterThan(0)
    expect(cs.orphan).toMatchObject({ available: true, count: 1 })

    const purge = await client.fetch('/api/db/assets/purge-orphans', { method: 'POST' })
    expect(purge.status).toBe(200)
    const result = await purge.json() as any
    expect(result.deleted).toBe(1)
    expect(await assetExists('orphan.png')).toBe(false)
    for (const name of ['a-profile.png', 'a-emo.png', 'a-add.png', 'b-profile.png']) {
      expect(await assetExists(name), name).toBe(true)
    }
  })

  test('a patch that puts the chaId in both lists is rejected', async () => {
    const before = await readDb()
    const res = await sendPatch([
      { op: 'add', path: '/characters/-', value: { ...stub, type: 'character', chats: [] } },
    ], before.hash)
    expect(res.status).toBe(409)
    expect((await res.json() as any).code).toBe('ARCHIVE_GUARD_REJECTED')
  })

  test('a full write that puts the chaId in both lists is rejected too', async () => {
    const before = await readDb()
    const db = structuredClone(before.db)
    db.characters.push({ ...stub, type: 'character', chats: [] })
    const res = await client.fetch('/api/write', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'file-path': DB_KEY_HEX },
      body: new Uint8Array(encodeDb(db)),
    })
    expect(res.status).toBe(409)
    expect((await res.json() as any).code).toBe('ARCHIVE_GUARD_REJECTED')
    const after = await readDb()
    expect(after.db.characters.map((c: any) => c.chaId)).toEqual([KEEP])
  })

  test('activate returns the client view and keeps the payload', async () => {
    const res = await client.fetch(`/api/characters/${ARCH}/activate`, { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    const character = body.character
    expect(character.chaId).toBe(ARCH)
    expect(character.chats).toHaveLength(2)
    expect(character.chats[0]._stub).toBe(true)
    expect(character.chats[0].message).toBeUndefined()
    expect(character.additionalAssets).toBeUndefined()
    expect(character.additionalAssetManifest).toBeTruthy()

    const before = await readDb()
    const patched = await sendPatch([
      { op: 'add', path: '/characters/-', value: character },
      { op: 'replace', path: '/nodeOnlyArchivedCharacters', value: [] },
    ], before.hash)
    expect(patched.status).toBe(200)

    const after = await readDb()
    expect(after.db.characters.map((c: any) => c.chaId).sort()).toEqual([ARCH, KEEP].sort())
    expect(after.db.nodeOnlyArchivedCharacters).toEqual([])

    const idx = after.db.characters.findIndex((c: any) => c.chaId === ARCH)
    const chat = await client.fetch(`/api/chat-content/${ARCH}/0`, { headers: { 'x-chat-id': 'a-chat-0' } })
    expect(chat.status).toBe(200)
    const chatObj = await utils.decodeRisuSave(Buffer.from(await chat.arrayBuffer())) as any
    expect(chatObj.message).toHaveLength(6)
    expect(idx).toBeGreaterThanOrEqual(0)

    // Payload retained (snapshot-restore safety); export is a plain database again.
    const s = await stats()
    expect(s.prefixes['archive/'].count).toBe(1)
    const db = await exportDb()
    expect(db.characters).toHaveLength(2)
    expect(db.nodeOnlyArchivedCharacters).toBeUndefined()
  })

  test('activating an active character and a missing payload both fail cleanly', async () => {
    const dup = await client.fetch(`/api/characters/${ARCH}/activate`, { method: 'POST' })
    expect(dup.status).toBe(409)
    const nope = await client.fetch(`/api/characters/does-not-exist/activate`, { method: 'POST' })
    expect(nope.status).toBe(404)
    expect((await nope.json() as any).code).toBe('ARCHIVE_PAYLOAD_MISSING')
  })

  let stub2: any

  test('re-deactivation writes a new row, keeps the old one, and exports the current body', async () => {
    // Edit a chat while active so the second row differs from the first.
    const chatRes = await client.fetch(`/api/chat-content/${ARCH}/0`, { headers: { 'x-chat-id': 'a-chat-0' } })
    expect(chatRes.status).toBe(200)
    const chat = await utils.decodeRisuSave(Buffer.from(await chatRes.arrayBuffer())) as any
    chat.message.push({ role: 'user', data: 'seventh message, written after re-activation' })
    const saved = await client.fetch(`/api/chat-content/${ARCH}/0`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-chat-id': 'a-chat-0' },
      body: new Uint8Array(encodeDb(chat)),
    })
    expect(saved.status).toBe(200)

    const res = await client.fetch(`/api/characters/${ARCH}/archive`, { method: 'POST' })
    expect(res.status).toBe(200)
    stub2 = (await res.json() as any).stub
    expect(stub2.archivedAt).not.toBe(stub.archivedAt)
    expect(stub2.chatCount).toBe(2)

    const before = await readDb()
    const idx = before.db.characters.findIndex((c: any) => c.chaId === ARCH)
    const moved = await sendPatch([
      { op: 'remove', path: `/characters/${idx}` },
      { op: 'replace', path: '/nodeOnlyArchivedCharacters', value: [stub2] },
    ], before.hash)
    expect(moved.status).toBe(200)

    // Both rows exist: the first is now an orphan (kept for snapshot restores).
    const s = await stats()
    expect(s.prefixes['archive/'].count).toBe(2)
    expect(s.archiveOrphan).toMatchObject({ available: true, count: 1 })
    expect(s.orphan).toMatchObject({ available: true, count: 0 })

    const db = await exportDb()
    const arch = db.characters.find((c: any) => c.chaId === ARCH)
    expect(arch.chats[0].message).toHaveLength(7)
  })

  test('activate honours the row version named by the client', async () => {
    // The client names the row its stub was made with. Asking for the older
    // (now orphan) row must restore that body, not the newest one.
    const wrong = await client.fetch(`/api/characters/${ARCH}/activate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ archivedAt: 12345 }),
    })
    expect(wrong.status).toBe(404)
    const old = await client.fetch(`/api/characters/${ARCH}/activate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ archivedAt: stub.archivedAt }),
    })
    expect(old.status).toBe(200)
    const chat = await client.fetch(`/api/chat-content/${ARCH}/0`, { headers: { 'x-chat-id': 'a-chat-0' } })
    expect(chat.status).toBe(200)
    const chatObj = await utils.decodeRisuSave(Buffer.from(await chat.arrayBuffer())) as any
    expect(chatObj.message).toHaveLength(6) // first deactivation's body, not the 7-message one
    // Not moving it back into `characters` here: the database still points at stub2.
  })

  test('a deactivated character whose payload vanished fails closed everywhere', async () => {
    // Simulate loss of the referenced row (manual kv deletion); the orphan row stays.
    const del = await client.fetch('/api/remove', { headers: { 'file-path': hex(`archive/${ARCH}/${stub2.archivedAt}`) } })
    expect(del.status).toBe(200)

    const s = await stats()
    expect(s.orphan.available).toBe(false)
    const cs = await charStats()
    expect(cs.orphan.available).toBe(false)
    expect(cs.characters.find((c: any) => c.chaId === ARCH)).toMatchObject({ archived: true, archiveMissing: true })

    const purge = await client.fetch('/api/db/assets/purge-orphans', { method: 'POST' })
    expect(purge.status).toBe(400)
    for (const name of ['a-profile.png', 'a-emo.png', 'a-add.png']) {
      expect(await assetExists(name), name).toBe(true)
    }

    const exp = await client.fetch('/api/backup/export')
    expect(exp.status).toBe(500)

    const act = await client.fetch(`/api/characters/${ARCH}/activate`, { method: 'POST' })
    expect(act.status).toBe(404)
    expect((await act.json() as any).code).toBe('ARCHIVE_PAYLOAD_MISSING')
  })

  test('importing a backup keeps archive rows as orphans until purged explicitly', async () => {
    const imported = await client.importBackup(createSeedBackup({ characterCount: 1 }))
    expect(imported.ok).toBe(true)
    await readDb() // warm dbCache — /api/db/stats reports from the live cache
    let s = await stats()
    expect(s.prefixes['archive/'].count).toBe(1)        // the surviving first row
    expect(s.prefixes['archive-meta/'].count).toBe(2)   // both index rows
    expect(s.archiveOrphan).toMatchObject({ available: true, count: 1 })
    expect(s.orphan.available).toBe(true)               // nothing referenced is missing
    const db = (await readDb()).db
    expect(db.nodeOnlyArchivedCharacters ?? []).toEqual([])

    const purge = await client.fetch('/api/db/archive/purge-orphans', { method: 'POST' })
    expect(purge.status).toBe(200)
    expect(await purge.json() as any).toMatchObject({ ok: true, deleted: 1, metas: 2 })
    s = await stats()
    expect(s.prefixes['archive/'].count).toBe(0)
    expect(s.prefixes['archive-meta/'].count).toBe(0)
    expect(s.archiveOrphan).toMatchObject({ available: true, count: 0 })
  })
})

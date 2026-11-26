/**
 * The inlay reference scan behind the gallery's "Not in Messages" filter
 * counts every place a chat keeps an inlay token: message text, the other
 * swipes and chat script variables (image-generation triggers). Before, an
 * image kept only in another swipe or a trigger variable was offered for
 * deletion. Archive index rows counted by the old scanner are counted again
 * from their payload.
 */
import { afterAll, describe, expect, test } from 'vitest'
import Database from 'better-sqlite3'
import { cp } from 'node:fs/promises'
import path from 'node:path'
import { Packr } from 'msgpackr'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { encodeBackup } from './helpers/encode.js'

const utils = require('../../server/node/utils.cjs') as typeof import('../../server/node/utils.cjs')

const MAGIC_RAW = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])
const packr = new Packr({ useRecords: false })
const encodeDb = (data: unknown) => Buffer.concat([MAGIC_RAW, packr.encode(data)])
const DB_KEY_HEX = Buffer.from('database/database.bin', 'utf-8').toString('hex')

function chat(id: string, tag: string) {
  return {
    id, name: id, lastDate: 1, localLore: [], note: '',
    scriptstate: { $img: `{{inlay::${tag}-var}}`, $count: 3 },
    message: [
      { role: 'user', data: 'hi' },
      {
        role: 'char', data: `shown {{inlay::${tag}-data}}`,
        swipes: [`older {{inlay::${tag}-swipe}}`, `shown {{inlay::${tag}-data}}`], swipeId: 1,
      },
    ],
  }
}

function buildBackup(): Buffer {
  const character = (chaId: string, tag: string) => ({
    chaId, type: 'character', name: chaId, desc: '', firstMessage: 'hi', image: '',
    chats: [chat(`${chaId}-chat`, tag)], chatPage: 0, lastInteraction: 1,
  })
  const database = {
    characters: [character('arch', 'a'), character('live', 'l')],
    characterOrder: ['arch', 'live'],
    apiType: 'openai', mainPrompt: '', jailbreak: '', globalNote: '',
    temperature: 80, maxContext: 4000, maxResponse: 300, frequencyPenalty: 70, PresensePenalty: 70,
    personas: [{ name: 'Default', icon: '', personaPrompt: '' }],
    botPresets: [], botPresetsId: 0, moduleIntergration: [], selectedCharacter: 0,
  }
  return encodeBackup([{ name: 'database.risudat', data: encodeDb(database) }])
}

const servers: ServerHandle[] = []
afterAll(async () => {
  await Promise.allSettled(servers.map((s) => s.cleanup()))
})

async function scan(client: RisuClient) {
  const res = await client.fetch('/api/inlays/references')
  expect(res.status).toBe(200)
  return await res.json() as { refCounts: Record<string, number>, sources: { archived: number } }
}

async function stop(server: ServerHandle) {
  const stopped = new Promise((resolve) => server.child.once('exit', resolve))
  server.child.kill('SIGTERM')
  await stopped
}

function archiveMetaRow(saveDir: string) {
  const sqlite = new Database(path.join(saveDir, 'risuai.db'))
  try {
    const row = sqlite.prepare(`SELECT key, value FROM kv WHERE key LIKE 'archive-meta/arch/%'`).get() as { key: string, value: Buffer }
    return { key: row.key, meta: JSON.parse(Buffer.from(row.value).toString('utf-8')) }
  } finally {
    sqlite.close()
  }
}

describe('inlay references', () => {
  let first: ServerHandle
  let client: RisuClient

  test('count the other swipes and script variables of a chat', async () => {
    first = await spawnServer()
    servers.push(first)
    client = await createClient(first.port, first.password)
    expect((await client.importBackup(buildBackup())).ok).toBe(true)

    const { refCounts } = await scan(client)
    for (const id of ['l-data', 'l-swipe', 'l-var']) expect(refCounts[id]).toBeGreaterThan(0)
  })

  test('an archive row counted by the old scanner is counted again', async () => {
    const archived = await client.fetch('/api/characters/arch/archive', { method: 'POST' })
    expect(archived.status).toBe(200)
    const { stub } = await archived.json() as any
    // Move it to the stub list like the client does, so its chats leave the
    // live store and only the archive row can vouch for them.
    const read = await client.fetch('/api/read', { headers: { 'file-path': DB_KEY_HEX } })
    const db = utils.normalizeJSON(await utils.decodeRisuSave(Buffer.from(await read.arrayBuffer()))) as any
    const patched = await client.fetch('/api/patch', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'file-path': DB_KEY_HEX },
      body: JSON.stringify({
        patch: [
          { op: 'remove', path: `/characters/${db.characters.findIndex((c: any) => c.chaId === 'arch')}` },
          { op: 'add', path: '/nodeOnlyArchivedCharacters', value: [stub] },
        ],
        expectedHash: utils.calculateHash(db).toString(16),
      }),
    })
    expect(patched.status).toBe(200)
    await stop(first)

    // A row written now counts them; make it look like one written before.
    const firstSave = path.join(first.cwd, 'save')
    const { key, meta } = archiveMetaRow(firstSave)
    for (const id of ['a-data', 'a-swipe', 'a-var']) expect(meta.inlayRefs[id]).toBeGreaterThan(0)
    delete meta.inlayRefsVersion
    meta.inlayRefs = { 'a-data': 1 }
    const sqlite = new Database(path.join(firstSave, 'risuai.db'))
    sqlite.prepare('UPDATE kv SET value = ? WHERE key = ?').run(Buffer.from(JSON.stringify(meta), 'utf-8'), key)
    sqlite.close()

    const second = await spawnServer({ seedSave: (saveDir) => cp(firstSave, saveDir, { recursive: true }) })
    servers.push(second)
    const after = await createClient(second.port, second.password)
    const result = await scan(after)
    expect(result.sources.archived).toBe(1)
    for (const id of ['a-data', 'a-swipe', 'a-var']) expect(result.refCounts[id]).toBeGreaterThan(0)
    await stop(second)

    // Stored, so the next scan does not decode the payload again.
    const updated = archiveMetaRow(path.join(second.cwd, 'save')).meta
    expect(updated.inlayRefsVersion).toBe(2)
    expect(updated.inlayRefs['a-swipe']).toBeGreaterThan(0)
    expect(updated.chatIds).toEqual(meta.chatIds)
  })
})

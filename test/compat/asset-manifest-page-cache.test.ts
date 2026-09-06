/**
 * Manifest pages are content-addressed, so the server marks them immutable
 * for the browser cache; a missing manifest must never be cached.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { encodeBackup } from './helpers/encode.js'

const utils = require('../../server/node/utils.cjs') as any
const DB_KEY_HEX = Buffer.from('database/database.bin').toString('hex')

let srv: ServerHandle
let client: RisuClient

beforeAll(async () => {
    srv = await spawnServer()
    client = await createClient(srv.port, srv.password)
    const db = {
        apiType: 'openai',
        characters: [{ chaId: 'c1', name: 'Char', chats: [], additionalAssets: [['x.png', 'assets/x', 'png'], ['y.png', 'assets/y', 'png']] }],
        modules: [],
    }
    const seed = encodeBackup([{ name: 'database.risudat', data: Buffer.from(utils.encodeRisuSaveLegacy(db)) }])
    expect((await client.importBackup(seed)).ok).toBe(true)
})

afterAll(async () => { await srv?.cleanup() })

describe('asset manifest page caching', () => {
    test('a page for a live manifest id is served immutable with its items intact', async () => {
        const read = await client.fetch('/api/read', { headers: { 'file-path': DB_KEY_HEX } })
        const db = utils.normalizeJSON(await utils.decodeRisuSave(Buffer.from(await read.arrayBuffer()))) as any
        const descriptor = db.characters[0].additionalAssetManifest
        expect(descriptor?.id).toBeTruthy()

        const res = await client.fetch(`/api/asset-manifests/${encodeURIComponent(descriptor.id)}?offset=0&limit=500&v=${descriptor.version}`)
        expect(res.status).toBe(200)
        expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
        const page = await res.json() as { total: number; items: string[][] }
        expect(page.total).toBe(2)
        expect(page.items.map((item) => item[0]).sort()).toEqual(['x.png', 'y.png'])
    })

    test('an unknown manifest id is a 404 that must not be cached', async () => {
        const res = await client.fetch('/api/asset-manifests/does-not-exist?offset=0&limit=500')
        expect(res.status).toBe(404)
        expect(res.headers.get('cache-control')).toBe('no-store')
    })
})

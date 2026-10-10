// @vitest-environment node
/**
 * plugin-storage: server-side data-safety paths against a real server.
 *
 *   F1  DB snapshots carry the plugin-storage/ rows; restore reproduces
 *       exactly the snapshot-time set (post-split and pre-split snapshots).
 *   F2  A truncated .bin import (> one commit batch) leaves the old
 *       database.bin AND its plugin rows intact.
 *   F3  Save-folder import replaces the plugin-storage/ prefix.
 *   F4  A full /api/write of database.bin with a populated
 *       pluginCustomStorage is split into kv before it hits disk.
 *   S3  Old-client /api/patch ops on /pluginCustomStorage: direct-child
 *       add/replace/remove are routed to kv, everything else is 409.
 */
import { describe, test, expect, afterAll } from 'vitest'
import { createHash } from 'node:crypto'
import { writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Packr } from 'msgpackr'
import * as fflate from 'fflate'
import { spawnServer, type ServerHandle } from './compat/helpers/spawnServer.js'
import { createClient, type RisuClient } from './compat/helpers/client.js'
import { encodeBackup } from './compat/helpers/encode.js'

const storeMod = require('../server/node/plugin-storage-store.cjs')
const utils = require('../server/node/utils.cjs') as typeof import('../server/node/utils.cjs')
const { encodeKey, PREFIX, SNAPSHOT_PREFIX, BLOB_PREFIX } = storeMod
const sha = (v: unknown) => createHash('sha256').update(Buffer.from(JSON.stringify(v))).digest('hex')

const MAGIC_RAW = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])
const packr = new Packr({ useRecords: false })
const DB_KEY = 'database/database.bin'
const DB_KEY_HEX = Buffer.from(DB_KEY).toString('hex')
const hex = (s: string) => Buffer.from(s, 'utf-8').toString('hex')

function dbBlob(pluginCustomStorage: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return Buffer.concat([MAGIC_RAW, packr.encode({
        characters: [], apiType: 'openai', botPresets: [], botPresetsId: 0, personas: [],
        moduleIntergration: [], selectedCharacter: 0,
        pluginCustomStorage, ...extra,
    })])
}

function backupWith(pluginCustomStorage: Record<string, unknown>) {
    return encodeBackup([{ name: 'database.risudat', data: dbBlob(pluginCustomStorage) }])
}

function saveFolderZip(entries: Record<string, Buffer>) {
    const zippable: Record<string, Uint8Array> = {}
    for (const [key, value] of Object.entries(entries)) zippable[hex(key)] = new Uint8Array(value)
    return Buffer.from(fflate.zipSync(zippable))
}

const servers: ServerHandle[] = []
afterAll(async () => { await Promise.allSettled(servers.map(s => s.cleanup())) })

async function boot(env: Record<string, string> = {}) {
    const srv = await spawnServer({ env })
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)
    return { srv, client }
}

async function readDb(client: RisuClient) {
    const res = await client.fetch('/api/read', { headers: { 'file-path': DB_KEY_HEX } })
    expect(res.status).toBe(200)
    return utils.normalizeJSON(await utils.decodeRisuSave(Buffer.from(await res.arrayBuffer()))) as any
}

async function indexKeys(client: RisuClient) {
    const res = await client.fetch('/api/plugin-storage/index')
    expect(res.status).toBe(200)
    const body = await res.json() as { entries: { key: string }[]; migrated: boolean }
    return { keys: body.entries.map(e => e.key).sort(), migrated: body.migrated }
}

async function writeKv(client: RisuClient, key: string, value: Buffer) {
    const res = await client.fetch('/api/write', {
        method: 'POST',
        headers: { 'file-path': hex(key), 'content-type': 'application/octet-stream' },
        body: value,
    })
    expect(res.status).toBe(200)
    return res
}

async function writePluginKey(client: RisuClient, key: string, value: unknown) {
    await writeKv(client, `${PREFIX}${encodeKey(key)}`, Buffer.from(JSON.stringify(value)))
}

async function readPluginKey(client: RisuClient, key: string) {
    const res = await client.fetch('/api/read', { headers: { 'file-path': hex(`${PREFIX}${encodeKey(key)}`) } })
    if (res.status !== 200) return null
    // /api/read answers a missing key with 200 and an empty body.
    const text = await res.text()
    return text ? JSON.parse(text) : null
}

async function readKvJson(client: RisuClient, key: string) {
    const res = await client.fetch('/api/read', { headers: { 'file-path': hex(key) } })
    expect(res.status).toBe(200)
    return JSON.parse(await res.text())
}

async function listKv(client: RisuClient, prefix: string) {
    const res = await client.fetch('/api/list', { headers: { 'key-prefix': prefix } })
    expect(res.status).toBe(200)
    return ((await res.json()) as { content: string[] }).content.sort()
}

async function snapshots(client: RisuClient) {
    const res = await client.fetch('/api/db/snapshots')
    expect(res.status).toBe(200)
    // Newest first.
    return ((await res.json()) as { snapshots: { key: string; size: number; timestamp: number }[] }).snapshots
}

// The plugin-storage map key every listed snapshot must have exactly once.
async function snapshotMapKeys(client: RisuClient) {
    return (await snapshots(client))
        .map(s => `${SNAPSHOT_PREFIX}${s.key.slice('database/dbbackup-'.length, -4)}`)
        .sort()
}

async function restoreSnapshot(client: RisuClient, key: string) {
    const res = await client.fetch('/api/db/snapshots/restore', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }),
    })
    expect(res.status).toBe(200)
}

// Snapshot keys are timestamped at 100ms resolution — space them out.
const tick = () => new Promise(r => setTimeout(r, 250))

describe('F1: snapshots carry plugin storage', () => {
    test('restore reproduces the snapshot-time set; rotation/delete drop the rows', async () => {
        const { client } = await boot({ POCKETRISU_BACKUP_INTERVAL_MS: '0' })

        // Import → cold decode → forced PRE-split snapshot S1 (data in blob,
        // no plugin rows) → migration.
        expect((await client.importBackup(backupWith({ a: 'A' }))).ok).toBe(true)
        expect(await indexKeys(client)).toEqual({ keys: ['a'], migrated: true })
        const s1 = (await snapshots(client))[0]
        expect(s1).toBeDefined()
        const s1Id = s1.key.slice('database/dbbackup-'.length, -4)
        // Pre-split: an empty map (no entries, no marker) and no blobs. The
        // import may also take a pre-import snapshot of the boot database; it
        // lands under a different key only when the two calls straddle a
        // 100ms tick, so assert the invariant (one map row per snapshot)
        // rather than an exact count.
        expect(await listKv(client, SNAPSHOT_PREFIX)).toEqual(await snapshotMapKeys(client))
        expect(await listKv(client, SNAPSHOT_PREFIX)).toContain(`${SNAPSHOT_PREFIX}${s1Id}`)
        expect(await readKvJson(client, `${SNAPSHOT_PREFIX}${s1Id}`)).toMatchObject({ entries: [], marker: null })
        expect(await listKv(client, BLOB_PREFIX)).toEqual([])

        await writePluginKey(client, 'b', 'B')
        await tick()
        // A full database.bin write takes a POST-split snapshot S2 = {a, b}.
        await writeKv(client, DB_KEY, dbBlob({}))
        const s2 = (await snapshots(client))[0]
        expect(s2.key).not.toBe(s1.key)
        const s2Id = s2.key.slice('database/dbbackup-'.length, -4)
        // Content-addressed: one map row for S2, no per-key row copies, and
        // one blob per distinct value.
        expect(await listKv(client, SNAPSHOT_PREFIX)).toEqual(await snapshotMapKeys(client))
        expect(await listKv(client, SNAPSHOT_PREFIX)).toEqual(expect.arrayContaining([`${SNAPSHOT_PREFIX}${s1Id}`, `${SNAPSHOT_PREFIX}${s2Id}`]))
        const s2Map = await readKvJson(client, `${SNAPSHOT_PREFIX}${s2Id}`)
        expect(s2Map.entries.sort()).toEqual([[encodeKey('a'), sha('A')], [encodeKey('b'), sha('B')]].sort())
        expect(JSON.parse(s2Map.marker)).toMatchObject({ version: 1 })
        expect(await listKv(client, BLOB_PREFIX)).toEqual([`${BLOB_PREFIX}${sha('A')}`, `${BLOB_PREFIX}${sha('B')}`].sort())
        // Listed size includes the plugin bytes (map + unique blobs).
        expect(s2.size).toBeGreaterThan(s1.size)
        expect(s2.size - s1.size).toBeGreaterThanOrEqual(Buffer.byteLength('"A"') + Buffer.byteLength('"B"'))

        // Diverge live: update a, add c, delete b.
        await writePluginKey(client, 'a', 'A-new')
        await writePluginKey(client, 'c', 'C')
        await client.fetch('/api/remove', { headers: { 'file-path': hex(`${PREFIX}${encodeKey('b')}`) } })
        expect((await indexKeys(client)).keys).toEqual(['a', 'c'])

        // Restore S2 → exactly {a: 'A', b: 'B'}, marker kept, c gone.
        await restoreSnapshot(client, s2.key)
        expect(await indexKeys(client)).toEqual({ keys: ['a', 'b'], migrated: true })
        expect(await readPluginKey(client, 'a')).toBe('A')
        expect(await readPluginKey(client, 'c')).toBeNull()
        expect((await readDb(client)).pluginCustomStorage).toEqual({})

        // Restore pre-split S1 → live rows cleared, blob re-split → exactly {a: 'A'}.
        await writePluginKey(client, 'd', 'D')
        await restoreSnapshot(client, s1.key)
        expect(await indexKeys(client)).toEqual({ keys: ['a'], migrated: true })
        expect(await readPluginKey(client, 'a')).toBe('A')
        expect(await readPluginKey(client, 'd')).toBeNull()
        expect((await readDb(client)).pluginCustomStorage).toEqual({})

        // Take S3 = {a: 'A'} (live after the S1 restore) so 'A' is shared
        // between S2 and S3 while 'B' is unique to S2.
        await tick()
        await writeKv(client, DB_KEY, dbBlob({}))
        const s3 = (await snapshots(client))[0]
        expect(s3.key).not.toBe(s2.key)
        const s3Id = s3.key.slice('database/dbbackup-'.length, -4)
        expect(await listKv(client, BLOB_PREFIX)).toEqual([`${BLOB_PREFIX}${sha('A')}`, `${BLOB_PREFIX}${sha('B')}`].sort())

        // Delete route drops the map and GCs only the blob unique to S2.
        const del = await client.fetch(`/api/db/snapshots?key=${encodeURIComponent(s2.key)}`, { method: 'DELETE' })
        expect(del.status).toBe(200)
        expect(await listKv(client, `${SNAPSHOT_PREFIX}${s2Id}`)).toEqual([])
        expect(await listKv(client, `${SNAPSHOT_PREFIX}${s3Id}`)).toEqual([`${SNAPSHOT_PREFIX}${s3Id}`])
        expect(await listKv(client, BLOB_PREFIX)).toEqual([`${BLOB_PREFIX}${sha('A')}`])
        expect((await snapshots(client)).some(s => s.key === s2.key)).toBe(false)
        // S3 still restores in full after the GC.
        await writePluginKey(client, 'e', 'E')
        await restoreSnapshot(client, s3.key)
        expect(await indexKeys(client)).toEqual({ keys: ['a'], migrated: true })
        expect(await readPluginKey(client, 'a')).toBe('A')

        // Rotation: maxCount 1 → everything but the newest goes, maps and
        // now-unreferenced blobs included.
        await writePluginKey(client, 'f', 'F')
        await tick()
        await writeKv(client, DB_KEY, dbBlob({}))
        const limits = await client.fetch('/api/db/snapshots/limits', {
            method: 'PUT', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ maxCount: 1, maxBytes: 10 * 1024 * 1024 }),
        })
        expect(limits.status).toBe(200)
        const remaining = await snapshots(client)
        expect(remaining.length).toBe(1)
        const keptId = remaining[0].key.slice('database/dbbackup-'.length, -4)
        expect(keptId).not.toBe(s3Id)
        expect(await listKv(client, SNAPSHOT_PREFIX)).toEqual([`${SNAPSHOT_PREFIX}${keptId}`])
        // Kept snapshot = {a: 'A', f: 'F'}; 'A' stays (still referenced), 'F' added.
        expect(await listKv(client, BLOB_PREFIX)).toEqual([`${BLOB_PREFIX}${sha('A')}`, `${BLOB_PREFIX}${sha('F')}`].sort())
        // Live rows unaffected by rotation.
        expect((await indexKeys(client)).keys).toEqual(['a', 'f'])
    })

    test('R1: a malformed snapshot key is rejected by delete/restore and nothing is deleted', async () => {
        const { client } = await boot({ POCKETRISU_BACKUP_INTERVAL_MS: '0' })
        expect((await client.importBackup(backupWith({ a: 'A' }))).ok).toBe(true)
        await writePluginKey(client, 'b', 'B')
        await tick()
        await writeKv(client, DB_KEY, dbBlob({}))
        const snap = (await snapshots(client))[0]
        const id = snap.key.slice('database/dbbackup-'.length, -4)
        const mapsBefore = await listKv(client, SNAPSHOT_PREFIX)
        const blobsBefore = await listKv(client, BLOB_PREFIX)
        expect(mapsBefore).toContain(`${SNAPSHOT_PREFIX}${id}`)
        expect(blobsBefore.length).toBeGreaterThan(0)

        // Prefix-valid but malformed: stripping 4 chars would yield `<id>`.
        const bad = [`database/dbbackup-${id}xxxx`, `database/dbbackup-${id}.bin/`, `database/dbbackup-${id}.bi`, 'database/dbbackup-.bin']
        for (const key of bad) {
            const del = await client.fetch(`/api/db/snapshots?key=${encodeURIComponent(key)}`, { method: 'DELETE' })
            expect(del.status, key).toBe(400)
            const restore = await client.fetch('/api/db/snapshots/restore', {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }),
            })
            expect(restore.status, key).toBe(400)
        }
        expect((await snapshots(client)).some(s => s.key === snap.key)).toBe(true)
        expect(await listKv(client, SNAPSHOT_PREFIX)).toEqual(mapsBefore)
        expect(await listKv(client, BLOB_PREFIX)).toEqual(blobsBefore)
        // The real key still restores.
        await writePluginKey(client, 'c', 'C')
        await restoreSnapshot(client, snap.key)
        expect((await indexKeys(client)).keys).toEqual(['a', 'b'])
    })

    test('R2: a raw /api/remove of a snapshot key drops its map row and unique blobs', async () => {
        const { client } = await boot({ POCKETRISU_BACKUP_INTERVAL_MS: '0' })
        expect((await client.importBackup(backupWith({ a: 'A' }))).ok).toBe(true)
        await writePluginKey(client, 'b', 'B')
        await tick()
        await writeKv(client, DB_KEY, dbBlob({}))          // S2 = {a: 'A', b: 'B'}
        const s2 = (await snapshots(client))[0]
        const s2Id = s2.key.slice('database/dbbackup-'.length, -4)
        await client.fetch('/api/remove', { headers: { 'file-path': hex(`${PREFIX}${encodeKey('b')}`) } })
        await tick()
        await writeKv(client, DB_KEY, dbBlob({}))          // S3 = {a: 'A'}
        const s3 = (await snapshots(client))[0]
        const s3Id = s3.key.slice('database/dbbackup-'.length, -4)
        expect(await listKv(client, BLOB_PREFIX)).toEqual([`${BLOB_PREFIX}${sha('A')}`, `${BLOB_PREFIX}${sha('B')}`].sort())

        const rm = await client.fetch('/api/remove', { headers: { 'file-path': hex(s2.key) } })
        expect(rm.status).toBe(200)
        expect((await snapshots(client)).some(s => s.key === s2.key)).toBe(false)
        expect(await listKv(client, `${SNAPSHOT_PREFIX}${s2Id}`)).toEqual([])
        expect(await listKv(client, `${SNAPSHOT_PREFIX}${s3Id}`)).toEqual([`${SNAPSHOT_PREFIX}${s3Id}`])
        expect(await listKv(client, BLOB_PREFIX)).toEqual([`${BLOB_PREFIX}${sha('A')}`])
    })

    test('R4: a failed snapshot does not advance the backup cooldown', async () => {
        const preload = fileURLToPath(new URL('./compat/helpers/fail-snapshot-preload.cjs', import.meta.url))
        const { srv, client } = await boot({ POCKETRISU_BACKUP_INTERVAL_MS: '1500', NODE_OPTIONS: `--require ${JSON.stringify(preload)}` })
        expect((await client.importBackup(backupWith({ a: 'A' }))).ok).toBe(true)
        const count0 = (await snapshots(client)).length
        expect(count0).toBeGreaterThan(0)
        // Let the cooldown from the import-time snapshot lapse.
        await new Promise(r => setTimeout(r, 1700))

        const flag = path.join(srv.cwd, 'fail-snapshot')
        await writeFile(flag, '')
        const failing = await client.fetch('/api/write', {
            method: 'POST',
            headers: { 'file-path': DB_KEY_HEX, 'content-type': 'application/octet-stream' },
            body: dbBlob({}),
        })
        expect(failing.status).toBe(500)
        expect((await snapshots(client)).length).toBe(count0)
        await rm(flag)

        // Immediately (well within the cooldown) the next write must back up.
        await tick()
        await writeKv(client, DB_KEY, dbBlob({}))
        expect((await snapshots(client)).length).toBe(count0 + 1)
    })

    test('a legacy row-copy snapshot restores through the route', async () => {
        const { client } = await boot({ POCKETRISU_BACKUP_INTERVAL_MS: '0' })
        expect((await client.importBackup(backupWith({ a: 'A' }))).ok).toBe(true)
        await writePluginKey(client, 'b', 'B')
        await tick()
        await writeKv(client, DB_KEY, dbBlob({}))
        const snap = (await snapshots(client))[0]
        const id = snap.key.slice('database/dbbackup-'.length, -4)

        // Rewrite the snapshot into the pre-dedup layout by hand: drop the
        // map + blobs, plant `<id>/<enc>` row copies.
        await client.fetch('/api/remove', { headers: { 'file-path': hex(`${SNAPSHOT_PREFIX}${id}`) } })
        for (const k of await listKv(client, BLOB_PREFIX)) await client.fetch('/api/remove', { headers: { 'file-path': hex(k) } })
        await writeKv(client, `${SNAPSHOT_PREFIX}${id}/${encodeKey('a')}`, Buffer.from('"A"'))
        await writeKv(client, `${SNAPSHOT_PREFIX}${id}/${encodeKey('b')}`, Buffer.from('"B"'))
        await writeKv(client, `${SNAPSHOT_PREFIX}${id}/__migrated__`, Buffer.from('{"version":1}'))
        // Legacy rows count in full (at least the three planted rows).
        const listed = (await snapshots(client)).find(s => s.key === snap.key)!
        expect(listed.size).toBeGreaterThanOrEqual(3 + 3 + '{"version":1}'.length)

        await writePluginKey(client, 'a', 'A-live')
        await writePluginKey(client, 'c', 'C')
        await restoreSnapshot(client, snap.key)
        expect(await indexKeys(client)).toEqual({ keys: ['a', 'b'], migrated: true })
        expect(await readPluginKey(client, 'a')).toBe('A')

        const del = await client.fetch(`/api/db/snapshots?key=${encodeURIComponent(snap.key)}`, { method: 'DELETE' })
        expect(del.status).toBe(200)
        expect(await listKv(client, `${SNAPSHOT_PREFIX}${id}`)).toEqual([])
        expect((await snapshots(client)).some(s => s.key === snap.key)).toBe(false)
    })
})

// ─── S3: old-client /api/patch ops on /pluginCustomStorage ─────────────────

describe('S3: old-client patch ops on /pluginCustomStorage', () => {
    async function readDbWithHash(client: RisuClient) {
        const res = await client.fetch('/api/read', { headers: { 'file-path': DB_KEY_HEX } })
        expect(res.status).toBe(200)
        const db = utils.normalizeJSON(await utils.decodeRisuSave(Buffer.from(await res.arrayBuffer()))) as any
        return { db, etag: res.headers.get('x-db-etag'), hash: utils.calculateHash(db).toString(16) }
    }
    function sendPatch(client: RisuClient, patch: unknown[], expectedHash: string) {
        return client.fetch('/api/patch', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'file-path': DB_KEY_HEX },
            body: JSON.stringify({ patch, expectedHash }),
        })
    }
    const P = '/pluginCustomStorage'

    test('(a)(b) direct-child add/replace/remove land in kv; empty-DB path keeps hash + etag valid', async () => {
        const { client } = await boot()
        expect((await client.importBackup(backupWith({ seed: 'S' }))).ok).toBe(true)
        const before = await readDbWithHash(client)

        const res = await sendPatch(client, [
            { op: 'add', path: `${P}/k1`, value: 'v1' },
            { op: 'replace', path: `${P}/seed`, value: { deep: [1] } },
            { op: 'add', path: `${P}/k2`, value: 'gone' },
            { op: 'remove', path: `${P}/k2` },
        ], before.hash)
        expect(res.status).toBe(200)
        const body = await res.json() as { success: boolean; appliedOperations: number; etag: string }
        expect(body).toMatchObject({ success: true, appliedOperations: 4 })

        expect((await indexKeys(client)).keys).toEqual(['k1', 'seed'])
        expect(await readPluginKey(client, 'k1')).toBe('v1')
        expect(await readPluginKey(client, 'seed')).toEqual({ deep: [1] })
        expect(await readPluginKey(client, 'k2')).toBeNull()

        // The blob is untouched: still {} and the same hash; the returned
        // etag is the etag the next /api/read reports.
        const after = await readDbWithHash(client)
        expect(after.db.pluginCustomStorage).toEqual({})
        expect(after.hash).toBe(before.hash)
        expect(after.etag).toBe(body.etag)

        // (b) A plugin-only patch took the empty-patch path — the hash cache
        // is still valid for a normal patch with the same expectedHash.
        const normal = await sendPatch(client, [{ op: 'add', path: '/username', value: 'after-plugin' }], before.hash)
        expect(normal.status).toBe(200)
        expect((await readDbWithHash(client)).db.username).toBe('after-plugin')
        // Plugin keys survived the DB patch (they live outside the blob).
        expect((await indexKeys(client)).keys).toEqual(['k1', 'seed'])
    })

    test('(c)(d)(e) deep, move/copy and root ops on the subtree → 409, nothing written', async () => {
        const { client } = await boot()
        expect((await client.importBackup(backupWith({ a: { b: 1 } }))).ok).toBe(true)
        const { hash, etag } = await readDbWithHash(client)

        const rejected: unknown[][] = [
            [{ op: 'replace', path: `${P}/a/b`, value: 2 }],                       // (c) deep
            [{ op: 'add', path: `${P}/a/c`, value: 3 }],                           // (c) deep add
            [{ op: 'move', from: `${P}/a`, path: `${P}/z` }],                      // (d) both sides
            [{ op: 'move', from: `${P}/a`, path: '/username' }],                   // (d) from in subtree
            [{ op: 'copy', from: '/username', path: `${P}/n` }],                   // (d) path in subtree
            [{ op: 'replace', path: P, value: {} }],                               // (e) root replace
            [{ op: 'remove', path: P }],                                           // (e) root remove
            [{ op: 'test', path: `${P}/a`, value: { b: 1 } }],                     // unsupported op
            // Mixed: one accepted kv op + one rejected → whole patch rejected.
            [{ op: 'add', path: `${P}/ok`, value: 1 }, { op: 'replace', path: `${P}/a/b`, value: 2 }],
        ]
        for (const patch of rejected) {
            const res = await sendPatch(client, patch, hash)
            expect(res.status, JSON.stringify(patch)).toBe(409)
            const body = await res.json() as { code: string; currentEtag: string }
            expect(body.code).toBe('PLUGIN_STORAGE_OPS_REJECTED')
            expect(body.currentEtag).toBe(etag)
        }
        expect((await indexKeys(client)).keys).toEqual(['a'])
        expect(await readPluginKey(client, 'a')).toEqual({ b: 1 })
        const after = await readDbWithHash(client)
        expect(after.hash).toBe(hash)
        expect(after.db.username).toBeUndefined()
    })

    test('(f) a mixed patch applies the plugin op to kv and the normal op to the blob', async () => {
        const { client } = await boot()
        expect((await client.importBackup(backupWith({}))).ok).toBe(true)
        const before = await readDbWithHash(client)
        const res = await sendPatch(client, [
            { op: 'add', path: `${P}/mixed`, value: [1, 2] },
            { op: 'add', path: '/username', value: 'mixed-user' },
        ], before.hash)
        expect(res.status).toBe(200)
        const body = await res.json() as { appliedOperations: number; etag: string }
        expect(body.appliedOperations).toBe(2)

        const after = await readDbWithHash(client)
        expect(after.db.username).toBe('mixed-user')
        expect(after.db.pluginCustomStorage).toEqual({})
        expect(after.etag).toBe(body.etag)
        expect(after.hash).not.toBe(before.hash)
        expect(await readPluginKey(client, 'mixed')).toEqual([1, 2])

        // Follow-up normal patch with the post-mixed hash still syncs.
        const next = await sendPatch(client, [{ op: 'replace', path: '/username', value: 'next' }], after.hash)
        expect(next.status).toBe(200)
    })

    test('R3: a mixed patch whose DB part fails leaves kv untouched', async () => {
        const { client } = await boot()
        expect((await client.importBackup(backupWith({ keep: 'K' }))).ok).toBe(true)
        const before = await readDbWithHash(client)

        const failing: unknown[][] = [
            // Invalid op path → applyPatch throws (500).
            [{ op: 'add', path: `${P}/added`, value: 1 }, { op: 'replace', path: '/no/such/deep/path', value: 1 }],
            [{ op: 'remove', path: `${P}/keep` }, { op: 'remove', path: '/no/such/path' }],
            // Root op leaving a non-object → 400.
            [{ op: 'add', path: `${P}/added`, value: 1 }, { op: 'replace', path: '', value: 'not-an-object' }],
        ]
        for (const patch of failing) {
            const res = await sendPatch(client, patch, before.hash)
            expect(res.status, JSON.stringify(patch)).toBeGreaterThanOrEqual(400)
            expect((await indexKeys(client)).keys, JSON.stringify(patch)).toEqual(['keep'])
            expect(await readPluginKey(client, 'keep')).toBe('K')
        }
        // DB unchanged as well; a valid mixed patch still applies both halves.
        const same = await readDbWithHash(client)
        expect(same.hash).toBe(before.hash)
        const ok = await sendPatch(client, [
            { op: 'add', path: `${P}/added`, value: 1 },
            { op: 'add', path: '/username', value: 'u' },
        ], same.hash)
        expect(ok.status).toBe(200)
        expect((await indexKeys(client)).keys).toEqual(['added', 'keep'])
        expect((await readDbWithHash(client)).db.username).toBe('u')
    })
})

describe('F2: truncated backup import', () => {
    test('leaves the old database.bin and its plugin rows intact', async () => {
        const { client } = await boot()
        expect((await client.importBackup(backupWith({ keep: 'me' }))).ok).toBe(true)
        expect((await indexKeys(client)).keys).toEqual(['keep'])
        const before = await readDb(client)

        // > BATCH_SIZE (5000) asset entries so at least one batch commits
        // before the stream ends mid-entry (database.risudat last, truncated).
        const entries = []
        // Asset entries are named by basename in the .bin format.
        for (let i = 0; i < 5100; i++) entries.push({ name: `x${i}.png`, data: Buffer.from([i & 0xff]) })
        entries.push({ name: 'database.risudat', data: dbBlob({ other: 'data' }) })
        const full = encodeBackup(entries)
        const truncated = full.subarray(0, full.length - 40)

        const result = await client.importBackup(truncated)
        expect(result.ok).not.toBe(true)
        expect(result.error).toBeTruthy()

        expect((await indexKeys(client)).keys).toEqual(['keep'])
        expect(await readPluginKey(client, 'keep')).toBe('me')
        const after = await readDb(client)
        expect(after.pluginCustomStorage).toEqual({})
        expect(after.apiType).toBe(before.apiType)
        // Re-import of a valid backup still works and still fully replaces.
        expect((await client.importBackup(backupWith({ other: 'data' }))).ok).toBe(true)
        expect((await indexKeys(client)).keys).toEqual(['other'])
    })
})

describe('F3: save-folder import', () => {
    test('replaces the plugin-storage/ prefix', async () => {
        const { client } = await boot()
        expect((await client.importBackup(backupWith({ old: 1 }))).ok).toBe(true)
        await writePluginKey(client, 'old2', 2)
        expect((await indexKeys(client)).keys).toEqual(['old', 'old2'])

        // Legacy save folder: plugin data inside database.bin, no kv rows.
        const up = await client.fetch('/api/migrate/save-folder/upload', {
            method: 'POST', headers: { 'content-type': 'application/zip' },
            body: new Uint8Array(saveFolderZip({ [DB_KEY]: dbBlob({ fresh: 'F' }) })),
        })
        expect(up.status).toBe(200)
        // Old rows are gone in the import transaction itself; the blob's data
        // is split on the next cold decode (here: the /api/read).
        expect(await indexKeys(client)).toEqual({ keys: [], migrated: false })
        expect((await readDb(client)).pluginCustomStorage).toEqual({})
        expect(await indexKeys(client)).toEqual({ keys: ['fresh'], migrated: true })

        // A NodeOnly save folder that ships its own rows: those win, old ones go.
        const rowKey = `${PREFIX}${encodeKey('shipped')}`
        const up2 = await client.fetch('/api/migrate/save-folder/upload', {
            method: 'POST', headers: { 'content-type': 'application/zip' },
            body: new Uint8Array(saveFolderZip({
                [DB_KEY]: dbBlob({}),
                [rowKey]: Buffer.from('"S"'),
                [`${PREFIX}__migrated__`]: Buffer.from('{"version":1}'),
            })),
        })
        expect(up2.status).toBe(200)
        expect(await indexKeys(client)).toEqual({ keys: ['shipped'], migrated: true })
        expect(await readPluginKey(client, 'shipped')).toBe('S')
    })
})

describe('F4: full /api/write of database.bin', () => {
    test('splits a populated pluginCustomStorage into kv before persisting', async () => {
        const { client } = await boot()
        expect((await client.importBackup(backupWith({ a: 'A' }))).ok).toBe(true)
        await writePluginKey(client, 'b', 'B')

        // Stale client: full copy with its own (newer) values and a new key.
        const res = await writeKv(client, DB_KEY, dbBlob({ a: 'A-writer', n: 'N' }, { username: 'writer' }))
        expect(((await res.json()) as any).success).toBe(true)

        // DB-wins for the writer's keys; kv-only keys survive.
        expect((await indexKeys(client)).keys).toEqual(['a', 'b', 'n'])
        expect(await readPluginKey(client, 'a')).toBe('A-writer')
        expect(await readPluginKey(client, 'b')).toBe('B')
        expect(await readPluginKey(client, 'n')).toBe('N')

        // The served blob is empty and carries the rest of the write.
        const db = await readDb(client)
        expect(db.pluginCustomStorage).toEqual({})
        expect(db.username).toBe('writer')

        // The blob on disk is empty too: an export reassembles from kv and the
        // raw bytes never contained the data (a later cold decode would
        // otherwise re-migrate it over newer kv values).
        await writePluginKey(client, 'a', 'A-later')
        const db2 = await readDb(client)
        expect(db2.pluginCustomStorage).toEqual({})
        expect(await readPluginKey(client, 'a')).toBe('A-later')
    })
})

describe('GET /api/plugin-storage/all', () => {
    test('streams every value as NDJSON [key, json] rows; an empty store streams nothing', async () => {
        const { client } = await boot()
        const empty = await client.fetch('/api/plugin-storage/all')
        expect(empty.status).toBe(200)
        expect(await empty.text()).toBe('')

        await writePluginKey(client, 'plain', 'hello')
        await writePluginKey(client, 'multi\nline', { text: 'a\nb\t"c"', n: [1, 2] })
        await writePluginKey(client, '한글 키', '값')

        const res = await client.fetch('/api/plugin-storage/all')
        expect(res.status).toBe(200)
        expect(res.headers.get('content-type')).toContain('application/x-ndjson')
        const body = await res.text()
        expect(body.endsWith('\n')).toBe(true)
        const rows = body.split('\n').filter(Boolean).map(line => JSON.parse(line) as [string, string])
        const byKey = Object.fromEntries(rows.map(([k, text]) => [k, JSON.parse(text)]))
        expect(Object.keys(byKey).sort()).toEqual(['multi\nline', 'plain', '한글 키'])
        expect(byKey['multi\nline']).toEqual({ text: 'a\nb\t"c"', n: [1, 2] })
        expect(byKey['plain']).toBe('hello')
        expect(byKey['한글 키']).toBe('값')
    })

    test('rejects unauthenticated requests', async () => {
        const { srv } = await boot()
        const res = await fetch(`http://127.0.0.1:${srv.port}/api/plugin-storage/all`)
        expect(res.status).not.toBe(200)
    })
})

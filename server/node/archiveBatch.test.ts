import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { Packr } from 'msgpackr'
import { createRequire } from 'node:module'
import zlib from 'node:zlib'

const packr = new Packr({ useRecords: false })
const magicHeader = new Uint8Array([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])

function encodeRisuSaveLegacy(data: Record<string, unknown>) {
    const encoded = packr.encode(data)
    const result = new Uint8Array(encoded.length + magicHeader.length)
    result.set(magicHeader, 0)
    result.set(encoded, magicHeader.length)
    return result
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER_PATH = path.join(HERE, 'server.cjs')
const DAY = 24 * 60 * 60 * 1000

let tmpDir: string
let port: number
let base: string
let child: ChildProcessWithoutNullStreams
let token: string
let stdout = ''
let stderr = ''

function hexKey(key: string) {
    return Buffer.from(key, 'utf-8').toString('hex')
}

function jwt(secret: string) {
    const now = Math.floor(Date.now() / 1000)
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ iat: now, exp: now + 300 })).toString('base64url')
    const sig = crypto.createHmac('sha256', secret)
        .update(`${header}.${payload}`)
        .digest('base64url')
    return `${header}.${payload}.${sig}`
}

function reservePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer()
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
            const nextPort = (server.address() as net.AddressInfo).port
            server.close(() => resolve(nextPort))
        })
    })
}

async function waitForServer() {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`server exited early\nstdout:\n${stdout}\nstderr:\n${stderr}`)
        }
        try {
            const res = await fetch(`${base}/api/test_auth`)
            if (res.ok) return
        } catch {
            // not listening yet
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`server did not start\nstdout:\n${stdout}\nstderr:\n${stderr}`)
}

async function stopServer() {
    if (!child || child.exitCode !== null) return
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.kill('SIGTERM')
    await Promise.race([
        exited,
        new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ])
    if (child.exitCode === null) child.kill('SIGKILL')
}

function authHeaders(): Record<string, string> {
    return {
        'risu-auth': token,
        'x-session-id': 'archive-batch-test-session',
    }
}

async function writeKey(key: string, value: Uint8Array | Buffer | string) {
    const body = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value)
    const res = await fetch(`${base}/api/write`, {
        method: 'POST',
        headers: {
            ...authHeaders(),
            'file-path': hexKey(key),
            'content-type': 'application/octet-stream',
        },
        body: body as any,
    })
    expect(res.status).toBe(200)
}

async function readKey(key: string) {
    const res = await fetch(`${base}/api/read`, {
        method: 'GET',
        headers: {
            ...authHeaders(),
            'file-path': hexKey(key),
        },
    })
    expect(res.status).toBe(200)
    return new Uint8Array(await res.arrayBuffer())
}

async function removeKey(key: string) {
    return fetch(`${base}/api/remove`, {
        method: 'GET',
        headers: {
            ...authHeaders(),
            'file-path': hexKey(key),
        },
    })
}

async function autoSweep(assets: boolean) {
    return fetch(`${base}/api/db/assets/auto-sweep`, {
        method: 'POST',
        headers: {
            ...authHeaders(),
            'content-type': 'application/json',
        },
        body: JSON.stringify({ assets }),
    })
}

function withDb<T>(fn: (db: any) => T): T {
    const db = new Database(path.join(tmpDir, 'save', 'risuai.db'))
    db.pragma('busy_timeout = 5000')
    try {
        return fn(db)
    } finally {
        db.close()
    }
}

function setUpdatedAt(key: string, updatedAt: number) {
    withDb((db) => {
        db.prepare('UPDATE kv SET updated_at = ? WHERE key = ?').run(updatedAt, key)
    })
}

function hasKey(key: string) {
    return withDb((db) => {
        const row = db.prepare('SELECT 1 AS ok FROM kv WHERE key = ?').get(key)
        return Boolean(row)
    })
}

async function seedDb(db: Record<string, unknown>) {
    await writeKey('database/database.bin', encodeRisuSaveLegacy(db))
}

async function seedReferencedDb() {
    await seedDb({
        characters: [{ chaId: 'keep', image: 'assets/live.png', chats: [] }],
    })
}

let extraEnv: Record<string, string> = {}

async function startServer() {
    port = await reservePort()
    base = `http://127.0.0.1:${port}`
    stdout = ''
    stderr = ''
    child = spawn(process.execPath, [SERVER_PATH], {
        cwd: tmpDir,
        env: {
            ...process.env,
            PORT: String(port),
            RISU_TUNNEL_DISABLED: 'true',
            RISU_UPDATE_CHECK: 'false',
            ...extraEnv,
            POCKETRISU_BACKUP_INTERVAL_MS: String(60 * 60 * 1000),
        },
    })
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    await waitForServer()
    const secret = fs.readFileSync(path.join(tmpDir, 'save', '__jwt_secret'), 'utf-8').trim()
    token = jwt(secret)
}

async function restartServer() {
    await stopServer()
    await startServer()
}

beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-batch-test-'))
    await startServer()
})

afterEach(async () => {
    await stopServer()
    fs.rmSync(tmpDir, { recursive: true, force: true })
})


const utils = createRequire(import.meta.url)('./utils.cjs')
const PRELOAD = fileURLToPath(new URL('../../test/compat/helpers/fail-db-persist-preload.cjs', import.meta.url))

async function diskDb(): Promise<any> {
    const raw = withDb((db) => db.prepare('SELECT value FROM kv WHERE key = ?').get('database/database.bin'))
    return utils.normalizeJSON(await utils.decodeRisuSave(Buffer.from(raw.value)))
}
async function clientView(): Promise<any> {
    return utils.normalizeJSON(await utils.decodeRisuSave(Buffer.from(await readKey('database/database.bin'))))
}
function batch(chaIds: unknown, acceptLostChats?: boolean) {
    return fetch(`${base}/api/characters/archive-batch`, {
        method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ chaIds, acceptLostChats }),
    })
}
async function patch(ops: unknown[]) {
    const view = await clientView()
    return fetch(`${base}/api/patch`, {
        method: 'POST',
        headers: { ...authHeaders(), 'content-type': 'application/json', 'file-path': hexKey('database/database.bin') },
        body: JSON.stringify({ patch: ops, expectedHash: utils.calculateHash(view).toString(16) }),
    })
}
const chat = (id: string, text: string) => ({ id, name: text, localLore: [], note: '', message: [{ role: 'user', data: text }] })
const char = (chaId: string, chats: unknown[]) => ({ chaId, name: `Name ${chaId}`, type: 'character', image: '', chats, chatPage: 0 })
const archiveKeys = () => withDb((db) => db.prepare("SELECT key FROM kv WHERE key LIKE 'archive/%'").all().map((r: any) => r.key))

describe('/api/characters/archive-batch', () => {
    it('writes a verified row per character and reports each outcome', async () => {
        await seedDb({
            characters: [char('a', [chat('a1', 'A')]), char('b', [chat('b1', 'B')]), char('lost', [chat('l1', 'L'), { id: 'gone', name: 'Gone', _stub: true }])],
            characterOrder: ['a', 'b', 'lost'],
        })
        await readKey('database/database.bin')
        const res = await batch(['a', 'missing', 'b', 'lost', 'bad/id'])
        expect(res.status).toBe(200)
        const { results } = await res.json() as any
        expect(results.map((r: any) => [r.chaId, r.ok, r.code])).toEqual([
            ['a', true, undefined],
            ['missing', false, 'ARCHIVE_CHARACTER_NOT_FOUND'],
            ['b', true, undefined],
            ['lost', false, 'ARCHIVE_CHATS_UNAVAILABLE'],
            ['bad/id', false, 'ARCHIVE_BAD_ID'],
        ])
        expect(results[0].stub).toMatchObject({ chaId: 'a', chatCount: 1 })
        expect(results[3].chats).toEqual(['Gone'])
        // Rows only; moving the characters is the client's save.
        expect(archiveKeys().sort()).toEqual([`archive/a/${results[0].stub.archivedAt}`, `archive/b/${results[2].stub.archivedAt}`].sort())
        expect((await clientView()).characters.map((c: any) => c.chaId)).toEqual(['a', 'b', 'lost'])

        const accepted = await (await batch(['lost'], true)).json() as any
        expect(accepted.results[0]).toMatchObject({ chaId: 'lost', ok: true })
    }, 20_000)

    it('rejects a malformed request as a whole', async () => {
        await seedDb({ characters: [char('a', [])], characterOrder: ['a'] })
        for (const bad of [[], 'a', ['a', 'a'], [1], Array.from({ length: 101 }, (_, i) => `c${i}`)]) {
            const res = await batch(bad)
            expect(res.status).toBe(400)
            expect((await res.json() as any).code).toBe('ARCHIVE_BAD_BATCH')
        }
    })

    // Rows wait for the client's save to be referenced; a purge in between
    // must not take them (a bulk run keeps them waiting for a whole chunk).
    it('rows just written survive an orphan purge until they are old', async () => {
        await seedDb({ characters: [char('a', [chat('a1', 'A')])], characterOrder: ['a'] })
        await readKey('database/database.bin')
        expect((await (await batch(['a'])).json() as any).results[0].ok).toBe(true)
        const purge = await fetch(`${base}/api/db/archive/purge-orphans`, { method: 'POST', headers: authHeaders() })
        expect(await purge.json()).toMatchObject({ ok: true, deleted: 0, metas: 0 })
        expect(archiveKeys()).toHaveLength(1)
    })
})

describe('a failed database persist', () => {
    // It used to drop its timer: nothing wrote the change again until the
    // next edit, and a restart in between lost it.
    it('is retried until the change reaches disk', async () => {
        await stopServer()
        extraEnv = { NODE_OPTIONS: `--require ${JSON.stringify(PRELOAD)}`, POCKETRISU_PERSIST_RETRY_MS: '1000' }
        try {
            await startServer()
            await seedDb({ characters: [char('a', [chat('a1', 'A')])], characterOrder: ['a'] })
            fs.writeFileSync(path.join(tmpDir, 'fail-db-persist'), '')
            expect((await patch([{ op: 'replace', path: '/characters/0/name', value: 'Renamed' }])).status).toBe(200)
            await new Promise((resolve) => setTimeout(resolve, 6500)) // debounced persist runs and fails
            expect(stdout + stderr).toContain('injected database.bin persist failure')
            expect((await diskDb()).characters[0].name).toBe('Name a')

            fs.rmSync(path.join(tmpDir, 'fail-db-persist'))
            await new Promise((resolve) => setTimeout(resolve, 2500)) // no further edit
            expect((await diskDb()).characters[0].name).toBe('Renamed')
        } finally {
            extraEnv = {}
        }
    }, 30_000)
})

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// /hub-proxy is reachable without auth, so it must only ever talk to the hub:
// a request may not pick its own target, the hub may not send the server
// elsewhere, and the browser's credentials for this server stay here.

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER_PATH = path.join(HERE, 'server.cjs')

// Preloaded into the server: answers fetches to the hub itself (no network)
// and passes every other fetch through untouched. Like the real fetch, it
// follows redirects unless the caller asked for redirect: 'manual'.
const FAKE_HUB = `
const realFetch = globalThis.fetch
function hubResponse(url, init) {
    switch (url.pathname) {
        case '/echo':
            return Response.json({ path: url.pathname, headers: Object.fromEntries(new Headers(init.headers)) })
        case '/redirect-out':
            return new Response(null, { status: 302, headers: { location: process.env.FAKE_HUB_OUTSIDE_URL } })
        case '/redirect-in':
            return new Response(null, { status: 302, headers: { location: '/landed' } })
        case '/landed':
            return new Response('landed')
        default:
            return new Response('not found', { status: 404 })
    }
}
globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin !== 'https://sv.risuai.xyz') return realFetch(input, init)
    const res = hubResponse(url, init)
    const redirect = init.redirect ?? (input instanceof Request ? input.redirect : 'follow')
    if (res.status >= 300 && res.status < 400 && redirect !== 'manual') {
        return globalThis.fetch(new URL(res.headers.get('location'), url), { ...init, redirect })
    }
    return res
}
`

let tmpDir: string
let base: string
let child: ChildProcessWithoutNullStreams
let outside: http.Server
let outsideURL: string
let outsideHits = 0
let stdout = ''
let stderr = ''

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

beforeAll(async () => {
    // Stands for anything that is not the hub (an internal service, metadata endpoint…).
    outside = http.createServer((req, res) => {
        outsideHits++
        res.end('internal-secret')
    })
    await new Promise<void>((resolve) => outside.listen(0, '127.0.0.1', resolve))
    outsideURL = `http://127.0.0.1:${(outside.address() as net.AddressInfo).port}/secret`

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-proxy-test-'))
    const fakeHubPath = path.join(tmpDir, 'fake-hub.cjs')
    fs.writeFileSync(fakeHubPath, FAKE_HUB)
    const port = await reservePort()
    base = `http://127.0.0.1:${port}`
    child = spawn(process.execPath, ['--require', fakeHubPath, SERVER_PATH], {
        cwd: tmpDir,
        env: {
            ...process.env,
            PORT: String(port),
            RISU_TUNNEL_DISABLED: 'true',
            RISU_UPDATE_CHECK: 'false',
            POCKETRISU_BACKUP_INTERVAL_MS: String(60 * 60 * 1000),
            FAKE_HUB_OUTSIDE_URL: outsideURL,
        },
    })
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    await waitForServer()
}, 30_000) // longer than waitForServer, so a slow start fails with its own message

beforeEach(() => {
    outsideHits = 0
})

afterAll(async () => {
    await stopServer()
    await new Promise<void>((resolve) => outside.close(() => resolve()))
    fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('/hub-proxy', () => {
    it('ignores x-risu-node-path and only fetches the hub', async () => {
        const res = await fetch(`${base}/hub-proxy/echo`, {
            headers: { 'x-risu-node-path': encodeURIComponent(outsideURL) },
        })
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.path).toBe('/echo')
        expect(body.headers['x-risu-node-path']).toBeUndefined()
        expect(outsideHits).toBe(0)
    })

    it('keeps the session cookie and risu-auth away from the hub', async () => {
        const res = await fetch(`${base}/hub-proxy/echo`, {
            headers: {
                cookie: 'risu-session=local-session',
                'risu-auth': 'local-token',
                'x-risuai-info': 'kept',
            },
        })
        expect(res.status).toBe(200)
        const { headers } = await res.json()
        expect(headers.cookie).toBeUndefined()
        expect(headers['risu-auth']).toBeUndefined()
        expect(headers['x-risuai-info']).toBe('kept')
        expect(headers.origin).toBe('https://sv.risuai.xyz')
    })

    it('refuses a hub redirect to another origin without following it', async () => {
        const res = await fetch(`${base}/hub-proxy/redirect-out`, { redirect: 'manual' })
        expect(res.status).toBe(502)
        expect(res.headers.get('location')).toBeNull()
        const body = await res.text()
        expect(body).toContain('Hub redirected to a different origin')
        expect(body).not.toContain('internal-secret')
        expect(outsideHits).toBe(0)
    })

    it('follows a hub redirect that stays on the hub', async () => {
        const res = await fetch(`${base}/hub-proxy/redirect-in`, { redirect: 'manual' })
        expect(res.status).toBe(200)
        expect(await res.text()).toBe('landed')
    })
})

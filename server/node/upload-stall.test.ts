import { afterEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import pkg from './upload-stall.cjs'

const { watchUploadStall } = pkg as {
    watchUploadStall: (req: http.IncomingMessage, stallMs: number) => { received: () => void, stop: () => void }
}

const STALL_MS = 300
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
function busyWait(ms: number) {
    const until = Date.now() + ms
    while (Date.now() < until) { /* blocks the event loop like a long sqlite step */ }
}

let server: http.Server | null = null
afterEach(() => {
    server?.closeAllConnections()
    server?.close()
    server = null
})

// Serves one upload: the handler reads it like the backup routes do, marking
// each chunk it takes, and onChunk(index) runs after each one. Resolves with
// how the upload ended on the server.
function serveUpload(onChunk: (index: number) => Promise<void> | void) {
    let settle: (outcome: string) => void = () => {}
    const outcome = new Promise<string>((resolve) => { settle = resolve })
    server = http.createServer(async (req, res) => {
        const stall = watchUploadStall(req, STALL_MS)
        try {
            let index = 0
            for await (const _chunk of req) {
                stall.received()
                await onChunk(index++)
            }
            res.end('ok')
            settle('completed')
        } catch (error) {
            settle((error as Error).message)
        } finally {
            stall.stop()
        }
    })
    return new Promise<{ port: number, outcome: Promise<string> }>((resolve) => {
        server!.listen(0, '127.0.0.1', () => resolve({ port: (server!.address() as AddressInfo).port, outcome }))
    })
}

function upload(port: number) {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/' })
    req.on('error', () => {})
    return req
}

describe('watchUploadStall', () => {
    it('cuts off an upload whose client sends nothing more', async () => {
        const { port, outcome } = await serveUpload(() => {})
        const req = upload(port)
        req.write(Buffer.alloc(1024))
        // …and nothing more, never ending: the client vanished.
        await expect(outcome).resolves.toBe('Backup upload stalled')
    })

    it('keeps a slow but live upload', async () => {
        const { port, outcome } = await serveUpload(() => {})
        const req = upload(port)
        for (let i = 0; i < 8; i++) {
            req.write(Buffer.alloc(1024))
            await sleep(STALL_MS / 2)
        }
        req.end()
        await expect(outcome).resolves.toBe('completed')
    })

    // The server stops reading while it works through a part of the backup;
    // the client's bytes wait in the buffers meanwhile.
    it('keeps the upload while the server is busy and not reading', async () => {
        const { port, outcome } = await serveUpload(async (index) => {
            if (index === 0) await sleep(STALL_MS * 4)
        })
        const req = upload(port)
        req.write(Buffer.alloc(64 * 1024))
        await sleep(50)
        req.write(Buffer.alloc(64 * 1024))
        req.end()
        await expect(outcome).resolves.toBe('completed')
    })

    // A synchronous step blocks the event loop past the stall time. When it
    // ends, the watchdog's timer runs before the socket is read again, with
    // the request buffer empty and the new bytes still on the socket.
    it('keeps the upload after a long synchronous step', async () => {
        let req: http.ClientRequest
        const { port, outcome } = await serveUpload((index) => {
            if (index !== 0) return
            req.write(Buffer.alloc(1024))
            busyWait(STALL_MS * 3)
            setTimeout(() => req.end(), STALL_MS / 2)
        })
        req = upload(port)
        req.write(Buffer.alloc(1024))
        await expect(outcome).resolves.toBe('completed')
    })
})

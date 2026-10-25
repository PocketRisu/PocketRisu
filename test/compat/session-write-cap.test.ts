/**
 * Long writes and the session lock, through the real server:
 * - a backup import is never released by the session write cap (it replaces
 *   the data outside the storage queue), so a page booting meanwhile waits;
 * - a stalled upload is cut off instead, so it cannot hold every page boot
 *   back for ever;
 * - a claim refused because earlier writes did not land in time gives the
 *   lock back to the holder it replaced.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'

let srv: ServerHandle
let client: RisuClient

beforeAll(async () => {
  srv = await spawnServer({ env: { POCKETRISU_SESSION_WRITE_MAX_MS: '200', POCKETRISU_BACKUP_UPLOAD_STALL_MS: '1500' } })
  client = await createClient(srv.port, srv.password)
})

afterAll(async () => {
  await srv?.cleanup()
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function boot(sessionId: string) {
  const res = await client.fetch('/api/session', { method: 'POST', headers: { 'x-session-id': sessionId } })
  expect(res.status).toBe(200)
}

function write(sessionId: string, userActive = false) {
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream',
    'file-path': Buffer.from('test/session-write-cap.txt').toString('hex'),
    'x-session-id': sessionId,
  }
  if (userActive) headers['x-user-active'] = '1'
  return client.fetch('/api/write', { method: 'POST', headers, body: new Uint8Array(Buffer.from('x')) })
}

async function lockState(sessionId: string) {
  const res = await client.fetch('/api/session/lock-status', { headers: { 'x-session-id': sessionId } })
  return ((await res.json()) as { state: string }).state
}

// Starts a backup import whose upload is fed by `feed`, which gets the
// backup bytes and the stream controller.
async function startImport(sessionId: string, feed: (backup: Buffer, controller: ReadableStreamDefaultController<Uint8Array>) => Promise<void>) {
  const backup = createSeedBackup({ characterCount: 1, messagesPerChat: 2 })
  const prep = await client.fetch('/api/backup/import/prepare', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ size: backup.byteLength }),
  })
  expect(prep.ok).toBe(true)
  const body = new ReadableStream<Uint8Array>({ start: (controller) => { void feed(backup, controller) } })
  return client.fetch('/api/backup/import', {
    method: 'POST',
    headers: { 'content-type': 'application/x-risu-backup', 'x-session-id': sessionId },
    body,
    duplex: 'half',
  } as RequestInit)
}

describe('long writes and the session lock', () => {
  test('a backup import past the cap still holds a booting page back until it lands', async () => {
    await boot('home')
    expect((await write('home', true)).status).toBe(200)

    let resume: () => void = () => {}
    const resumed = new Promise<void>((resolve) => { resume = resolve })
    const importing = startImport('home', async (backup, controller) => {
      const half = Math.floor(backup.byteLength / 2)
      controller.enqueue(new Uint8Array(backup.subarray(0, half)))
      await resumed
      controller.enqueue(new Uint8Array(backup.subarray(half)))
      controller.close()
    })

    await sleep(500)                                     // well past the 200 ms cap
    let booted = false
    const booting = boot('late').then(() => { booted = true })
    await sleep(400)
    expect(booted).toBe(false)                           // still waiting for the import

    resume()
    const res = await importing
    expect(res.status).toBe(200)
    await res.text()
    await booting
    expect(await lockState('late')).toBe('fresh')        // it read the imported data
    expect((await write('late', true)).status).toBe(200)
  })

  test('a stalled upload is cut off and stops holding boots back', async () => {
    await boot('home-2')
    expect((await write('home-2', true)).status).toBe(200)

    const importing = startImport('home-2', async (backup, controller) => {
      controller.enqueue(new Uint8Array(backup.subarray(0, Math.floor(backup.byteLength / 2))))
      // …and nothing more: the client vanished.
    }).then((res) => res.text().then(() => res.status), () => 'cut off')
    expect(await importing).not.toBe(200)

    const startedAt = Date.now()
    await boot('late-2')
    expect(Date.now() - startedAt).toBeLessThan(2000)
    const prep = await client.fetch('/api/backup/import/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ size: 1 }),
    })
    expect(prep.ok).toBe(true)                           // the import slot is free again
  })

  test('a claim refused because earlier writes did not land gives the lock back', async () => {
    await boot('home-3')
    expect((await write('home-3', true)).status).toBe(200)

    // A slow but live upload: bytes keep coming, so it is never cut off.
    let done = false
    const importing = startImport('home-3', async (backup, controller) => {
      const step = Math.ceil(backup.byteLength / 40)
      for (let at = 0; at < backup.byteLength; at += step) {
        controller.enqueue(new Uint8Array(backup.subarray(at, Math.min(at + step, backup.byteLength))))
        await sleep(done ? 0 : 400)
      }
      controller.close()
    })

    await sleep(300)
    const claim = await client.fetch('/api/session/claim', { method: 'POST', headers: { 'x-session-id': 'phone-next-3' } })
    expect(claim.status).toBe(503)
    expect(await lockState('home-3')).toBe('active')
    expect((await write('home-3')).status).toBe(200)

    done = true
    const res = await importing
    expect(res.status).toBe(200)
    await res.text()
  })
})

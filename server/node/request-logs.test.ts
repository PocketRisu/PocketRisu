import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import pkg from './request-logs.cjs'

const { createRequestLogs, truncateBody, truncateTail, dayKey } = pkg as {
    createRequestLogs: (opts: Record<string, unknown>) => any
    truncateBody: (v: string, max: number) => { text: string; truncated: boolean }
    truncateTail: (v: string, max: number) => { text: string; truncated: boolean }
    dayKey: (ts: number) => string
}

let tmpDir: string
let logs: any

function entry(overrides: Record<string, unknown> = {}) {
    return {
        timestamp: Date.now(),
        category: 'llm',
        source: 'main',
        url: 'https://api.example.com/v1/chat/completions',
        method: 'POST',
        status: 200,
        success: true,
        streaming: true,
        route: 'proxy',
        model: 'gpt-test',
        provider: 'openai',
        durationMs: 1200,
        inputTokens: 100,
        outputTokens: 50,
        requestBody: '{"messages":[]}',
        responseBody: 'hello',
        ...overrides,
    }
}

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reqlogs-'))
    logs = createRequestLogs({ saveDir: tmpDir })
})

afterEach(() => {
    logs?.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('truncation', () => {
    it('keeps head and tail of an oversized request body', () => {
        const head = 'H'.repeat(100)
        const middle = 'M'.repeat(1000)
        const tail = 'T'.repeat(100)
        const { text, truncated } = truncateBody(head + middle + tail, 200)
        expect(truncated).toBe(true)
        expect(text.startsWith('H')).toBe(true)
        expect(text.endsWith('T')).toBe(true)
        expect(text).toContain('KB omitted')
        // Middle is gone: the marker replaced it, so no full run of M survives.
        expect(text).not.toContain(middle)
    })

    it('leaves a body under the cap untouched', () => {
        const { text, truncated } = truncateBody('short', 1000)
        expect(truncated).toBe(false)
        expect(text).toBe('short')
    })

    it('cuts a response from the tail with a marker', () => {
        const { text, truncated } = truncateTail('A'.repeat(500), 100)
        expect(truncated).toBe(true)
        expect(text.endsWith('...[truncated]')).toBe(true)
    })
})

describe('insert and query', () => {
    it('writes a request row and a matching usage row', () => {
        expect(logs.addRequestLogBatch([entry()])).toBe(1)

        const rows = logs.queryRequestLogs({})
        expect(rows).toHaveLength(1)
        expect(rows[0].model).toBe('gpt-test')
        expect(rows[0].source).toBe('main')
        expect(rows[0].success).toBe(true)

        const usage = logs.queryUsage({})
        expect(usage.total.requests).toBe(1)
        expect(usage.total.inputTokens).toBe(100)
        expect(usage.total.outputTokens).toBe(50)
        expect(usage.byModel[0].model).toBe('gpt-test')
        expect(usage.bySource[0].source).toBe('main')
    })

    it('omits bodies from the list view but serves them on the detail view', () => {
        logs.addRequestLogBatch([entry()])
        const [listRow] = logs.queryRequestLogs({})
        expect(listRow.requestBody).toBeUndefined()

        const detail = logs.getRequestLog(listRow.id)
        expect(detail.requestBody).toBe('{"messages":[]}')
        expect(detail.responseBody).toBe('hello')
    })

    it('rejects entries without a url', () => {
        expect(logs.addRequestLogBatch([{ category: 'llm' }])).toBe(0)
        expect(logs.queryRequestLogs({})).toHaveLength(0)
    })

    it('falls back to safe defaults for unknown category and source', () => {
        logs.addRequestLogBatch([entry({ category: 'bogus', source: 'nope' })])
        const [row] = logs.queryRequestLogs({})
        expect(row.category).toBe('other')
        expect(row.source).toBe('other')
    })
})

describe('masking', () => {
    it('redacts api keys and bearer tokens before persisting', () => {
        logs.addRequestLogBatch([entry({
            requestHeaders: '{"authorization":"Bearer sk-ant-abcdefghijklmnopqrstuvwxyz012345"}',
            requestBody: '{"key":"sk-abcdefghijklmnopqrstuvwxyz012345"}',
        })])
        const [row] = logs.queryRequestLogs({})
        const detail = logs.getRequestLog(row.id)
        expect(detail.requestHeaders).not.toContain('sk-ant-')
        expect(detail.requestHeaders).toContain('REDACTED')
        expect(detail.requestBody).not.toContain('sk-abcdefghijklmnopqrstuvwxyz')
        expect(detail.requestBody).toContain('REDACTED')
    })
})

describe('filters', () => {
    beforeEach(() => {
        logs.addRequestLogBatch([
            entry({ category: 'llm', source: 'main', chatId: 'chat-1', success: true }),
            entry({ category: 'llm', source: 'translate', chatId: 'chat-2', success: false }),
            entry({ category: 'tts', source: 'tts', chatId: 'chat-3', success: true }),
        ])
    })

    it('filters by category', () => {
        expect(logs.queryRequestLogs({ categories: ['llm'] })).toHaveLength(2)
        expect(logs.countRequestLogs({ categories: ['llm'] })).toBe(2)
    })

    it('filters by source', () => {
        const rows = logs.queryRequestLogs({ sources: ['translate'] })
        expect(rows).toHaveLength(1)
        expect(rows[0].chatId).toBe('chat-2')
    })

    it('filters by chat id — the per-message log lookup', () => {
        const rows = logs.queryRequestLogs({ chatId: 'chat-1' })
        expect(rows).toHaveLength(1)
        expect(rows[0].source).toBe('main')
    })

    it('filters by success and failure', () => {
        expect(logs.queryRequestLogs({ successOnly: true })).toHaveLength(2)
        expect(logs.queryRequestLogs({ failedOnly: true })).toHaveLength(1)
    })

    it('paginates by id cursor without repeating rows', () => {
        const first = logs.queryRequestLogs({ limit: 2 })
        expect(first).toHaveLength(2)
        const second = logs.queryRequestLogs({ limit: 2, beforeId: first[1].id })
        expect(second).toHaveLength(1)
        expect(second[0].id).toBeLessThan(first[1].id)
    })
})

describe('rotation by byte budget', () => {
    it('drops the oldest rows once the total exceeds the budget', () => {
        const rotating = createRequestLogs({
            saveDir: path.join(tmpDir, 'rot'),
            maxTotalBytes: 10_000,
            minRows: 2,
            rotateEveryNRows: 1,
        })
        try {
            // Each row carries ~2KB of body, so 10 rows blow past a 10KB budget.
            for (let i = 0; i < 10; i++) {
                rotating.addRequestLogBatch([entry({ requestBody: 'X'.repeat(2000), model: `m${i}` })])
            }
            const rows = rotating.queryRequestLogs({ limit: 100 })
            expect(rows.length).toBeLessThan(10)
            expect(rows.length).toBeGreaterThanOrEqual(2)
            // Survivors are the newest ones.
            expect(rows[0].model).toBe('m9')

            // Usage rows are never rotated — the statistics outlive the bodies.
            expect(rotating.queryUsage({}).total.requests).toBe(10)
        } finally {
            rotating.close()
        }
    })

    it('keeps at least minRows even when every row exceeds the budget', () => {
        const rotating = createRequestLogs({
            saveDir: path.join(tmpDir, 'rot2'),
            maxTotalBytes: 100,
            minRows: 3,
            rotateEveryNRows: 1,
        })
        try {
            for (let i = 0; i < 6; i++) {
                rotating.addRequestLogBatch([entry({ requestBody: 'Y'.repeat(5000) })])
            }
            expect(rotating.queryRequestLogs({ limit: 100 })).toHaveLength(3)
        } finally {
            rotating.close()
        }
    })
})

describe('usage aggregation', () => {
    it('groups per day using the local calendar day', () => {
        const t = new Date(2026, 6, 20, 10, 0, 0).getTime()
        logs.addRequestLogBatch([
            entry({ timestamp: t, inputTokens: 10, outputTokens: 1 }),
            entry({ timestamp: t + 3600_000, inputTokens: 20, outputTokens: 2 }),
            entry({ timestamp: t + 86400_000, inputTokens: 30, outputTokens: 3 }),
        ])
        const { daily } = logs.queryUsage({})
        expect(daily).toHaveLength(2)
        expect(daily[0].day).toBe(dayKey(t))
        expect(daily[0].requests).toBe(2)
        expect(daily[0].inputTokens).toBe(30)
        expect(daily[1].inputTokens).toBe(30)
    })

    it('splits totals per model and reports failures', () => {
        logs.addRequestLogBatch([
            entry({ model: 'a', inputTokens: 10, outputTokens: 5 }),
            entry({ model: 'a', inputTokens: 10, outputTokens: 5 }),
            entry({ model: 'b', inputTokens: 1, outputTokens: 1, success: false }),
        ])
        const { total, byModel } = logs.queryUsage({})
        expect(total.requests).toBe(3)
        expect(total.failed).toBe(1)
        expect(byModel[0].model).toBe('a')
        expect(byModel[0].requests).toBe(2)
        expect(byModel[0].inputTokens).toBe(20)
    })

    it('respects a time window', () => {
        const t = Date.now()
        logs.addRequestLogBatch([
            entry({ timestamp: t - 86400_000 * 5, inputTokens: 100 }),
            entry({ timestamp: t, inputTokens: 7 }),
        ])
        const recent = logs.queryUsage({ since: t - 3600_000 })
        expect(recent.total.requests).toBe(1)
        expect(recent.total.inputTokens).toBe(7)
    })

    it('exposes the distinct dimensions for filter chips', () => {
        // Dimensions come from the usage table, which holds LLM rows only —
        // the tts row below is in the request log but not in the statistics.
        logs.addRequestLogBatch([
            entry({ model: 'a', source: 'main', category: 'llm' }),
            entry({ model: 'b2', source: 'translate', category: 'llm' }),
            entry({ model: 'c', source: 'tts', category: 'tts' }),
        ])
        const dims = logs.usageDimensions()
        expect(dims.models).toEqual(['a', 'b2'])
        expect(dims.categories).toEqual(['llm'])
        expect(dims.sources.sort()).toEqual(['main', 'translate'])
    })

    it('counts tokens as zero when the provider reported none', () => {
        logs.addRequestLogBatch([entry({ inputTokens: undefined, outputTokens: undefined })])
        const { total } = logs.queryUsage({})
        expect(total.inputTokens).toBe(0)
        expect(total.outputTokens).toBe(0)
    })
})

describe('clearing', () => {
    it('wipes request bodies but keeps usage statistics by default', () => {
        logs.addRequestLogBatch([entry()])
        logs.clearRequestLogs()
        expect(logs.queryRequestLogs({})).toHaveLength(0)
        expect(logs.queryUsage({}).total.requests).toBe(1)
    })

    it('wipes usage too when asked explicitly', () => {
        logs.addRequestLogBatch([entry()])
        logs.clearRequestLogs()
        logs.clearUsage()
        expect(logs.queryUsage({}).total.requests).toBe(0)
    })
})

describe('storage stats', () => {
    it('reports row count and byte total', () => {
        logs.addRequestLogBatch([entry({ requestBody: 'Z'.repeat(1000) })])
        const stats = logs.storageStats()
        expect(stats.requestCount).toBe(1)
        expect(stats.requestBytes).toBeGreaterThan(1000)
        expect(stats.usageCount).toBe(1)
    })
})

describe('url masking', () => {
    it('redacts an api key carried in the query string', () => {
        // Gemini's classic path puts the key in the URL, so an unmasked url
        // column is a cleartext credential on disk.
        logs.addRequestLogBatch([entry({
            url: 'https://generativelanguage.googleapis.com/v1beta/models/x:generateContent?key=AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456',
        })])
        const [row] = logs.queryRequestLogs({})
        expect(row.url).not.toContain('AIzaSy')
        expect(row.url).toContain('REDACTED')
        expect(row.url).toContain('generativelanguage.googleapis.com')
    })

    it('re-masks urls written before the column was masked', () => {
        // Simulate a row from the leaky build by writing straight to the table.
        const dbFile = path.join(tmpDir, 'request-logs.db')
        expect(fs.existsSync(dbFile)).toBe(true)
        logs.addRequestLogBatch([entry()])
        logs.close()

        const Database = require('better-sqlite3')
        const raw = new Database(dbFile)
        raw.prepare(`UPDATE requests SET url = ?`).run(
            'https://x.test/v1?key=AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456',
        )
        raw.close()

        // Reopening runs the startup backfill.
        logs = createRequestLogs({ saveDir: tmpDir })
        const [row] = logs.queryRequestLogs({})
        expect(row.url).not.toContain('AIzaSy')
        expect(row.url).toContain('REDACTED')
    })
})

describe('restart safety', () => {
    it('enforces the byte budget even when restarts reset the insert counter', () => {
        const dir = path.join(tmpDir, 'restarts')
        // rotateEveryNRows is never reached within a single "session", so
        // without a startup sweep the budget would never be enforced at all.
        const open = () => createRequestLogs({
            saveDir: dir, maxTotalBytes: 20_000, minRows: 2, rotateEveryNRows: 100,
        })
        for (let i = 0; i < 8; i++) {
            const inst = open()
            inst.addRequestLogBatch([entry({ requestBody: 'X'.repeat(5000), model: `m${i}` })])
            inst.close()
        }
        const final = open()
        try {
            const rows = final.queryRequestLogs({ limit: 100 })
            expect(rows.length).toBeLessThan(8)
            const totalBytes = rows.reduce((n, r) => n + (r.sizeBytes ?? 0), 0)
            expect(totalBytes).toBeLessThanOrEqual(20_000)
        } finally {
            final.close()
        }
    })
})

describe('usage table scope', () => {
    it('counts llm requests only', () => {
        // The usage table is never rotated, so non-token traffic (TTS, images,
        // polling) would permanently inflate the request count.
        logs.addRequestLogBatch([
            entry({ category: 'llm', inputTokens: 10, outputTokens: 5 }),
            entry({ category: 'tts', source: 'tts', inputTokens: undefined, outputTokens: undefined }),
            entry({ category: 'image', source: 'image' }),
        ])
        // All three are still visible in the request log itself.
        expect(logs.queryRequestLogs({})).toHaveLength(3)
        // Only the LLM one reaches the statistics.
        const { total } = logs.queryUsage({})
        expect(total.requests).toBe(1)
        expect(total.inputTokens).toBe(10)
    })
})

// ─── HTTP routes ─────────────────────────────────────────────────────────────
// Exercises the same wiring server.cjs uses (registerRoutes + auth guard), so
// the query-string parsing and route ordering are covered end to end rather
// than only at the module boundary.
describe('routes', () => {
    let appServer: http.Server
    let base: string
    let routed: any
    let routeDir: string

    const AUTH_TOKEN = 'test-token'

    async function stubAuth(req: any, res: any) {
        if (req.headers['risu-auth'] === AUTH_TOKEN) return true
        res.status(400).send({ error: 'No auth header' })
        return false
    }

    function get(path: string) {
        return fetch(`${base}${path}`, { headers: { 'risu-auth': AUTH_TOKEN } })
    }

    beforeEach(async () => {
        routeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reqlogs-routes-'))
        routed = createRequestLogs({ saveDir: routeDir })
        const app = express()
        app.use(express.json({ limit: '100mb' }))
        routed.registerRoutes(app, { auth: stubAuth, activeSession: () => true })
        appServer = http.createServer(app)
        await new Promise<void>((resolve) => {
            appServer.listen(0, '127.0.0.1', () => resolve())
        })
        base = `http://127.0.0.1:${(appServer.address() as any).port}`
    })

    afterEach(async () => {
        await new Promise<void>((resolve) => appServer.close(() => resolve()))
        routed?.close()
        fs.rmSync(routeDir, { recursive: true, force: true })
    })

    async function post(body: unknown) {
        return fetch(`${base}/api/request-logs`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'risu-auth': AUTH_TOKEN },
            body: JSON.stringify(body),
        })
    }

    it('rejects unauthenticated reads', async () => {
        const res = await fetch(`${base}/api/request-logs`)
        expect(res.status).toBe(400)
    })

    it('accepts a single entry and reads it back', async () => {
        const res = await post(entry())
        expect(res.status).toBe(200)
        expect((await res.json()).written).toBe(1)

        const list = await (await get('/api/request-logs')).json()
        expect(list.total).toBe(1)
        expect(list.content[0].model).toBe('gpt-test')
        // List view omits bodies by default.
        expect(list.content[0].requestBody).toBeUndefined()

        const withBodies = await (await get('/api/request-logs?bodies=1')).json()
        expect(withBodies.content[0].requestBody).toBe('{"messages":[]}')
    })

    it('accepts a batch', async () => {
        const res = await post([entry(), entry({ model: 'second' })])
        expect((await res.json()).written).toBe(2)
        const list = await (await get('/api/request-logs')).json()
        expect(list.total).toBe(2)
    })

    it('applies category and source filters from the query string', async () => {
        await post([
            entry({ category: 'llm', source: 'main' }),
            entry({ category: 'tts', source: 'tts' }),
        ])
        const llm = await (await get('/api/request-logs?categories=llm')).json()
        expect(llm.total).toBe(1)
        expect(llm.content[0].category).toBe('llm')

        const tts = await (await get('/api/request-logs?sources=tts')).json()
        expect(tts.total).toBe(1)
    })

    it('looks a single message up by chat id', async () => {
        await post(entry({ chatId: 'gen-42' }))
        const found = await (await get('/api/request-logs?chat_id=gen-42&bodies=1&limit=1')).json()
        expect(found.content).toHaveLength(1)
        expect(found.content[0].responseBody).toBe('hello')
    })

    it('serves /usage and /stats without them being captured by the :id route', async () => {
        await post(entry({ inputTokens: 11, outputTokens: 5 }))

        const usage = await (await get('/api/request-logs/usage')).json()
        expect(usage.success).toBe(true)
        expect(usage.total.requests).toBe(1)
        expect(usage.total.inputTokens).toBe(11)
        expect(usage.dimensions.models).toContain('gpt-test')

        const stats = await (await get('/api/request-logs/stats')).json()
        expect(stats.requestCount).toBe(1)
        expect(stats.maxTotalBytes).toBeGreaterThan(0)
    })

    it('serves a single entry by id and 404s an unknown one', async () => {
        await post(entry())
        const list = await (await get('/api/request-logs')).json()
        const one = await (await get(`/api/request-logs/${list.content[0].id}`)).json()
        expect(one.content.requestBody).toBe('{"messages":[]}')

        expect((await get('/api/request-logs/999999')).status).toBe(404)
    })

    it('clears logs but keeps usage unless asked', async () => {
        await post(entry())
        await fetch(`${base}/api/request-logs`, { method: 'DELETE', headers: { 'risu-auth': AUTH_TOKEN } })
        expect((await (await get('/api/request-logs')).json()).total).toBe(0)
        expect((await (await get('/api/request-logs/usage')).json()).total.requests).toBe(1)

        await fetch(`${base}/api/request-logs?usage=1`, { method: 'DELETE', headers: { 'risu-auth': AUTH_TOKEN } })
        expect((await (await get('/api/request-logs/usage')).json()).total.requests).toBe(0)
    })
})

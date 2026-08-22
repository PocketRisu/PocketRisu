import { afterEach, describe, expect, test, vi } from 'vitest'
import { get } from 'svelte/store'

const mocks = vi.hoisted(() => ({
    db: { nodeOnlyServerSideRequests: true } as any,
}))

vi.mock('src/ts/globalApi.svelte', () => ({
    forageStorage: { createAuth: async () => 'test-auth' },
}))
vi.mock('src/ts/storage/database.svelte', () => ({
    getDatabase: () => mocks.db,
}))

async function loadModule() {
    vi.resetModules()
    return await import('./pendingSends')
}

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('pendingSends', () => {
    test('per-chat chain keeps register → clear in call order even when register is slow', async () => {
        const order: string[] = []
        let releaseRegister: () => void = () => {}
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const method = init?.method ?? 'GET'
            if (method === 'POST') {
                // Slow register: without the chain, the DELETE would overtake it.
                await new Promise<void>((r) => { releaseRegister = r })
                order.push('register')
            } else if (method === 'DELETE') {
                order.push('clear')
            }
            return new Response('{}', { status: 200 })
        }))
        const pending = await loadModule()

        pending.registerPendingSend('chat-1', 'gen-1')
        pending.clearPendingSend('chat-1')
        await new Promise((r) => setTimeout(r, 10))
        expect(order).toEqual([]) // clear queued behind the stalled register
        releaseRegister()
        await vi.waitFor(() => expect(order).toEqual(['register', 'clear']))
    })

    test('registration is toggle-gated; clearing is not', async () => {
        const calls: string[] = []
        vi.stubGlobal('fetch', vi.fn(async (_: RequestInfo | URL, init?: RequestInit) => {
            calls.push(init?.method ?? 'GET')
            return new Response('{}', { status: 200 })
        }))
        mocks.db = { nodeOnlyServerSideRequests: false }
        const pending = await loadModule()

        pending.registerPendingSend('chat-1', 'gen-1')
        pending.clearPendingSend('chat-1')
        await vi.waitFor(() => expect(calls).toEqual(['DELETE']))
    })

    test('claim returns true only on a confirmed server claim', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('{"claimed":true}', { status: 200 })))
        const pending = await loadModule()
        expect(await pending.claimPendingSend('chat-1')).toBe(true)

        vi.stubGlobal('fetch', vi.fn(async () => new Response('{"claimed":false}', { status: 200 })))
        expect(await pending.claimPendingSend('chat-1')).toBe(false)

        vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 }))) // older server
        expect(await pending.claimPendingSend('chat-1')).toBe(false)

        vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('down') }))
        expect(await pending.claimPendingSend('chat-1')).toBe(false)
    })

    test('takeResumable consumes exactly once; markResumable restores', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
        const pending = await loadModule()
        pending.markResumable('chat-1', 'gen-1')
        expect(pending.takeResumable('chat-1')).toBe(true)
        expect(pending.takeResumable('chat-1')).toBe(false)
        pending.markResumable('chat-1')
        expect(get(pending.resumableSends).has('chat-1')).toBe(true)
    })
})

import { describe, expect, it } from 'vitest'
import {
    createPluginPermissionGate,
    createPluginScriptHashGetter,
    type PluginPermission,
    type PluginPermissionState,
} from './pluginPermissionCache'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// The gate against an in-memory copy of the server state file. `restart()`
// builds a fresh gate over the same stored state, like a page reload.
function makeHarness(initial: PluginPermissionState | null = null) {
    let stored: PluginPermissionState | null = initial && structuredClone(initial)
    const events: string[] = []
    let answer: (pluginName: string, permission: PluginPermission) => boolean = () => true
    let live = 0
    let maxLive = 0

    const deps = {
        read: async () => stored && structuredClone(stored),
        write: async (state: PluginPermissionState) => { stored = structuredClone(state) },
        remove: async () => { stored = null },
        confirm: async (pluginName: string, permission: PluginPermission) => {
            events.push(`ask ${pluginName} ${permission}`)
            live++
            maxLive = Math.max(maxLive, live)
            try {
                await sleep(5)
                return answer(pluginName, permission)
            } finally {
                live--
            }
        },
        onDenied: async (pluginName: string) => {
            events.push(`denied ${pluginName}`)
        },
    }

    return {
        events,
        asks: () => events.filter((e) => e.startsWith('ask ')),
        stored: () => stored,
        maxLive: () => maxLive,
        setAnswer: (fn: typeof answer) => { answer = fn },
        restart: () => createPluginPermissionGate(deps),
    }
}

describe('createPluginScriptHashGetter', () => {
    it('hashes the loaded plugin script only once', async () => {
        let hashCalls = 0
        const getScriptHash = createPluginScriptHashGetter('plugin-script', async (data) => {
            hashCalls++
            expect(new TextDecoder().decode(data)).toBe('plugin-script')
            return 'script-hash'
        })

        expect(hashCalls).toBe(0)
        const hashes = await Promise.all([getScriptHash(), getScriptHash(), getScriptHash()])
        expect(hashes).toEqual(['script-hash', 'script-hash', 'script-hash'])
        expect(hashCalls).toBe(1)
    })
})

describe('plugin permission gate', () => {
    it('asks once for the same code, also after a restart', async () => {
        const h = makeHarness()
        const gate = h.restart()

        expect(await gate.request('Plug', 'code-1', 'db', 'periodically')).toBe(true)
        expect(await gate.request('Plug', 'code-1', 'db', 'periodically')).toBe(true)
        expect(await h.restart().request('Plug', 'code-1', 'db', 'periodically')).toBe(true)

        expect(h.asks()).toEqual(['ask Plug db'])
        expect(h.stored()).toEqual({ cache: [['code-1_db', true]] })
    })

    it('asks again when the code under the same name changes', async () => {
        const h = makeHarness()
        const gate = h.restart()
        await gate.request('Plug', 'code-1', 'db')

        // An update, or another plugin reinstalled under the same name.
        h.setAnswer(() => false)
        expect(await gate.request('Plug', 'code-2', 'db')).toBe(false)
        expect(h.asks()).toEqual(['ask Plug db', 'ask Plug db'])

        // The old code's grant is its own decision and is untouched.
        expect(await gate.request('Plug', 'code-1', 'db')).toBe(true)
        expect(h.asks()).toHaveLength(2)
    })

    it('keeps each permission separate', async () => {
        const h = makeHarness()
        const gate = h.restart()
        await gate.request('Plug', 'code-1', 'fetchLogs')

        h.setAnswer(() => false)
        expect(await gate.request('Plug', 'code-1', 'db')).toBe(false)
        expect(await gate.request('Plug', 'code-1', 'fetchLogs')).toBe(true)
        expect(h.asks()).toEqual(['ask Plug fetchLogs', 'ask Plug db'])
    })

    it('remembers a denial for that code across restarts, and shows the guide once', async () => {
        const h = makeHarness()
        h.setAnswer(() => false)
        const gate = h.restart()

        expect(await gate.request('Plug', 'code-1', 'mainDom')).toBe(false)
        expect(await gate.request('Plug', 'code-1', 'mainDom')).toBe(false)
        expect(await h.restart().request('Plug', 'code-1', 'mainDom')).toBe(false)
        expect(h.events).toEqual(['ask Plug mainDom', 'denied Plug'])

        h.setAnswer(() => true)
        expect(await gate.request('Plug', 'code-2', 'mainDom')).toBe(true)
        expect(h.asks()).toHaveLength(2)
    })

    it('ignores the name-keyed decisions of older versions but keeps their code-keyed grants', async () => {
        const h = makeHarness({
            given: [JSON.stringify(['Plug', 'db']), 'Plug'],
            denied: [JSON.stringify(['Plug', 'mainDom'])],
            cache: [
                ['code-1_db', true],
                [JSON.stringify(['Plug', 'db']) + '_lastGrantTime', 1_700_000_000_000],
                ['Plug_db_lastGrantTime', 1_600_000_000_000],
            ],
        })
        const gate = h.restart()

        // Unchanged code keeps its grant without a dialog.
        expect(await gate.request('Plug', 'code-1', 'db')).toBe(true)
        expect(h.asks()).toEqual([])
        // The name grant no longer carries over to changed code...
        expect(await gate.request('Plug', 'code-2', 'db')).toBe(true)
        // ...and the name denial no longer blocks a fresh question.
        expect(await gate.request('Plug', 'code-1', 'mainDom')).toBe(true)
        expect(h.asks()).toEqual(['ask Plug db', 'ask Plug mainDom'])

        // The next write drops the legacy lists and the 3-day reconfirm timers.
        expect(h.stored()).toEqual({
            cache: [['code-1_db', true], ['code-2_db', true], ['code-1_mainDom', true]],
        })
    })

    it('shows one dialog at a time and resolves queued duplicates with the first answer', async () => {
        const h = makeHarness()
        h.setAnswer((pluginName) => pluginName !== 'B')
        const gate = h.restart()

        const results = await Promise.all([
            gate.request('A', 'code-a', 'db'),
            gate.request('B', 'code-b', 'db'),
            gate.request('A', 'code-a', 'db'),
            gate.request('C', 'code-c', 'fetchLogs'),
        ])

        expect(results).toEqual([true, false, true, true])
        expect(h.maxLive()).toBe(1)
        // The denial guide is shown before the next dialog opens.
        expect(h.events).toEqual(['ask A db', 'ask B db', 'denied B', 'ask C fetchLogs'])
    })

    it('a failing dialog does not block later requests', async () => {
        const h = makeHarness()
        h.setAnswer((pluginName) => {
            if (pluginName === 'A') throw new Error('dialog failed')
            return true
        })
        const gate = h.restart()

        const first = gate.request('A', 'code-a', 'db')
        const second = gate.request('B', 'code-b', 'db')

        await expect(first).rejects.toThrow('dialog failed')
        expect(await second).toBe(true)
    })

    it('refuses an unknown permission without a dialog or a record', async () => {
        const h = makeHarness()
        const gate = h.restart()

        expect(await gate.request('Plug', 'code-1', 'everything' as PluginPermission)).toBe(false)
        expect(h.events).toEqual([])
        expect(h.stored()).toBeNull()
    })

    it('reset clears one version of the code; reset all removes the file', async () => {
        const h = makeHarness()
        const gate = h.restart()
        await gate.request('Plug', 'code-1', 'db')
        await gate.request('Plug', 'code-1', 'fetchLogs')
        await gate.request('Other', 'code-2', 'db')

        await gate.resetScript('code-1')
        expect(h.stored()).toEqual({ cache: [['code-2_db', true]] })
        await gate.request('Plug', 'code-1', 'db')
        await gate.request('Other', 'code-2', 'db')
        expect(h.asks()).toHaveLength(4)

        await gate.resetAll()
        expect(h.stored()).toBeNull()
        await gate.request('Other', 'code-2', 'db')
        expect(h.asks()).toHaveLength(5)
    })

    it('reports whether a decision had to wait for a dialog (dbWrite)', async () => {
        const h = makeHarness()
        const gate = h.restart()

        expect(await gate.requestDecision('Plug', 'code-1', 'dbWrite', 'periodically')).toEqual({ granted: true, waited: true })
        expect(await gate.requestDecision('Plug', 'code-1', 'dbWrite', 'periodically')).toEqual({ granted: true, waited: false })
        expect(await h.restart().requestDecision('Plug', 'code-1', 'dbWrite', 'periodically')).toEqual({ granted: true, waited: false })
        expect(h.asks()).toEqual(['ask Plug dbWrite'])

        h.setAnswer(() => false)
        expect(await gate.requestDecision('Plug', 'code-2', 'dbWrite', 'periodically')).toEqual({ granted: false, waited: true })
        expect(await gate.requestDecision('Plug', 'code-2', 'dbWrite', 'periodically')).toEqual({ granted: false, waited: false })
    })

    it('a write queued behind the same dialog also counts as waited', async () => {
        const h = makeHarness()
        const gate = h.restart()

        const results = await Promise.all([
            gate.requestDecision('Plug', 'code-1', 'dbWrite', 'periodically'),
            gate.requestDecision('Plug', 'code-1', 'dbWrite', 'periodically'),
        ])
        expect(results).toEqual([{ granted: true, waited: true }, { granted: true, waited: true }])
        expect(h.asks()).toEqual(['ask Plug dbWrite'])
    })

    it('keeps grants saved before dbWrite existed and asks for dbWrite separately', async () => {
        // A 1.17 state file: decisions for the older permissions only.
        const h = makeHarness({ cache: [['code-1_db', true], ['code-1_inlay', false]] })
        const gate = h.restart()

        expect(await gate.request('Plug', 'code-1', 'db', 'periodically')).toBe(true)
        expect(await gate.request('Plug', 'code-1', 'inlay', 'periodically')).toBe(false)
        expect(h.asks()).toEqual([])

        expect(await gate.requestDecision('Plug', 'code-1', 'dbWrite', 'periodically')).toEqual({ granted: true, waited: true })
        expect(h.asks()).toEqual(['ask Plug dbWrite'])
        expect(new Map(h.stored()!.cache)).toEqual(new Map<string, boolean | number>([
            ['code-1_db', true], ['code-1_inlay', false], ['code-1_dbWrite', true],
        ]))
    })
})

// @vitest-environment node
import { expect, test } from 'vitest'
import { spawnServer } from './compat/helpers/spawnServer.js'
import { createClient } from './compat/helpers/client.js'
import { Packr } from 'msgpackr'
import { encodeBackup } from './compat/helpers/encode.js'
import { decodeBackup } from './compat/helpers/decode.js'
import { encodeLocalPluginStorageValue, decodeLocalPluginStorageValue } from '../src/ts/plugins/localPluginStorageValue'

test('local binary KV preserves bytes, asset references and the existing backup boundary', async () => {
    const server = await spawnServer()
    try {
        const client = await createClient(server.port, server.password)
        const database = Buffer.concat([
            Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7]),
            new Packr({ useRecords: false }).encode({
                characters: [{ chaId: 'local-storage-test', name: 'Test', image: 'assets/profile.png', chats: [] }],
                apiType: 'openai', botPresets: [], botPresetsId: 0, personas: [], moduleIntergration: [],
            }),
        ])
        expect((await client.importBackup(encodeBackup([{ name: 'database.risudat', data: database }]))).ok).toBe(true)
        async function write(key: string, data: Uint8Array) {
            const response = await client.fetch('/api/write', {
                method: 'POST',
                headers: { 'file-path': Buffer.from(key).toString('hex'), 'content-type': 'application/octet-stream' },
                body: Buffer.from(data),
            })
            expect(response.status).toBe(200)
        }
        async function read(key: string) {
            const response = await client.fetch('/api/read', { headers: { 'file-path': Buffer.from(key).toString('hex') } })
            expect(response.status).toBe(200)
            return Buffer.from(await response.arrayBuffer())
        }
        const prefix = 'cache/plugin-storage/'
        const key = (name: string) => `${prefix}${Buffer.from(name).toString('base64url')}.json`
        const legacy = Buffer.from('{"text":"legacy","v":1}')
        await write(key('legacy'), legacy)
        const before = decodeBackup(await client.exportBackup())

        const audio = new Uint8Array([0, 255, 128, 1])
        const encoded = await encodeLocalPluginStorageValue({ audio: new Blob([audio], { type: 'audio/wav' }), asset: 'assets/local-keep.png' })
        await write(key('binary'), encoded)
        expect(await read(key('binary'))).toEqual(Buffer.from(encoded))
        expect(await read(key('legacy'))).toEqual(legacy)
        const restored = decodeLocalPluginStorageValue<{ audio: Blob }>(await read(key('binary')))
        expect(restored.audio.type).toBe('audio/wav')
        expect(new Uint8Array(await restored.audio.arrayBuffer())).toEqual(audio)

        const after = decodeBackup(await client.exportBackup())
        // Local plugin KV was already outside .bin backups; the frame must not
        // change the exported database or add a non-upstream backup entry.
        expect(after).toEqual(before)
        expect(after.some((entry) => entry.name.startsWith(prefix))).toBe(false)

        await write('assets/local-keep.png', new Uint8Array([1]))
        await write('assets/local-orphan.png', new Uint8Array([2]))
        const purge = await client.fetch('/api/db/assets/purge-orphans', { method: 'POST' })
        const result = await purge.json()
        expect(purge.status, JSON.stringify(result)).toBe(200)
        expect(result.deleted).toBe(1)
        expect(await read('assets/local-keep.png')).toEqual(Buffer.from([1]))
        expect(await read('assets/local-orphan.png')).toHaveLength(0)
        expect(await read(key('binary'))).toEqual(Buffer.from(encoded))
    } finally {
        await server.cleanup()
    }
}, 20_000)

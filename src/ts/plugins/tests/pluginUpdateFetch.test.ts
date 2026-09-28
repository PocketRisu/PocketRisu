import { describe, expect, it, vi } from 'vitest'
import { fetchPluginUpdateResource, getPluginUpdateFetchAttempts } from '../pluginUpdateFetch'

describe('plugin update fetch', () => {
    it('uses compatible fallback ladders for metadata and full downloads', () => {
        expect(getPluginUpdateFetchAttempts(true)).toEqual([
            { method: 'GET', cache: 'no-store', headers: { Range: 'bytes=0-512' } },
            { method: 'GET', cache: 'no-store' },
            { method: 'GET' },
        ])
        expect(getPluginUpdateFetchAttempts(false)).toEqual([
            { method: 'GET', cache: 'no-store' },
            { method: 'GET' },
        ])
    })

    it('cache-busts once and falls back after errors or non-success responses', async () => {
        const fetchImpl = vi.fn()
            .mockRejectedValueOnce(new TypeError('cache mode unsupported'))
            .mockResolvedValueOnce({ status: 500 } as Response)
            .mockResolvedValueOnce({ status: 206 } as Response)

        const response = await fetchPluginUpdateResource(
            'https://example.com/plugin.js?channel=beta',
            true,
            fetchImpl as unknown as typeof fetch,
        )

        expect(response.status).toBe(206)
        expect(fetchImpl).toHaveBeenCalledTimes(3)

        const urls = fetchImpl.mock.calls.map(([url]) => new URL(String(url)))
        expect(new Set(urls.map((url) => url.toString())).size).toBe(1)
        expect(urls[0].searchParams.get('channel')).toBe('beta')
        expect(urls[0].searchParams.get('_risu_update')).toBeTruthy()

        expect(fetchImpl.mock.calls.map(([, init]) => init)).toEqual([
            { method: 'GET', cache: 'no-store', headers: { Range: 'bytes=0-512' } },
            { method: 'GET', cache: 'no-store' },
            { method: 'GET' },
        ])
    })
})

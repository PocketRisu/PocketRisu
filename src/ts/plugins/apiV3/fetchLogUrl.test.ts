import { describe, expect, it } from 'vitest'
import { fetchLogUrlForPlugin } from './fetchLogUrl'

describe('fetchLogUrlForPlugin', () => {
    it('keeps the origin and path of a web URL and drops the query and hash', () => {
        expect(fetchLogUrlForPlugin('https://api.example.com/v1/chat?key=secret#frag'))
            .toBe('https://api.example.com/v1/chat')
    })

    it('does not throw for a plugin provider name with spaces and brackets (#115)', () => {
        expect(fetchLogUrlForPlugin('plugin://[Beta] My Provider')).toBe('plugin://[Beta] My Provider')
    })

    it('keeps a plugin provider URL readable instead of the opaque "null" origin', () => {
        expect(fetchLogUrlForPlugin('plugin://provider')).toBe('plugin://provider')
    })

    it('still drops the query and hash of a URL that does not parse', () => {
        expect(fetchLogUrlForPlugin('plugin://[Beta] p?key=secret#x')).toBe('plugin://[Beta] p')
    })

    it('drops credentials from a URL that does not parse', () => {
        expect(fetchLogUrlForPlugin('https://alice:proxySecret@[bad]/v1?key=secret#frag'))
            .toBe('https://[bad]/v1')
        expect(fetchLogUrlForPlugin('https://token@[bad]')).toBe('https://[bad]')
    })

    it('drops credentials whatever shape the malformed authority has', () => {
        const inputs = [
            'https:///alice:secret@[bad]/v1?key=x#frag',
            ' https://alice:secret@[bad]/v1?key=x#frag',
            'https:\\\\alice:secret@[bad]/v1',
            'https://a@b:secret@[bad]/v1',
            'https:/alice:secret@[bad]/v1?key=x#frag',
            'https:/alice:secret@example.com/v1',
            'alice:secret@[bad]/v1',
            'blob:https://alice:secret@example.com/id',
        ]
        for (const input of inputs) {
            const out = fetchLogUrlForPlugin(input)
            expect(out).not.toContain('secret')
            expect(out).not.toContain('alice')
            expect(out).not.toContain('key=')
        }
    })

    it('keeps an @ in a plugin provider name', () => {
        expect(fetchLogUrlForPlugin('plugin://Claude@Proxy [Beta]')).toBe('plugin://Claude@Proxy [Beta]')
    })

    it('drops credentials from a parsable URL', () => {
        expect(fetchLogUrlForPlugin('https://alice:secret@api.example.com/v1')).toBe('https://api.example.com/v1')
    })
})

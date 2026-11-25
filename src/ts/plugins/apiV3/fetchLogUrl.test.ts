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
})

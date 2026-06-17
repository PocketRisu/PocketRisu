import { describe, expect, test } from 'vitest'
import { shouldLogFetch } from './fetchLogPolicy'

describe('fetchNative fetch-log policy', () => {
    test('logs by default and suppresses only when explicitly requested', () => {
        expect(shouldLogFetch({})).toBe(true)
        expect(shouldLogFetch({ suppressFetchLog: false })).toBe(true)
        expect(shouldLogFetch({ suppressFetchLog: true })).toBe(false)
    })
})

import { describe, expect, it } from 'vitest'
import {
    matchesLorebookKey,
    resolveLorebookMatchingMode,
} from './lorebookMatching'

describe('matchesLorebookKey', () => {
    it('preserves partial matching behavior', () => {
        expect(matchesLorebookKey('firefighter', 'fight', 'partial')).toBe(true)
        expect(matchesLorebookKey('fire fighter', 'fight', 'partial')).toBe(true)
    })

    it('preserves space-delimited exact matching behavior', () => {
        expect(matchesLorebookKey('fight now', 'fight', 'whitespace')).toBe(true)
        expect(matchesLorebookKey('fight, now', 'fight', 'whitespace')).toBe(false)
        expect(matchesLorebookKey('fighting now', 'fight', 'whitespace')).toBe(false)
    })

    it('matches Unicode word boundaries around punctuation', () => {
        expect(matchesLorebookKey('fight, now', 'fight', 'word-boundary', 'en')).toBe(true)
        expect(matchesLorebookKey('(fight)', 'fight', 'word-boundary', 'en')).toBe(true)
        expect(matchesLorebookKey('fighting', 'fight', 'word-boundary', 'en')).toBe(false)
        expect(matchesLorebookKey('전투, 시작', '전투', 'word-boundary', 'ko')).toBe(true)
    })

    it('matches multi-word keys on word boundaries', () => {
        expect(matchesLorebookKey('Visit New York, today', 'new york', 'word-boundary', 'en')).toBe(true)
        expect(matchesLorebookKey('Visit New Yorkshire', 'new york', 'word-boundary', 'en')).toBe(false)
    })

    it('accepts Korean particles without matching longer names', () => {
        expect(matchesLorebookKey('앨리스가 누구야?', '앨리스', 'word-boundary', 'ko')).toBe(true)
        expect(matchesLorebookKey('앨리스라는 사람', '앨리스', 'word-boundary', 'ko')).toBe(true)
        expect(matchesLorebookKey('앨리스터가 누구야?', '앨리스', 'word-boundary', 'ko')).toBe(false)
    })
})

describe('resolveLorebookMatchingMode', () => {
    it('migrates legacy full-word settings without changing behavior', () => {
        expect(resolveLorebookMatchingMode(undefined, true)).toBe('whitespace')
        expect(resolveLorebookMatchingMode(undefined, false)).toBe('partial')
        expect(resolveLorebookMatchingMode('word-boundary', true)).toBe('word-boundary')
        expect(resolveLorebookMatchingMode('invalid' as any, true)).toBe('whitespace')
    })
})

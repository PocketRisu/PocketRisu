import { describe, expect, it } from 'vitest'
import { languageEnglish } from './en'
import { languageKorean } from './ko'

describe('lorebook scan range labels', () => {
    it('describes chat-history scanning instead of recursive lorebook depth', () => {
        expect(languageEnglish.loreBookDepth).toBe('Recent Chat Scan Range')
        expect(languageKorean.loreBookDepth).toBe('최근 대화 검색 범위')
    })

    it('explains that the value counts previous messages', () => {
        expect(languageEnglish.help.loreBookDepth).toContain('previous messages')
        expect(languageKorean.help.loreBookDepth).toContain('메시지 개수')
    })
})

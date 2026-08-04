import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { languageEnglish } from './en'
import { languageKorean } from './ko'

describe('lorebook scan range labels', () => {
    it('describes chat-history scanning instead of recursive lorebook depth', () => {
        expect(languageEnglish.loreBookDepth).toBe('Recent Chat Scan Range')
        expect(languageKorean.loreBookDepth).toBe('최근 대화 검색 범위')
    })

    it('explains that the value counts previous messages', () => {
        expect(languageEnglish.help.loreBookDepth).toContain('messages')
        expect(languageKorean.help.loreBookDepth).toContain('메시지')
    })
})

describe('shared lorebook setting help', () => {
    it('adds click help buttons for global settings, scan range, and token budget', () => {
        const source = readFileSync(
            resolve('src/lib/SideBars/LoreBook/LoreBookSetting.svelte'),
            'utf8',
        )

        for(const key of ['useGlobalSettings', 'loreBookDepth', 'loreBookToken']){
            expect(source).toContain('<Help ' + 'key="' + key + '"')
        }
    })

    it('explains global settings and gives short numeric examples', () => {
        expect(languageEnglish.help.useGlobalSettings).toContain('character')
        expect(languageKorean.help.useGlobalSettings).toContain('캐릭터')
        expect(languageEnglish.help.loreBookDepth).toContain('`5`')
        expect(languageKorean.help.loreBookDepth).toContain('`5`')
        expect(languageEnglish.help.loreBookToken).toContain('priority')
        expect(languageKorean.help.loreBookToken).toContain('우선순위')
    })
})

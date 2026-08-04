import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { languageEnglish } from './en'
import { languageKorean } from './ko'

describe('lorebook matching mode help', () => {
    it('adds a click help button to the matching mode selector', () => {
        const source = readFileSync(
            resolve('src/lib/SideBars/LoreBook/LoreBookSetting.svelte'),
            'utf8',
        )

        expect(source).toContain('<Help ' + 'key="lorebookMatchingMode"')
    })

    it('explains all three modes with examples', () => {
        for(const help of [
            languageEnglish.help.lorebookMatchingMode,
            languageKorean.help.lorebookMatchingMode,
        ]){
            expect(help).toContain('cat')
            expect(help).toContain('category')
            expect(help).toContain('cat,')
            expect(help).toContain('Alice')
            expect(help).toContain('Aliceville')
            expect(help).toContain('앨리스가')
        }
    })
})

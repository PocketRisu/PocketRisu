import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { languageEnglish } from './en'
import { languageKorean } from './ko'

describe('lorebook recursion help', () => {
    it('adds click help buttons for recursive scanning and its limit', () => {
        const source = readFileSync(
            resolve('src/lib/SideBars/LoreBook/LoreBookSetting.svelte'),
            'utf8',
        )

        expect(source).toContain('<Help ' + 'key="recursiveScanning"')
        expect(source).toContain('<Help ' + 'key="maxRecursionSteps"')
    })

    it('explains the activation chain and step values', () => {
        for(const help of [
            languageEnglish.help.recursiveScanning,
            languageKorean.help.recursiveScanning,
            languageEnglish.help.maxRecursionSteps,
            languageKorean.help.maxRecursionSteps,
        ]){
            expect(help).toMatch(/Alice|앨리스|`1`|`2`|`0`/)
        }
    })
})

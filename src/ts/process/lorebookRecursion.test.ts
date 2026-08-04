import { writable } from 'svelte/store'
import { describe, expect, it, vi } from 'vitest'

const { mockDBState } = vi.hoisted(() => ({
    mockDBState: { db: {} as any },
}))

vi.mock('../stores.svelte', () => ({
    DBState: mockDBState,
    selectedCharID: writable(0),
}))
vi.mock('../tokenizer', () => ({
    tokenize: vi.fn(async () => 1),
}))
vi.mock('../parser/parser.svelte', () => ({
    risuChatParser: (value: string) => value,
}))
vi.mock('../util', () => ({
    findCharacterbyId: vi.fn(),
    pickHashRand: vi.fn(() => 1),
    selectSingleFile: vi.fn(),
}))
vi.mock('../alert', () => ({
    alertError: vi.fn(),
    notifySuccess: vi.fn(),
}))
vi.mock('../../lang', () => ({
    getCurrentLocale: () => 'en',
    language: {},
}))
vi.mock('../globalApi.svelte', () => ({
    downloadFile: vi.fn(),
    saveAsset: vi.fn(),
}))
vi.mock('./modules', () => ({
    getModuleLorebooks: () => [],
}))

import { loadLoreBookV3Prompt } from './lorebook.svelte'

function lore(comment: string, key: string, content: string) {
    return {
        comment,
        key,
        content,
        mode: 'normal',
        insertorder: 100,
        alwaysActive: false,
        secondkey: '',
        selective: false,
        useRegex: false,
    }
}

describe('lorebook recursion steps', () => {
    it('does not activate newly discovered keys during the same sweep', async () => {
        mockDBState.db = {
            username: 'user',
            loreBookDepth: 5,
            loreBookToken: 8000,
            characters: [{
                name: 'storywriter',
                chatPage: 0,
                globalLore: [
                    lore('alice', 'alice', 'bobby'),
                    lore('bobby', 'bobby', 'toby'),
                    lore('toby', 'toby', 'controls people'),
                ],
                chats: [{
                    localLore: [],
                    message: [{ role: 'user', data: 'alice' }],
                }],
                loreSettings: {
                    tokenBudget: 8000,
                    scanDepth: 5,
                    recursiveScanning: true,
                    maxRecursionSteps: 1,
                    matchingMode: 'partial',
                },
            }],
        }

        const result = await loadLoreBookV3Prompt()

        expect(result.actives.map((entry) => entry.source)).toEqual(['alice'])
    })
})

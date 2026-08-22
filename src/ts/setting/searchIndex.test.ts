import { describe, expect, test } from 'vitest'
import { searchSettings } from './searchIndex'
import { SettingsRoute } from '../routing'

// A settings entry is reachable two ways and they cover different text: the
// declarative items index each SETTING's label/keywords/help, while the manifest
// indexes the TAB name (which is only breadcrumb text on the declarative side).
// Searching the name printed on the tab must find it.
//
// Conditions across the other settings pages dereference arbitrary db fields
// (db.aiModel.startsWith(...), db.someList.includes(...)). A proxy answering ''
// for anything unset satisfies both string and array-ish probes, so the search
// walks every source the way it does in the app.
const db: any = new Proxy({}, { get: (_t, key) => (key === 'then' ? undefined : '') })
const modelInfo: any = new Proxy({}, { get: () => '' })
const ctx = { db, modelInfo, subModelInfo: modelInfo } as any

/** Sub-tab indices of every Model Preset hit. Locale-independent, unlike the
 * label — the test runtime has no locale set, so labels come back in English. */
function moduleTabHits(query: string): number[] {
    return searchSettings(query, ctx)
        .filter((r) => r.route === SettingsRoute.ModelPreset && r.subTab === 3)
        .map((r) => r.subTab!)
}

describe('searchSettings — module binding tab', () => {
    test('finds the tab by the name shown on it', () => {
        expect(moduleTabHits('모듈 분리 바인딩').length).toBeGreaterThan(0)
    })

    test('finds it without spaces', () => {
        expect(moduleTabHits('모듈분리바인딩').length).toBeGreaterThan(0)
    })

    test('finds it in English', () => {
        expect(moduleTabHits('module binding').length).toBeGreaterThan(0)
    })

    test('finds the toggle setting via its own keywords', () => {
        expect(moduleTabHits('모듈별').length).toBeGreaterThan(0)
    })

    test('an unrelated query does not hit the tab', () => {
        expect(moduleTabHits('persona')).toEqual([])
    })
})

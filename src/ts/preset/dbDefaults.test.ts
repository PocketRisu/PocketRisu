import { describe, expect, test } from 'vitest'
import { applyModelPresetDefaults, createEmptyRegistryCache } from './dbDefaults'

describe('applyModelPresetDefaults', () => {
    test('initializes v4 model preset storage fields', () => {
        const db: any = {}

        applyModelPresetDefaults(db)

        expect(db.modelPresets).toEqual([])
        expect(db.apiKeyPool).toEqual({})
        expect(db.modelProfileRegistryCache).toEqual({
            schemaVersion: 4,
            registries: {},
        })
        expect(db.modelProfileRegistryLastFetched).toBe(0)
    })

    test('preserves migration metadata and existing values', () => {
        const existingCache = createEmptyRegistryCache()
        existingCache.registries.official = { fetchedAt: 123, indexVersion: 7 }
        const db: any = {
            modelPresets: [{ id: 'preset-a' }],
            apiKeyPool: { keyA: { id: 'keyA' } },
            modelProfileRegistryCache: existingCache,
            modelProfileRegistryLastFetched: 456,
            modelPresetMigrationVersion: 1,
            modelPresetMigrationAppliedAt: 789,
            modelPresetMigrationReport: { version: 1 },
        }

        applyModelPresetDefaults(db)

        expect(db.modelPresets).toEqual([{ id: 'preset-a' }])
        expect(db.apiKeyPool).toEqual({ keyA: { id: 'keyA' } })
        expect(db.modelProfileRegistryCache).toBe(existingCache)
        expect(db.modelProfileRegistryLastFetched).toBe(456)
        expect(db.modelPresetMigrationVersion).toBe(1)
        expect(db.modelPresetMigrationAppliedAt).toBe(789)
        expect(db.modelPresetMigrationReport).toEqual({ version: 1 })
    })

    test('strips null elements from persisted profileSnapshot schema/uiSchema arrays', () => {
        const db: any = {
            modelPresets: [
                {
                    id: 'preset-legacy',
                    profileSnapshot: {
                        schema: [{ key: 'apiKey' }, null, { key: 'modelId' }],
                        uiSchema: {
                            groups: [{ id: 'auth' }, null],
                            fields: [null, { key: 'apiKey' }],
                        },
                    },
                },
            ],
        }

        applyModelPresetDefaults(db)

        const snap = db.modelPresets[0].profileSnapshot
        expect(snap.schema).toEqual([{ key: 'apiKey' }, { key: 'modelId' }])
        expect(snap.uiSchema.groups).toEqual([{ id: 'auth' }])
        expect(snap.uiSchema.fields).toEqual([{ key: 'apiKey' }])
    })
})

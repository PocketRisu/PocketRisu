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

    // A healthy registry cache (under the bundled id) that resolves `testprofile`
    // to a complete snapshot: apiKey + modelId in both schema and uiSchema.
    function healthyCache(): any {
        return {
            schemaVersion: 4,
            registries: {
                bundled: {
                    fetchedAt: 1,
                    baseProviders: {
                        testbase: {
                            id: 'testbase',
                            version: 2,
                            adapterKind: 'openai-compatible',
                            requestSchema: [
                                { key: 'apiKey', type: 'string', label: 'API Key', secret: true, mapsTo: { target: 'auth', path: 'apiKey' } },
                                { key: 'modelId', type: 'string', label: 'Model' },
                            ],
                            uiSchema: {
                                groups: [],
                                fields: [
                                    { key: 'apiKey', widget: 'secret', visibility: 'basic' },
                                    { key: 'modelId', widget: 'combobox', visibility: 'basic' },
                                ],
                            },
                        },
                    },
                    profiles: {
                        testprofile: {
                            id: 'testprofile',
                            version: 3,
                            providerBaseId: 'testbase',
                            auth: { kind: 'bearer', fields: ['apiKey'] },
                            endpoint: { kind: 'static', url: 'https://x/v1' },
                            modelId: '',
                            schema: [],
                            uiSchema: { groups: [], fields: [] },
                            defaults: {},
                            updatedAt: 9999,
                        },
                    },
                },
            },
        }
    }

    function degeneratePreset(): any {
        return {
            id: 'p1',
            sourceProfile: { registryId: 'bundled', profileId: 'testprofile', profileVersion: 1, providerBaseVersion: 1, fetchedAt: 0, profileUpdatedAt: 100 },
            profileSnapshot: {
                profileId: 'testprofile',
                schema: [{ key: 'modelId', type: 'string', label: 'Model' }],
                uiSchema: { groups: [], fields: [] },
                auth: { kind: 'bearer', fields: ['apiKey'] },
                endpoint: { kind: 'static', url: 'https://x/v1' },
            },
            userValues: { modelId: 'gpt-x' },
            createdAt: 0,
            updatedAt: 0,
        }
    }

    test('heals a degenerate snapshot (empty uiSchema) from the current registry, preserving userValues', () => {
        const db: any = { modelPresets: [degeneratePreset()], modelProfileRegistryCache: healthyCache() }

        applyModelPresetDefaults(db)

        const snap = db.modelPresets[0].profileSnapshot
        expect(snap.uiSchema.fields.map((f: any) => f.key)).toEqual(['apiKey', 'modelId'])
        expect(snap.schema.map((f: any) => f.key)).toEqual(['apiKey', 'modelId'])
        // userValues carried over (modelId still exists in the fresh schema).
        expect(db.modelPresets[0].userValues).toEqual({ modelId: 'gpt-x' })
    })

    test('leaves a degenerate snapshot untouched when it has no sourceProfile', () => {
        const preset = degeneratePreset()
        delete preset.sourceProfile
        const db: any = { modelPresets: [preset], modelProfileRegistryCache: healthyCache() }

        applyModelPresetDefaults(db)

        expect(db.modelPresets[0].profileSnapshot.uiSchema.fields).toEqual([])
    })

    test('leaves a degenerate snapshot untouched when the registry cannot heal it', () => {
        const preset = degeneratePreset()
        preset.sourceProfile.profileId = 'missing-profile'
        preset.profileSnapshot.profileId = 'missing-profile'
        const db: any = { modelPresets: [preset], modelProfileRegistryCache: healthyCache() }

        applyModelPresetDefaults(db)

        expect(db.modelPresets[0].profileSnapshot.uiSchema.fields).toEqual([])
    })

    test('moves a userValue to orphanValues on heal when its type changed vs the fresh schema', () => {
        const preset = degeneratePreset()
        // Old schema typed modelId as number; the fresh registry types it string.
        preset.profileSnapshot.schema = [{ key: 'modelId', type: 'number', label: 'Model' }]
        const db: any = { modelPresets: [preset], modelProfileRegistryCache: healthyCache() }

        applyModelPresetDefaults(db)

        const healed = db.modelPresets[0]
        expect(healed.userValues).toEqual({})                       // dropped from active values
        expect(healed.orphanValues).toEqual({ modelId: 'gpt-x' })   // preserved as orphan
    })

    test('advances sourceProfile.profileUpdatedAt on heal so the update badge does not re-appear', () => {
        const db: any = { modelPresets: [degeneratePreset()], modelProfileRegistryCache: healthyCache() }

        applyModelPresetDefaults(db)

        const sp = db.modelPresets[0].sourceProfile
        expect(sp.profileUpdatedAt).toBe(9999) // registry profile's updatedAt, not the stale 100
        expect(sp.profileVersion).toBe(3)
    })

    test('heals a preset whose persisted snapshot mirrors the real report (schema:[null], null auth/endpoint)', () => {
        // The "vercel:openai-compatible" preset #2 from the field DB: a null schema
        // element + null auth/endpoint. sanitize strips the null to [] first, then
        // heal re-resolves against the current registry.
        const preset = degeneratePreset()
        preset.profileSnapshot.schema = [null]
        preset.profileSnapshot.auth = null
        preset.profileSnapshot.endpoint = null
        const db: any = { modelPresets: [preset], modelProfileRegistryCache: healthyCache() }

        applyModelPresetDefaults(db)

        const snap = db.modelPresets[0].profileSnapshot
        expect(snap.uiSchema.fields.map((f: any) => f.key)).toEqual(['apiKey', 'modelId'])
        expect(snap.auth).toEqual({ kind: 'bearer', fields: ['apiKey'] })
    })

    test('does not throw at load on a malformed snapshot (missing schema/uiSchema), and heals it', () => {
        const preset = degeneratePreset()
        delete preset.profileSnapshot.schema
        delete preset.profileSnapshot.uiSchema
        const db: any = { modelPresets: [preset], modelProfileRegistryCache: healthyCache() }

        // The unguarded `.schema.map()` in applyProfileSnapshotUpdate would throw
        // and abort app load without the sanitize-normalize + heal try/catch.
        expect(() => applyModelPresetDefaults(db)).not.toThrow()
        expect(db.modelPresets[0].profileSnapshot.uiSchema.fields.length).toBe(2)
    })

    // The second degeneracy shape: the profile's own fields resolve fine
    // (non-empty schema + non-empty uiSchema.fields), but the base-provided
    // credential field was dropped — auth.fields still declares ['apiKey'] yet NO
    // schema field maps to auth, so the user can't enter the API key. (openai
    // presets hit this: profile fields present, apiKey missing.)
    function authDroppedPreset(): any {
        return {
            id: 'p3',
            sourceProfile: { registryId: 'bundled', profileId: 'testprofile', profileVersion: 1, providerBaseVersion: 1, fetchedAt: 0, profileUpdatedAt: 100 },
            profileSnapshot: {
                profileId: 'testprofile',
                schema: [{ key: 'modelId', type: 'string', label: 'Model' }],
                uiSchema: { groups: [], fields: [{ key: 'modelId', widget: 'combobox', visibility: 'basic' }] },
                auth: { kind: 'bearer', fields: ['apiKey'] },
                endpoint: { kind: 'static', url: 'https://x/v1' },
            },
            userValues: { modelId: 'gpt-x' },
            createdAt: 0,
            updatedAt: 0,
        }
    }

    test('heals a snapshot whose auth.fields declares apiKey but no schema field maps to auth', () => {
        const db: any = { modelPresets: [authDroppedPreset()], modelProfileRegistryCache: healthyCache() }

        applyModelPresetDefaults(db)

        const snap = db.modelPresets[0].profileSnapshot
        // The base-provided apiKey field (mapsTo.target === 'auth') is restored.
        const authField = snap.schema.find((f: any) => f?.mapsTo?.target === 'auth')
        expect(authField).toBeTruthy()
        expect(authField.key).toBe('apiKey')
        // userValues carried over (modelId still exists in the fresh schema).
        expect(db.modelPresets[0].userValues).toEqual({ modelId: 'gpt-x' })
    })

    test('does not flag a snapshot that already has an auth-mapped field', () => {
        // Non-empty schema + uiSchema.fields, auth.fields=['apiKey'], AND a schema
        // field mapping to auth → healthy. Must be left untouched (regression).
        const healthy: any = {
            id: 'p4',
            sourceProfile: { registryId: 'bundled', profileId: 'testprofile', profileVersion: 3, providerBaseVersion: 2, fetchedAt: 0 },
            profileSnapshot: {
                profileId: 'testprofile',
                schema: [
                    { key: 'apiKey', type: 'string', label: 'API Key', mapsTo: { target: 'auth', path: 'apiKey' } },
                    { key: 'modelId', type: 'string', label: 'Model' },
                ],
                uiSchema: { groups: [], fields: [{ key: 'apiKey', widget: 'secret', visibility: 'basic' }] },
                auth: { kind: 'bearer', fields: ['apiKey'] },
                endpoint: { kind: 'static', url: 'https://x/v1' },
            },
            userValues: {},
            updatedAt: 777,
        }
        const db: any = { modelPresets: [healthy], modelProfileRegistryCache: healthyCache() }

        applyModelPresetDefaults(db)

        // Same object reference, untouched (no re-resolve, no updatedAt change).
        expect(db.modelPresets[0]).toBe(healthy)
        expect(db.modelPresets[0].updatedAt).toBe(777)
    })

    test('does not touch a healthy preset', () => {
        const healthy: any = {
            id: 'p2',
            sourceProfile: { registryId: 'bundled', profileId: 'testprofile', profileVersion: 3, providerBaseVersion: 2, fetchedAt: 0 },
            profileSnapshot: {
                profileId: 'testprofile',
                schema: [{ key: 'apiKey', type: 'string', label: 'API Key', mapsTo: { target: 'auth', path: 'apiKey' } }],
                uiSchema: { groups: [], fields: [{ key: 'apiKey', widget: 'secret', visibility: 'basic' }] },
                auth: { kind: 'bearer', fields: ['apiKey'] },
                endpoint: { kind: 'static', url: 'https://x/v1' },
            },
            userValues: {},
            updatedAt: 555,
        }
        const db: any = { modelPresets: [healthy], modelProfileRegistryCache: healthyCache() }

        applyModelPresetDefaults(db)

        // Same object reference, untouched (no version bump, no updatedAt change).
        expect(db.modelPresets[0]).toBe(healthy)
        expect(db.modelPresets[0].updatedAt).toBe(555)
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

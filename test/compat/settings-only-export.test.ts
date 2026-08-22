/**
 * Settings-only export tests (/api/backup/export?mode=settings).
 *
 * A settings-only backup is the full backup minus characters, chats and inlay
 * images. It exists so a user running several PocketRisu instances can seed a
 * fresh one without carrying their character library.
 *
 * Two things have to hold, and they pull in opposite directions:
 *
 *   1. Character-shaped data must be gone — characters, chats, cold storage,
 *      inlay images, and character art. Otherwise the file doesn't shrink and
 *      the feature is pointless.
 *   2. Every *settings*-level asset must survive — persona icons, theme
 *      background, notification sounds, module assets, image-gen reference
 *      images. A miss here silently ships a seed with broken images, which is
 *      the failure mode most likely to go unnoticed.
 *
 * So the asset assertions are deliberately exhaustive per-field rather than a
 * count check: a count check passes when the wrong asset survives.
 */
import { describe, test, expect, afterAll } from 'vitest'
import { Packr } from 'msgpackr'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient } from './helpers/client.js'
import { encodeBackup } from './helpers/encode.js'
import { decodeBackup } from './helpers/decode.js'
import { normalizeBackup } from './helpers/normalize.js'

const servers: ServerHandle[] = []
afterAll(async () => {
  await Promise.allSettled(servers.map(s => s.cleanup()))
})

// Must match the server's magic header for "raw" (uncompressed) format.
const MAGIC_RAW = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])
const packr = new Packr({ useRecords: false })

function encodeRisuDat(data: unknown): Buffer {
  return Buffer.concat([MAGIC_RAW, packr.encode(data)])
}

// Asset entry names in a .bin carry no prefix — the server prepends `assets/`
// on import. The DB references them with the prefix, which is why the export
// filter compares basenames.
const CHAR_IMAGE = 'char-image-aaa.png'
const CHAR_EMOTION = 'char-emotion-bbb.png'
const PERSONA_ICON = 'persona-icon-ccc.png'
const BACKGROUND = 'background-ddd.png'
const SOUND = 'sound-eee.mp3'
const MODULE_ASSET = 'module-asset-fff.png'
const MODULE_ICON = 'module-icon-iii.png'
const NAI_REF_IMAGE = 'nai-ref-ggg.png'
const USER_ICON = 'user-icon-hhh.png'
/**
 * Referenced by both a module's asset list and a persona's icon. Excluding
 * module assets must not drop it — the exclusion is computed as a set
 * difference against everything reachable *without* modules, so anything with a
 * second owner stays.
 */
const SHARED_ASSET = 'shared-asset-jjj.png'

/** Assets that must survive a settings-only export. */
const SETTINGS_ASSETS = [
  PERSONA_ICON, BACKGROUND, SOUND, MODULE_ASSET, MODULE_ICON,
  NAI_REF_IMAGE, USER_ICON, SHARED_ASSET,
]
/** Assets that must NOT survive it. */
const CHARACTER_ASSETS = [CHAR_IMAGE, CHAR_EMOTION]
/** Assets dropped when module assets are excluded. */
const MODULE_ONLY_ASSETS = [MODULE_ASSET]
/** Assets that survive even with module assets excluded. */
const NON_MODULE_ASSETS = [
  PERSONA_ICON, BACKGROUND, SOUND, MODULE_ICON, NAI_REF_IMAGE, USER_ICON, SHARED_ASSET,
]

const COLD_KEY = '11111111-2222-3333-4444-555555555555'

/**
 * A seed carrying one of everything: a character with art and chats, a cold
 * storage character, inlay images, and a settings block that references an
 * asset through every path buildUncleanableSet knows about.
 */
function createRichSeed(): Buffer {
  const database: Record<string, unknown> = {
    characters: [
      {
        name: 'CharWithArt',
        chaId: 'test-char-0',
        type: 'character',
        desc: 'A test character',
        firstMessage: 'Hello!',
        image: `assets/${CHAR_IMAGE}`,
        emotionImages: [['happy', `assets/${CHAR_EMOTION}`]],
        chats: [{
          id: 'chat-0-0',
          name: 'Chat 0',
          message: [
            { role: 'user', data: 'hi' },
            { role: 'char', data: 'hello there' },
          ],
          localLore: [],
          note: '',
        }],
        chatPage: 0,
      },
      {
        name: 'ColdChar',
        chaId: `cold-char-${COLD_KEY}`,
        type: 'character',
        image: '',
        chats: [{ message: [{ role: 'char', data: '' }], note: '', name: '', localLore: [] }],
        chatPage: 0,
        firstMsgIndex: 0,
        coldstorage: COLD_KEY,
      },
    ],
    characterOrder: ['test-char-0'],

    // ── Settings that must survive ──────────────────────────────────────────
    apiType: 'openai',
    openAIKey: 'sk-test-key-should-survive',
    mainPrompt: 'main prompt text',
    temperature: 80,
    maxContext: 4000,
    userIcon: `assets/${USER_ICON}`,
    customBackground: `assets/${BACKGROUND}`,
    messageSound: `assets/${SOUND}`,
    customSounds: [{ id: 'sound-1', name: 'ding.mp3', path: `assets/${SOUND}` }],
    personas: [
      { name: 'Default', icon: `assets/${PERSONA_ICON}`, personaPrompt: 'persona text' },
      // Second owner for SHARED_ASSET — see the constant's note.
      { name: 'Shared', icon: `assets/${SHARED_ASSET}`, personaPrompt: 'shared' },
    ],
    selectedPersona: 0,
    modules: [
      {
        id: 'module-1',
        name: 'TestModule',
        description: 'a module',
        icon: `assets/${MODULE_ICON}`,
        assets: [
          ['pic', `assets/${MODULE_ASSET}`, 'png'],
          ['shared', `assets/${SHARED_ASSET}`, 'png'],
        ],
      },
    ],
    botPresets: [{ name: 'Preset A', image: 'data:image/jpeg;base64,AAAA' }],
    botPresetsId: 0,
    plugins: [{ name: 'TestPlugin', script: '// noop' }],
    loreBook: [{ name: 'Global Lore', data: [] }],
    loreBookPage: 0,
    NAIImgConfig: { image: `assets/${NAI_REF_IMAGE}` },
  }

  const coldData = {
    character: {
      name: 'ColdChar',
      chaId: `cold-char-${COLD_KEY}`,
      image: '', type: 'character',
      desc: 'cold', firstMessage: 'cold hello',
      chats: [{ message: [{ role: 'char', data: 'cold hello' }], note: '', name: 'Chat 1', localLore: [] }],
      chatPage: 0, firstMsgIndex: -1,
      notes: '', emotionImages: [], bias: [], globalLore: [],
      viewScreen: 'none', sdData: [], utilityBot: false,
      customscript: [], triggerscript: [],
      exampleMessage: '', creatorNotes: '', systemPrompt: '',
      postHistoryInstructions: '', alternateGreetings: [],
      tags: [], creator: '', characterVersion: '',
      personality: '', scenario: '', replaceGlobalNote: '',
      additionalText: '', chatFolders: [],
    },
  }

  return encodeBackup([
    { name: 'database.risudat', data: encodeRisuDat(database) },
    // Character art + settings assets, all in one flat namespace.
    ...[...CHARACTER_ASSETS, ...SETTINGS_ASSETS].map(name => ({
      name,
      data: Buffer.from(`fake-bytes-for-${name}`),
    })),
    { name: `coldstorage/${COLD_KEY}.json`, data: Buffer.from(JSON.stringify(coldData), 'utf-8') },
    { name: 'inlay/test-inlay.png', data: Buffer.from('fake-inlay-image') },
    {
      name: 'inlay_sidecar/test-inlay',
      data: Buffer.from(JSON.stringify({ ext: 'png', name: 'test-inlay.png', type: 'image' })),
    },
    {
      name: 'inlay_meta/test-inlay',
      data: Buffer.from(JSON.stringify({ createdAt: 1, updatedAt: 2, charId: 'test-char-0', chatId: 'chat-0-0' })),
    },
  ])
}

async function seededServer() {
  const srv = await spawnServer()
  servers.push(srv)
  const client = await createClient(srv.port, srv.password)
  const importResult = await client.importBackup(createRichSeed())
  expect(importResult.ok).toBe(true)
  return client
}

async function exportSettingsOnly(
  client: Awaited<ReturnType<typeof seededServer>>,
  opts: { moduleAssets?: boolean } = {},
) {
  const query = opts.moduleAssets === false ? '?mode=settings&moduleAssets=0' : '?mode=settings'
  const res = await client.fetch(`/api/backup/export${query}`)
  expect(res.ok).toBe(true)
  return {
    res,
    bin: Buffer.from(await res.arrayBuffer()),
  }
}

describe('settings-only export', () => {
  test('drops characters, chats and characterOrder while keeping settings', async () => {
    const client = await seededServer()
    const { bin } = await exportSettingsOnly(client)

    const { raw, normalized } = normalizeBackup(bin)
    expect(normalized.characterCount).toBe(0)
    expect(raw.characters).toEqual([])
    expect(raw.characterOrder).toEqual([])

    // Settings block survives intact, including API keys — re-entering those by
    // hand is the whole reason this feature exists.
    expect(raw.openAIKey).toBe('sk-test-key-should-survive')
    expect(raw.apiType).toBe('openai')
    expect(raw.mainPrompt).toBe('main prompt text')
    expect(raw.maxContext).toBe(4000)
    expect(raw.selectedPersona).toBe(0)
    expect(raw.loreBookPage).toBe(0)

    // Collections a user would hate to rebuild.
    expect(Array.isArray(raw.modules) && raw.modules.length).toBe(1)
    expect((raw.modules as any[])[0].name).toBe('TestModule')
    expect(Array.isArray(raw.plugins) && (raw.plugins as any[]).length).toBe(1)
    expect(Array.isArray(raw.botPresets) && (raw.botPresets as any[]).length).toBe(1)
    expect(Array.isArray(raw.personas) && (raw.personas as any[]).length).toBe(2)
    expect((raw.personas as any[])[0].personaPrompt).toBe('persona text')
    expect(Array.isArray(raw.loreBook) && (raw.loreBook as any[]).length).toBe(1)

    // Inline (non-asset) preset icon rides along inside the DB blob.
    expect((raw.botPresets as any[])[0].image).toBe('data:image/jpeg;base64,AAAA')
  })

  test('keeps every settings-level asset and drops character art', async () => {
    const client = await seededServer()
    const { bin } = await exportSettingsOnly(client)
    const names = decodeBackup(bin).map(e => e.name)

    for (const asset of SETTINGS_ASSETS) {
      expect(names, `settings asset ${asset} must survive`).toContain(asset)
    }
    for (const asset of CHARACTER_ASSETS) {
      expect(names, `character asset ${asset} must be dropped`).not.toContain(asset)
    }
  })

  test('drops inlay namespaces and cold storage entries', async () => {
    const client = await seededServer()
    const { bin } = await exportSettingsOnly(client)
    const names = decodeBackup(bin).map(e => e.name)

    expect(names).toContain('database.risudat')
    expect(names.some(n => n.startsWith('inlay/'))).toBe(false)
    expect(names.some(n => n.startsWith('inlay_sidecar/'))).toBe(false)
    expect(names.some(n => n.startsWith('inlay_meta/'))).toBe(false)
    expect(names.some(n => n.startsWith('coldstorage'))).toBe(false)

    // Non-vacuity guard. Cold storage KV entries outlive the inline restore on
    // purpose (kept for manual recovery), so the full export still carries one.
    // Without this check the assertion above would silently become meaningless
    // if a future change stopped producing cold storage entries at all.
    const fullNames = decodeBackup(await client.exportBackup()).map(e => e.name)
    expect(fullNames.some(n => n.startsWith('coldstorage'))).toBe(true)
  })

  // Export must be read-only with respect to the character library. The full
  // export path migrates legacy cold storage entries as a side effect
  // (readColdStorageJsonEntry with migrateLegacy), and settings-only skips that
  // enumeration entirely — so this pins down that skipping it neither disturbs
  // nor is disturbed by the source instance's cold storage.
  test('leaves the source instance cold storage intact', async () => {
    const client = await seededServer()

    // Settings-only first: the realistic order for someone who only ever takes
    // settings seeds and never a full backup in between.
    await exportSettingsOnly(client)

    const { normalized } = normalizeBackup(await client.exportBackup())
    const coldChar = normalized.characters.find(c => c.chaId === `cold-char-${COLD_KEY}`)
    expect(coldChar).toBeDefined()
    expect(coldChar!.name).toBe('ColdChar')
    expect(coldChar!.firstMessages).toEqual(['cold hello'])
    expect(normalized.characterCount).toBe(2)
  })

  test('is served under its own filename and an accurate content-length', async () => {
    const client = await seededServer()
    const { res, bin } = await exportSettingsOnly(client)

    // Reused across instances, so it has to be tellable apart from a full backup.
    expect(res.headers.get('content-disposition')).toContain('risu-settings-')
    // content-length is precomputed from the trimmed DB; a mismatch means the
    // stream and the header disagree, which hangs or truncates real downloads.
    expect(Number(res.headers.get('content-length'))).toBe(bin.length)
  })

  test('is smaller than the equivalent full backup', async () => {
    const client = await seededServer()
    const { bin: settingsBin } = await exportSettingsOnly(client)
    const fullBin = await client.exportBackup()
    expect(settingsBin.length).toBeLessThan(fullBin.length)
  })

  test('regular export is unaffected by the settings mode branch', async () => {
    const client = await seededServer()
    const names = decodeBackup(await client.exportBackup()).map(e => e.name)

    expect(names).toEqual(expect.arrayContaining([
      'database.risudat',
      CHAR_IMAGE,
      CHAR_EMOTION,
      'inlay/test-inlay.png',
      'inlay_sidecar/test-inlay',
      'inlay_meta/test-inlay',
    ]))
    const { normalized } = normalizeBackup(await client.exportBackup())
    expect(normalized.characterCount).toBeGreaterThan(0)
  })
})

// Asset-pack modules carry thousands of images and dominate the file size, so
// the confirm dialog offers to leave them out. The definitions still travel;
// only the images are dropped.
describe('settings-only without module assets', () => {
  test('drops module-owned assets but keeps everything else', async () => {
    const client = await seededServer()
    const { bin } = await exportSettingsOnly(client, { moduleAssets: false })
    const names = decodeBackup(bin).map(e => e.name)

    for (const asset of MODULE_ONLY_ASSETS) {
      expect(names, `module-only asset ${asset} must be dropped`).not.toContain(asset)
    }
    for (const asset of NON_MODULE_ASSETS) {
      expect(names, `non-module asset ${asset} must survive`).toContain(asset)
    }
    for (const asset of CHARACTER_ASSETS) {
      expect(names, `character asset ${asset} must be dropped`).not.toContain(asset)
    }
  })

  // The exclusion is a set difference, not a per-reference filter. An asset a
  // module happens to share with a persona icon has a second owner and must
  // survive — dropping it would blank out the persona too.
  test('keeps an asset a module shares with a persona icon', async () => {
    const client = await seededServer()
    const { bin } = await exportSettingsOnly(client, { moduleAssets: false })
    expect(decodeBackup(bin).map(e => e.name)).toContain(SHARED_ASSET)
  })

  test('module definitions still travel without their assets', async () => {
    const client = await seededServer()
    const { bin } = await exportSettingsOnly(client, { moduleAssets: false })
    const { raw } = normalizeBackup(bin)

    const modules = raw.modules as any[]
    expect(modules.length).toBe(1)
    expect(modules[0].name).toBe('TestModule')
    // References stay in place so re-importing the module backfills the images.
    expect(modules[0].assets.length).toBe(2)
  })

  test('is smaller than the same export with module assets', async () => {
    const client = await seededServer()
    const withAssets = await exportSettingsOnly(client)
    const without = await exportSettingsOnly(client, { moduleAssets: false })
    expect(without.bin.length).toBeLessThan(withAssets.bin.length)
    expect(Number(without.res.headers.get('content-length'))).toBe(without.bin.length)
  })
})

describe('settings-only estimate', () => {
  // The dialog's numbers come from this endpoint while the bytes come from the
  // export path. They share buildSettingsOnlyPlan precisely so they can't
  // disagree, and this pins that down.
  test('breakdown matches what the two exports actually produce', async () => {
    const client = await seededServer()

    const res = await client.fetch('/api/backup/export/settings-estimate')
    expect(res.ok).toBe(true)
    const est = await res.json() as {
      dbBytes: number
      baseAssets: { count: number, bytes: number }
      moduleAssets: { count: number, bytes: number, moduleCount: number }
    }

    expect(est.baseAssets.count).toBe(NON_MODULE_ASSETS.length)
    expect(est.moduleAssets.count).toBe(MODULE_ONLY_ASSETS.length)
    expect(est.moduleAssets.moduleCount).toBe(1)
    expect(est.dbBytes).toBeGreaterThan(0)

    // The estimated module-asset cost must equal the real difference between
    // the two exports, entry framing aside — that difference is the number the
    // user is shown when deciding.
    const withAssets = (await exportSettingsOnly(client)).bin.length
    const without = (await exportSettingsOnly(client, { moduleAssets: false })).bin.length
    const framingPerEntry = 8 + MODULE_ASSET.length
    expect(withAssets - without).toBe(est.moduleAssets.bytes + framingPerEntry)
  })

  test('reports no module assets when there are none to weigh', async () => {
    const srv = await spawnServer()
    servers.push(srv)
    const client = await createClient(srv.port, srv.password)
    await client.importBackup(encodeBackup([
      { name: 'database.risudat', data: encodeRisuDat({ characters: [], personas: [], modules: [] }) },
    ]))

    const res = await client.fetch('/api/backup/export/settings-estimate')
    expect(res.ok).toBe(true)
    const est = await res.json() as { moduleAssets: { count: number, bytes: number } }
    expect(est.moduleAssets.count).toBe(0)
    expect(est.moduleAssets.bytes).toBe(0)
  })
})

describe('settings-only round-trip', () => {
  // The whole point: restore the seed onto a fresh instance and confirm it comes
  // up configured but empty. Import is the ordinary full-replace path — nothing
  // about settings-only touches it — so this guards that a trimmed DB is still
  // a *valid* DB the import and re-export path can chew on.
  test('imports into a fresh instance with settings intact and no characters', async () => {
    const source = await seededServer()
    const { bin: settingsBin } = await exportSettingsOnly(source)

    const target = await spawnServer()
    servers.push(target)
    const targetClient = await createClient(target.port, target.password)

    const importResult = await targetClient.importBackup(settingsBin)
    expect(importResult.ok).toBe(true)

    const { raw, normalized } = normalizeBackup(await targetClient.exportBackup())
    expect(normalized.characterCount).toBe(0)
    expect(raw.openAIKey).toBe('sk-test-key-should-survive')
    expect((raw.modules as any[])[0].name).toBe('TestModule')
    expect((raw.personas as any[])[0].icon).toBe(`assets/${PERSONA_ICON}`)

    // Asset payloads have to land as real bytes, not just surviving references.
    const names = decodeBackup(await targetClient.exportBackup()).map(e => e.name)
    for (const asset of SETTINGS_ASSETS) {
      expect(names, `settings asset ${asset} must survive the round-trip`).toContain(asset)
    }
  })
})

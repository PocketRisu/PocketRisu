import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import pkg from './chunkStore.cjs'

const { cdcSplit, createChunkStore } = pkg as {
    cdcSplit: (buf: Buffer) => { hash: string; data: Buffer }[]
    createChunkStore: (
        db: any,
        opts?: { threshold?: number },
    ) => {
        putValue: (key: string, value: Buffer) => void
        getValue: (key: string) => Buffer | null
        sizeValue: (key: string) => number | null
        snapshotCost: (key: string, baseKey: string) => number
        snapshotValue: (srcKey: string, dstKey: string) => void
        dropValue: (key: string) => void
        gc: () => number
        isChunkedKey: (key: string) => boolean
        reclaimableBytes: () => number
    }
}

// Fresh in-memory DB with the same kv schema db.cjs creates (kv is db.cjs's
// domain; chunkStore creates only its own chunks/manifest tables).
function freshDb() {
    const db = new Database(':memory:')
    db.exec(
        'CREATE TABLE kv (key TEXT PRIMARY KEY, value BLOB NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0)',
    )
    return db
}
// Deterministic pseudo-random bytes (LCG) — reproducible so locality/dedup
// assertions never flake on RNG luck.
function seededBytes(n: number, seed = 1): Buffer {
    const out = Buffer.alloc(n)
    let h = seed >>> 0
    for (let i = 0; i < n; i++) {
        h = (Math.imul(h, 1664525) + 1013904223) >>> 0
        out[i] = h >>> 24
    }
    return out
}
const countChunks = (db: any) => db.prepare('SELECT COUNT(*) c FROM chunks').get().c as number
const countChunkBytes = (db: any) =>
    db.prepare('SELECT COALESCE(SUM(LENGTH(data)), 0) b FROM chunks').get().b as number
const countManifest = (db: any, key: string) =>
    db.prepare('SELECT COUNT(*) c FROM manifest_chunks WHERE manifest_key = ?').get(key).c as number

describe('cdcSplit — content-defined chunking (pure)', () => {
    it('A1: 분할한 조각을 다시 이으면 원본과 바이트 동일', () => {
        const buf = randomBytes(200_000)
        const chunks = cdcSplit(buf)
        const reassembled = Buffer.concat(chunks.map((c) => c.data))
        expect(reassembled.equals(buf)).toBe(true)
    })

    it('A1b: 빈 버퍼는 조각 0개, 재조립은 빈 버퍼', () => {
        const chunks = cdcSplit(Buffer.alloc(0))
        expect(chunks).toHaveLength(0)
        expect(Buffer.concat(chunks.map((c) => c.data)).length).toBe(0)
    })

    it('A2: 같은 입력 → 같은 조각(경계·해시 결정적)', () => {
        const buf = randomBytes(200_000)
        const a = cdcSplit(buf).map((c) => c.hash)
        const b = cdcSplit(buf).map((c) => c.hash)
        expect(b).toEqual(a)
    })

    it('A3: 조각 크기가 min/max 경계 준수 (마지막 제외 ≥MIN, 전부 ≤MAX)', () => {
        const chunks = cdcSplit(randomBytes(500_000))
        chunks.forEach((c, i) => {
            expect(c.data.length).toBeLessThanOrEqual(65536)
            if (i < chunks.length - 1) expect(c.data.length).toBeGreaterThanOrEqual(4096)
        })
    })

    it('A4: 중간 삽입 시 변경 조각은 극소수 (CDC 재동기화 → dedup)', () => {
        const buf = seededBytes(2_000_000, 7)
        const at = 1_000_000
        const mutated = Buffer.concat([buf.subarray(0, at), seededBytes(120, 99), buf.subarray(at)])
        const base = cdcSplit(buf)
        const next = cdcSplit(mutated)
        const baseHashes = new Set(base.map((c) => c.hash))
        const changed = next.filter((c) => !baseHashes.has(c.hash))
        // 삽입 지점 한 조각 + 경계 정렬로 최대 몇 개. 버퍼 크기와 무관하게 소수.
        expect(changed.length).toBeLessThanOrEqual(3)
        const rewriteBytes = changed.reduce((s, c) => s + c.data.length, 0)
        expect(rewriteBytes).toBeLessThanOrEqual(3 * 65536) // 최대 3개 max-chunk 분량
    })
})

describe('createChunkStore — chunk-aware kv (injected :memory: db)', () => {
    const T = { threshold: 1024 } // small threshold so test buffers exercise chunking

    it('B1: putValue(big) → getValue 바이트 동일 (라운드트립)', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        const buf = randomBytes(200_000)
        store.putValue('database/database.bin', buf)
        const got = store.getValue('database/database.bin')
        expect(got).not.toBeNull()
        expect((got as Buffer).equals(buf)).toBe(true)
        expect(countManifest(db, 'database/database.bin')).toBeGreaterThan(1) // 실제로 청킹됨
    })

    it('B2: 작은 값(<임계)은 평범한 행 — 청크 0', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        const small = randomBytes(500)
        store.putValue('k', small)
        expect(countChunks(db)).toBe(0)
        expect(countManifest(db, 'k')).toBe(0)
        expect((store.getValue('k') as Buffer).equals(small)).toBe(true)
    })

    it('B3: 레거시 raw BLOB(마커 없음)은 그대로 반환', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        const legacy = randomBytes(50_000) // 마커 없이 직접 박힌 옛 값
        db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, 0)').run('database/database.bin', legacy)
        expect((store.getValue('database/database.bin') as Buffer).equals(legacy)).toBe(true)
    })

    it('B3b: 레거시 값을 putValue로 덮으면 청킹으로 마이그레이션', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, 0)').run('k', randomBytes(50_000))
        const next = randomBytes(200_000)
        store.putValue('k', next)
        expect(countManifest(db, 'k')).toBeGreaterThan(1)
        expect((store.getValue('k') as Buffer).equals(next)).toBe(true)
    })

    it('B4: dedup — 유사 버퍼 2개는 chunks가 델타만큼만 증가', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        const buf1 = randomBytes(200_000)
        store.putValue('k', buf1)
        const n1 = countChunks(db)
        const at = 100_000
        const buf2 = Buffer.concat([buf1.subarray(0, at), randomBytes(120), buf1.subarray(at)])
        store.putValue('k', buf2)
        expect(countChunks(db)).toBeLessThanOrEqual(n1 + 3) // 공유 조각은 INSERT OR IGNORE로 재기록 안 됨
    })

    it('B5: 축소/덮어쓰기 — big→small이면 manifest 비워지고 정확 반환', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        store.putValue('k', randomBytes(200_000))
        expect(countManifest(db, 'k')).toBeGreaterThan(1)
        const small = randomBytes(300)
        store.putValue('k', small)
        expect(countManifest(db, 'k')).toBe(0)
        expect((store.getValue('k') as Buffer).equals(small)).toBe(true)
    })

    it('B6: sizeValue는 논리 크기 반환 (청킹 여부 무관)', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        const big = randomBytes(200_000)
        store.putValue('big', big)
        store.putValue('small', randomBytes(300))
        expect(store.sizeValue('big')).toBe(big.length)
        expect(store.sizeValue('small')).toBe(300)
        expect(store.sizeValue('missing')).toBeNull()
    })

    it('B7: 없는 키는 null', () => {
        const store = createChunkStore(freshDb(), T)
        expect(store.getValue('nope')).toBeNull()
    })

    it('B8: 마커와 정확히 같은 raw 값은 빈 버퍼가 아니라 원본 반환 (오탐 방어)', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        const marker = (pkg as { CHUNK_MARKER: Buffer }).CHUNK_MARKER
        // 청킹 안 거치고 마커와 동일한 바이트를 직접 박음 (천문학적 우연 시뮬)
        db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, 0)').run('k', marker)
        expect((store.getValue('k') as Buffer).equals(marker)).toBe(true)
    })

    it('B9: isChunkedKey — 청킹 키 true, raw/없음 false, 마커가 raw로 덮이면 false', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        store.putValue('big', randomBytes(200_000))
        store.putValue('small', randomBytes(300))
        expect(store.isChunkedKey('big')).toBe(true)
        expect(store.isChunkedKey('small')).toBe(false)
        expect(store.isChunkedKey('missing')).toBe(false)
        // raw 값이 마커를 덮은 stale 상태 → 청킹 아님으로 정확히 판정
        db.prepare("UPDATE kv SET value = ? WHERE key = 'big'").run(Buffer.from('raw'))
        expect(store.isChunkedKey('big')).toBe(false)
    })
})

describe('snapshotValue — 조각 공유 스냅샷 (kvCopyValue 청크 인식)', () => {
    const T = { threshold: 1024 }

    it('C1: 청킹 값 스냅샷 → 바이트 동일 + 조각 중복 없음(공유)', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        const big = randomBytes(200_000)
        store.putValue('live', big)
        const before = countChunks(db)
        store.snapshotValue('live', 'snap')
        expect(countChunks(db)).toBe(before) // 조각 복사 안 함 — 공유
        expect((store.getValue('snap') as Buffer).equals(big)).toBe(true)
        expect((store.getValue('live') as Buffer).equals(big)).toBe(true)
    })

    it('C2: 스냅샷 후 live 변경 → 스냅샷은 옛 바이트 유지', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        const bufA = randomBytes(200_000)
        const bufB = randomBytes(200_000)
        store.putValue('live', bufA)
        store.snapshotValue('live', 'snap')
        store.putValue('live', bufB) // live 갱신 (옛 조각은 GC 전까지 잔존)
        expect((store.getValue('snap') as Buffer).equals(bufA)).toBe(true) // 스냅샷 불변
        expect((store.getValue('live') as Buffer).equals(bufB)).toBe(true)
    })

    it('C3: 작은(raw) 값 스냅샷도 정확 복사', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        const small = randomBytes(300)
        store.putValue('live', small)
        store.snapshotValue('live', 'snap')
        expect((store.getValue('snap') as Buffer).equals(small)).toBe(true)
    })

    it('C4: 없는 src 스냅샷은 dst 무변경 (no-op)', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        store.putValue('snap', randomBytes(300))
        store.snapshotValue('missing', 'snap') // src 없음
        expect((store.getValue('snap') as Buffer).length).toBe(300) // dst 그대로
    })

    it('C5: snapshotCost — live와 같으면 ~0, 갈라지면 델타, raw는 full, 없으면 0', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        const v0 = randomBytes(200_000)
        store.putValue('live', v0)
        store.snapshotValue('live', 'snap')
        expect(store.snapshotCost('snap', 'live')).toBe(0) // 동일 → 공유라 0
        store.putValue('live', randomBytes(200_000)) // live 완전 교체 → snap 조각이 단독
        expect(store.snapshotCost('snap', 'live')).toBeGreaterThan(150_000)
        store.putValue('rawsnap', randomBytes(500)) // < 임계 → raw
        expect(store.snapshotCost('rawsnap', 'live')).toBe(500)
        expect(store.snapshotCost('missing', 'live')).toBe(0)
    })
})

describe('gc — mark-sweep (참조 없는 조각만 삭제)', () => {
    const T = { threshold: 1024 }

    it('D1: 고아 조각(manifest 없음)은 삭제됨', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        store.putValue('k', randomBytes(200_000))
        const n = countChunks(db)
        expect(n).toBeGreaterThan(1)
        store.dropValue('k') // manifest 제거 → 조각 전부 고아
        expect(countChunks(db)).toBe(n) // 아직 잔존 (GC 전)
        expect(store.gc()).toBe(n) // GC가 n개 삭제
        expect(countChunks(db)).toBe(0)
    })

    it('D2: live가 참조하는 조각은 삭제 안 됨', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        const big = randomBytes(200_000)
        store.putValue('live', big)
        const n = countChunks(db)
        expect(store.gc()).toBe(0)
        expect(countChunks(db)).toBe(n)
        expect((store.getValue('live') as Buffer).equals(big)).toBe(true)
    })

    it('D3: 스냅샷에만 있는 조각은 GC에서 생존 (유일 위험 봉쇄)', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        const bufA = randomBytes(200_000)
        const bufB = randomBytes(200_000)
        store.putValue('live', bufA)
        store.snapshotValue('live', 'snap') // snap → bufA
        store.putValue('live', bufB) // live → bufB, bufA는 이제 snap만 참조
        store.gc() // bufA 조각을 지우면 안 됨
        expect((store.getValue('snap') as Buffer).equals(bufA)).toBe(true) // 스냅샷 생존 ✓
        expect((store.getValue('live') as Buffer).equals(bufB)).toBe(true)
    })

    it('D4: 스냅샷 로테이션(manifest 삭제) 후 그 조각만 회수, live 무사', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        const bufA = randomBytes(200_000)
        const bufB = randomBytes(200_000)
        store.putValue('live', bufA)
        store.snapshotValue('live', 'snap')
        store.putValue('live', bufB)
        const nb = countManifest(db, 'live') // bufB 조각 수
        store.dropValue('snap') // 로테이션 → bufA 조각 고아
        store.gc()
        expect(countChunks(db)).toBe(nb) // bufB 조각만 남음
        expect((store.getValue('live') as Buffer).equals(bufB)).toBe(true)
    })

    it('D5: GC 멱등 — 두 번째 실행은 0 삭제, 무변경', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        store.putValue('k', randomBytes(200_000))
        store.dropValue('k')
        store.gc()
        const after = countChunks(db)
        expect(store.gc()).toBe(0)
        expect(countChunks(db)).toBe(after)
    })

    it('D6: 스냅샷 로테이션 — dropValue로 삭제한 스냅샷 전용 조각만 회수, 산 스냅샷·live 보존', () => {
        // db.cjs의 kvDel→dropValue 경로가 의존하는 시나리오 (회귀 가드).
        const db = freshDb()
        const store = createChunkStore(db, T)
        const v0 = randomBytes(200_000)
        store.putValue('live', v0)
        store.snapshotValue('live', 'snapA') // snapA → v0
        const v1 = Buffer.concat([v0.subarray(0, 100_000), randomBytes(120), v0.subarray(100_000)])
        store.putValue('live', v1)
        store.snapshotValue('live', 'snapB') // snapB → v1
        store.dropValue('snapA') // 로테이션 = manifest까지 삭제
        store.gc()
        // snapB·live는 바이트 동일 유지
        expect((store.getValue('snapB') as Buffer).equals(v1)).toBe(true)
        expect((store.getValue('live') as Buffer).equals(v1)).toBe(true)
        // gc 후 고아 0 (v0 전용 조각이 회수됨)
        const distinct = db.prepare('SELECT COUNT(DISTINCT hash) c FROM manifest_chunks').get().c as number
        expect(countChunks(db)).toBe(distinct)
    })

    it('D6b: reclaimableBytes = 고아 바이트, 무관한 raw kv 값 다수에 영향 없음 (perf 회귀 가드)', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        store.putValue('database/database.bin', randomBytes(200_000)) // v1
        const v1Bytes = countChunkBytes(db)
        store.putValue('database/database.bin', randomBytes(200_000)) // v2 → v1 조각 고아
        // assets 시뮬: 마커 아닌 raw kv 값 다수. correlated 쿼리는 이걸 안 스캔해야 정확+빠름.
        for (let i = 0; i < 100; i++) {
            db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, 0)').run('assets/' + i, randomBytes(500))
        }
        expect(store.reclaimableBytes()).toBe(v1Bytes) // 고아 = v1 조각 바이트, raw 값 무관
        expect(store.gc()).toBeGreaterThan(0)
        expect(store.reclaimableBytes()).toBe(0) // 회수 후 0
    })

    it('D7: kv 키 없는 stale manifest 자가치유 — 정리 + 누수 조각 회수, live 무사', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        store.putValue('live', randomBytes(200_000))
        store.snapshotValue('live', 'snap')
        store.putValue('live', randomBytes(200_000)) // live 교체 → snap 조각이 snap 전용이 됨
        // 옛 버그 시뮬: manifest는 남기고 kv 행만 삭제 (raw kvDel이 하던 짓)
        db.prepare("DELETE FROM kv WHERE key = 'snap'").run()
        expect(countManifest(db, 'snap')).toBeGreaterThan(0) // stale manifest 잔존
        const before = countChunks(db)
        store.gc()
        expect(countManifest(db, 'snap')).toBe(0) // stale manifest 정리됨
        expect(countChunks(db)).toBeLessThan(before) // snap 전용 조각 회수됨
        expect((store.getValue('live') as Buffer).length).toBeGreaterThan(0) // live 무사
    })

    it('D8: raw 값이 마커를 덮은 stale manifest도 자가치유 (kv 키는 있지만 마커 아님)', () => {
        const db = freshDb()
        const store = createChunkStore(db, T)
        store.putValue('live', randomBytes(200_000))
        store.snapshotValue('live', 'snap')
        store.putValue('live', randomBytes(200_000)) // snap 조각이 단독이 됨
        // 옛/누락 경로 시뮬: snap의 kv 값을 raw로 덮되 manifest는 남김
        db.prepare("UPDATE kv SET value = ? WHERE key = 'snap'").run(Buffer.from('raw not marker'))
        expect(countManifest(db, 'snap')).toBeGreaterThan(0)
        const before = countChunks(db)
        store.gc() // 마커 아님 → stale로 판정해 정리
        expect(countManifest(db, 'snap')).toBe(0)
        expect(countChunks(db)).toBeLessThan(before)
        expect((store.getValue('live') as Buffer).length).toBeGreaterThan(0)
    })
})

import { describe, expect, test, vi } from 'vitest';

// Mock heavy deps so importing risuSave.ts doesn't pull the Svelte runtime or
// trigger module-level side effects (mirrors risuSavePatcher.test.ts).
vi.mock('./database.svelte', () => ({}));
vi.mock('./chatStorage', () => ({ chatToStub: (c: any) => c }));
vi.mock('../globalApi.svelte', () => ({ forageStorage: { realStorage: null } }));

const { normalizeJSON } = await import('./risuSave');

describe('normalizeJSON path-based cycle detection', () => {
    test('shared (non-circular) object appearing twice survives in both places', () => {
        const shared = { key: 'apiKey', type: 'string' };
        const result = normalizeJSON({ a: [shared], b: [shared] });
        expect(result).toEqual({
            a: [{ key: 'apiKey', type: 'string' }],
            b: [{ key: 'apiKey', type: 'string' }],
        });
        // Explicit regression guard: second occurrence must NOT be nulled.
        expect(result.b[0]).not.toBeNull();
    });

    test('real circular reference is replaced with null without infinite loop', () => {
        const o: any = {};
        o.self = o;
        const result = normalizeJSON(o);
        expect(result).toEqual({ self: null });
    });

    test('shared object referenced twice at sibling array indices survives in both', () => {
        const shared = { key: 'apiKey', type: 'string' };
        const result = normalizeJSON([shared, shared]);
        expect(result).toEqual([
            { key: 'apiKey', type: 'string' },
            { key: 'apiKey', type: 'string' },
        ]);
        expect(result[1]).not.toBeNull();
    });
});

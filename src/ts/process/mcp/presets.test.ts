import { describe, expect, test } from 'vitest'
import { getMcpModulePresets } from './presets'

const incumbentPresets: [string, string][] = [
    ['internal:aiaccess', 'LLM Call Client (internal:aiaccess)'],
    ['internal:risuai', 'Risu Access Client (internal:risuai)'],
    ['internal:fs', 'File System Client (internal:fs)'],
    ['internal:googlesearch', 'Google Search Client (internal:googlesearch)'],
    ['internal:dice', 'Dice Tool Client (internal:dice)'],
    ['internal:graphmem', 'Graph Memory Client (internal:graphmem)'],
    ['https://mcp.paypal.com/sse', 'PayPal MCP (https://mcp.paypal.com/sse)'],
    ['https://mcp.linear.app/sse', 'Linear MCP (https://mcp.linear.app/sse)'],
    ['https://rag-mcp-2.whatsmcp.workers.dev/sse', 'OneContext MCP (https://rag-mcp-2.whatsmcp.workers.dev/sse)'],
    ['https://browser.mcp.cloudflare.com/sse', 'Cloudflare Browser MCP (https://browser.mcp.cloudflare.com/sse)'],
    ['https://mcp.deepwiki.com/mcp', 'DeepWiki MCP (https://mcp.deepwiki.com/mcp)'],
]

describe('MCP module presets', () => {
    test('preserves incumbent presets and appends Parallel Search', () => {
        const presets = getMcpModulePresets()

        expect(presets.slice(0, incumbentPresets.length)).toEqual(incumbentPresets)
        expect(presets.at(-1)).toEqual([
            'https://search.parallel.ai/mcp',
            'Parallel Search MCP (https://search.parallel.ai/mcp)',
        ])
        expect(presets.filter(([value]) => value === 'https://search.parallel.ai/mcp')).toHaveLength(1)
    })

    test('returns fresh tuples for each import prompt', () => {
        const first = getMcpModulePresets()
        first[0][0] = 'mutated'

        expect(getMcpModulePresets()[0]).toEqual(incumbentPresets[0])
    })
})

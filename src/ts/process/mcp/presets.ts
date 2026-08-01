const MCP_MODULE_PRESETS = [
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
    ['https://search.parallel.ai/mcp', 'Parallel Search MCP (https://search.parallel.ai/mcp)'],
] as const

export function getMcpModulePresets(): [string, string][] {
    return MCP_MODULE_PRESETS.map(([value, label]) => [value, label])
}

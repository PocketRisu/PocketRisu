import { describe, expect, test } from 'vitest'
import { getBundledRegistryId, loadBundledRegistry } from './loader'

const EXPECTED_BASE_PROVIDER_IDS = [
    'anthropic',
    'anthropic-compatible',
    'bedrock',
    'bedrock-anthropic',
    'deepinfra',
    'deepseek',
    'google',
    'lightning-ai',
    'nanogpt',
    'ollama',
    'ollama-cloud',
    'openai',
    'openai-compatible',
    'openrouter',
    'vercel',
    'vertex-gemini-native',
    'vertex-openai',
    'wellspring',
]

const EXPECTED_PROFILE_IDS = [
    'anthropic-compatible:custom',
    'anthropic-compatible:custom-noauth',
    'anthropic:fable-5',
    'anthropic:haiku-45',
    'anthropic:opus-4',
    'anthropic:opus-41',
    'anthropic:opus-45',
    'anthropic:opus-46',
    'anthropic:opus-47',
    'anthropic:opus-48',
    'anthropic:sonnet-4',
    'anthropic:sonnet-45',
    'anthropic:sonnet-46',
    'bedrock-anthropic:custom',
    'bedrock:openai-compatible',
    'deepinfra:openai-compatible',
    'deepseek:v4-flash',
    'deepseek:v4-flash-thinking',
    'deepseek:v4-pro',
    'deepseek:v4-pro-thinking',
    'google:gemini-25-flash',
    'google:gemini-25-flash-lite',
    'google:gemini-25-pro',
    'google:gemini-3-flash',
    'google:gemini-31-flash-lite',
    'google:gemini-31-pro',
    'google:gemini-35-flash',
    'google:gemma-4-26b',
    'google:gemma-4-31b',
    'lightning-ai:claude-haiku-45',
    'lightning-ai:claude-opus-47',
    'lightning-ai:claude-opus-48',
    'lightning-ai:claude-sonnet-46',
    'lightning-ai:deepseek-v4-pro',
    'lightning-ai:gemini-3-flash',
    'lightning-ai:gemini-31-pro',
    'lightning-ai:gemini-35-flash',
    'lightning-ai:glm-5',
    'lightning-ai:gpt-5',
    'lightning-ai:gpt-5-mini',
    'lightning-ai:gpt-5-nano',
    'lightning-ai:gpt-54',
    'lightning-ai:gpt-54-mini',
    'lightning-ai:gpt-54-nano',
    'lightning-ai:gpt-55',
    'lightning-ai:gpt-oss-120b',
    'lightning-ai:kimi-k25',
    'lightning-ai:nemotron-3-ultra',
    'lightning-ai:openai-compatible',
    'nanogpt:deepseek-v4-flash',
    'nanogpt:deepseek-v4-pro',
    'nanogpt:gemma-4-31b',
    'nanogpt:glm-51',
    'nanogpt:gpt-oss-120b',
    'nanogpt:kimi-k26',
    'nanogpt:openai-compatible',
    'ollama-cloud:deepseek-v4-flash',
    'ollama-cloud:deepseek-v4-pro',
    'ollama-cloud:gemini-3-flash',
    'ollama-cloud:gemma-4-31b',
    'ollama-cloud:glm-51',
    'ollama-cloud:gpt-oss-120b',
    'ollama-cloud:kimi-k26',
    'ollama-cloud:standard',
    'ollama:openai-compatible-local',
    'openai-compatible:custom',
    'openai-compatible:custom-noauth',
    'openai:gpt-4',
    'openai:gpt-41',
    'openai:gpt-41-mini',
    'openai:gpt-4o',
    'openai:gpt-4o-mini',
    'openai:gpt-5',
    'openai:gpt-5-mini',
    'openai:gpt-5-nano',
    'openai:gpt-51',
    'openai:gpt-52',
    'openai:gpt-54',
    'openai:gpt-54-mini',
    'openai:gpt-54-nano',
    'openai:gpt-55',
    'openai:o3',
    'openrouter:claude-fable-5',
    'openrouter:claude-opus-46',
    'openrouter:claude-opus-47',
    'openrouter:claude-opus-48',
    'openrouter:claude-sonnet-46',
    'openrouter:deepseek-v4-flash',
    'openrouter:deepseek-v4-pro',
    'openrouter:gemini-3-flash',
    'openrouter:gemini-31-flash-lite',
    'openrouter:gemini-31-pro',
    'openrouter:gemini-35-flash',
    'openrouter:gemma-4-26b',
    'openrouter:gemma-4-31b',
    'openrouter:glm-51',
    'openrouter:gpt-5',
    'openrouter:gpt-5-mini',
    'openrouter:gpt-5-nano',
    'openrouter:gpt-51',
    'openrouter:gpt-52',
    'openrouter:gpt-54',
    'openrouter:gpt-54-mini',
    'openrouter:gpt-54-nano',
    'openrouter:gpt-55',
    'openrouter:kimi-k26',
    'openrouter:openai-compatible',
    'vercel:claude-fable-5',
    'vercel:claude-opus-46',
    'vercel:claude-opus-47',
    'vercel:claude-opus-48',
    'vercel:claude-sonnet-46',
    'vercel:deepseek-v4-flash',
    'vercel:deepseek-v4-pro',
    'vercel:gemini-3-flash',
    'vercel:gemini-31-flash-lite',
    'vercel:gemini-31-pro',
    'vercel:gemini-35-flash',
    'vercel:gemma-4-26b',
    'vercel:gemma-4-31b',
    'vercel:glm-51',
    'vercel:gpt-5',
    'vercel:gpt-5-mini',
    'vercel:gpt-5-nano',
    'vercel:gpt-51-instant',
    'vercel:gpt-51-thinking',
    'vercel:gpt-52',
    'vercel:gpt-54',
    'vercel:gpt-54-mini',
    'vercel:gpt-54-nano',
    'vercel:gpt-55',
    'vercel:kimi-k26',
    'vercel:openai-compatible',
    'vertex-gemini-native:flash',
    'vertex-gemini-native:gemini-25-flash',
    'vertex-gemini-native:gemini-25-flash-lite',
    'vertex-gemini-native:gemini-25-pro',
    'vertex-gemini-native:gemini-3-flash',
    'vertex-gemini-native:gemini-31-flash-lite',
    'vertex-gemini-native:gemini-31-pro',
    'vertex-gemini-native:gemini-35-flash',
    'vertex-gemini-native:pro',
    'vertex-openai:standard',
    'wellspring:deepseek-v32-marp',
    'wellspring:deepseek-v4-flash',
    'wellspring:deepseek-v4-pro',
    'wellspring:gemma-4-31b',
    'wellspring:glm-51-code',
    'wellspring:glm-51-marp',
]

describe('loadBundledRegistry', () => {
    test('produces a v4 registry cache with the bundled registry id', () => {
        const registry = loadBundledRegistry()
        expect(registry.schemaVersion).toBe(4)
        expect(Object.keys(registry.registries)).toEqual([getBundledRegistryId()])
    })

    test('exposes every bundled base provider keyed by id', () => {
        const registry = loadBundledRegistry()
        const baseProviders = registry.registries[getBundledRegistryId()]?.baseProviders ?? {}
        expect(Object.keys(baseProviders).sort()).toEqual(EXPECTED_BASE_PROVIDER_IDS)
        for (const id of EXPECTED_BASE_PROVIDER_IDS) {
            expect(baseProviders[id]?.id).toBe(id)
            expect(baseProviders[id]?.requestSchema.length).toBeGreaterThan(0)
        }
    })

    test('exposes every bundled profile keyed by id', () => {
        const registry = loadBundledRegistry()
        const profiles = registry.registries[getBundledRegistryId()]?.profiles ?? {}
        expect(Object.keys(profiles).sort()).toEqual(EXPECTED_PROFILE_IDS)
        for (const id of EXPECTED_PROFILE_IDS) {
            expect(profiles[id]?.id).toBe(id)
            expect(['current', 'outdated', 'deprecated']).toContain(profiles[id]?.profileStatus)
        }
    })

    test('returns a stable singleton on repeated load', () => {
        const first = loadBundledRegistry()
        const second = loadBundledRegistry()
        expect(second).toBe(first)
    })
})

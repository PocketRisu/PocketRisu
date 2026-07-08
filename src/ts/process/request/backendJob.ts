import { getCurrentCharacter, getCurrentChat, getDatabase, type character, type Chat } from "../../storage/database.svelte";
import type { ModelModeExtended } from "./shared";
import { requestChatData, type requestDataArgument, type requestDataResponse, type StreamResponseChunk } from "./request";
import { resolveChatModelBinding, buildModelPresetCredential } from "./modelPresetBinding";
import { getModelPresetBackendExecutionSupport } from "../../preset/backendExecutionSupport";
import type { ModelPreset } from "../../preset/types";
import { v4 as uuidv4 } from "uuid";
import {
    startStatus, setKind, markPhase, appendText, addBadge, endStatus, setStepStatus, setPendingStepsSkipped,
    type StatusBadge, type PipelineStepStatus,
} from "../../status/requestStatus";
import { language } from "../../../lang";
const MULTIAGENT_VAULT_KEY = 'risu_multiagent_lite_config_vault_v1';

// Request-status indicator bridge (gated by db.requestStatusDisplayMode).
// Wrapped so status reporting can never throw into the backend stream path.
interface BackendStatusInfo {
    genId: string;
    label: string;
    chatId?: string;
    // Stable chat-room id, distinct from `chatId` above (which — in this
    // backend-job path — already happens to BE the room id, but the plain
    // model-preset path's `chatId` is the generationId instead; `roomId` is
    // the field renderers should rely on for "which open chat is this").
    roomId?: string;
}

const AGENT_STATUS_TO_STEP: Record<string, PipelineStepStatus> = {
    start: 'active',
    done: 'done',
    error: 'error',
    skipped: 'skipped',
};

// The 3 MultiAgent sub-agent names/step keys, fixed by the server-side
// pipeline (server/node/multiagent.cjs). Used both to predict step keys and to
// self-heal any that never actually started (invalid config, disabled agent).
const MULTIAGENT_AGENT_NAMES = ['worldbuilding', 'plot', 'character'];
const MULTIAGENT_STEP_KEYS = MULTIAGENT_AGENT_NAMES.map((name) => `ma-${name}`);

function backendStatusEnabled(): boolean {
    try {
        return getDatabase()?.requestStatusDisplayMode !== 'none';
    } catch {
        return false;
    }
}

function safeStatus(fn: () => void): void {
    try { fn(); } catch (e) { console.error('[BackendJob] status publish failed', e); }
}

// Per-agent badge for the MultiAgent pipeline (worldbuilding/plot/character),
// shown on the status indicator so each agent's progress/completion is visible.
function multiagentAgentLabel(name: string): string {
    const rs = language.requestStatus as Record<string, string> | undefined;
    switch (name) {
        case 'worldbuilding': return rs?.agentWorldbuilding ?? 'World';
        case 'plot': return rs?.agentPlot ?? 'Plot';
        case 'character': return rs?.agentCharacter ?? 'Character';
        default: return name;
    }
}

function multiagentAgentBadge(name: string, agentStatus: string): StatusBadge {
    const label = multiagentAgentLabel(name);
    const key = `ma-${name}`;
    switch (agentStatus) {
        case 'done': return { key, text: `${label} ✓`, tone: 'success' };
        case 'error': return { key, text: `${label} ✗`, tone: 'warn' };
        case 'skipped': return { key, text: `${label} —`, tone: 'info' };
        default: return { key, text: `${label} …`, tone: 'info' };
    }
}

// Derive the multiagent connection fields from a PocketRisu model preset so the
// analysis agent can reuse an existing key/endpoint/model. Only OpenAI-compatible
// presets are supported — that is the multiagent backend's primary agent wire
// (`POST {baseUrl}/chat/completions`); other adapter kinds keep manual entry.
// endpoint.url is the full chat/completions URL, so strip that suffix to get the
// base the backend re-appends. Returns null when the preset can't supply a key.
function deriveMultiagentFromPreset(preset: ModelPreset): Record<string, any> | null {
    if (preset.profileSnapshot.adapterKind !== 'openai-compatible') return null;
    const apiKey = buildModelPresetCredential(preset)?.apiKey;
    if (!apiKey) return null;
    const fullUrl = preset.profileSnapshot.endpoint?.url ?? '';
    const baseUrl = fullUrl.replace(/\/chat\/completions\/?(\?.*)?$/, '');
    return {
        provider: 'openai',
        apiKey,
        baseUrl,
        model: preset.profileSnapshot.modelId,
    };
}

function readMultiagentConfig(): Record<string, any> | null {
    const db = getDatabase();
    // Native config first — no plugin install/setup required. The backend
    // (server/node/multiagent.cjs) supplies built-in agent prompts, so only
    // an apiKey is strictly required for the pipeline to run.
    const native = db.backendMultiagentConfig;
    if (native) {
        const conf: Record<string, any> = { ...native };
        // Optional: reuse a model preset's key/endpoint/model for the connection.
        if (native.sourcePresetId) {
            const preset = (db.modelPresets ?? []).find((p) => p.id === native.sourcePresetId);
            const derived = preset ? deriveMultiagentFromPreset(preset) : null;
            if (derived) Object.assign(conf, derived);
        }
        if (conf.apiKey) return conf;
    }
    // Backward compatibility: fall back to the MultiAgent browser plugin's
    // config vault for users who configured it before native settings existed.
    try {
        const raw = db.pluginCustomStorage?.[MULTIAGENT_VAULT_KEY];
        if (!raw) return null;
        const vault = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!vault || vault.scope !== 'lite' || !vault.config) return null;
        const config = vault.config;
        if (!config.apiKey) return null;
        return config;
    } catch {
        return null;
    }
}

interface ChatJobTarget {
    chaId: string;
    chatIndex: number;
    chatId: string;
    messageIndex: number;
}

interface ChatJobDescriptor {
    url: string;
    body: Record<string, any>;
    headers: Record<string, string>;
    multiagent?: Record<string, any>;
    // Server-side HypaV3 memory pipeline (see hypaMemoryCore.cjs). When set,
    // body.messages contains a placeholder the server replaces with the
    // assembled memory prompt before the main generation.
    memory?: Record<string, any>;
}

type ChatJobState = 'pending' | 'running' | 'done' | 'error' | 'cancelled';

interface ChatJobStatus {
    id?: string;
    jobId?: string;
    status: ChatJobState;
    text: string;
    error: string | null;
    finishReason: string | null;
    target: ChatJobTarget;
    updatedAt?: number;
    updatedMemory?: any;
}

// Persists HypaV3 memory data produced by the server-side memory pipeline
// into the job's target chat. Idempotent — later applications simply
// overwrite with the same object.
function applyUpdatedMemoryToTarget(target: ChatJobTarget, updatedMemory: any) {
    if (!updatedMemory || !target) return;
    try {
        const db = getDatabase();
        const char = db.characters?.find((c) => c.chaId === target.chaId);
        if (!char) return;
        const chat = char.chats?.find((c) => c.id === target.chatId) ?? char.chats?.[target.chatIndex];
        if (!chat) return;
        chat.hypaV3Data = updatedMemory;
    } catch (error) {
        console.error('[BackendJob] Failed to apply updated memory', error);
    }
}

const STREAM_RENDER_INTERVAL_MS = 40;
const STREAM_RECONNECT_DELAY_MS = 500;
const resumingJobIds = new Set<string>();

function parseDescriptor(response: requestDataResponse): ChatJobDescriptor | null {
    if (response.type !== 'success') return null;
    try {
        const descriptor = JSON.parse(response.result) as ChatJobDescriptor;
        if (!descriptor?.url || !descriptor?.body || !descriptor?.headers) return null;
        return descriptor;
    } catch {
        return null;
    }
}

async function authenticatedBackendFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const { forageStorage } = await import('../../globalApi.svelte');
    return forageStorage.authenticatedFetch(input, init);
}

function sleep(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function acknowledgeTarget(target: ChatJobTarget) {
    await authenticatedBackendFetch('/api/chat-job/result/ack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chaId: target.chaId,
            chatId: target.chatId,
            messageIndex: target.messageIndex,
        }),
    }).catch(() => {});
}

/**
 * Runs a chat generation as a backend job.
 *
 * OpenAI-compatible model presets are prepared through the normal request path
 * in preview mode, then handed to the Node server. This includes providers such
 * as Vercel AI Gateway and OpenRouter because their presets use the same wire
 * format. Native Anthropic/Gemini adapters and presets with browser-side tool
 * execution continue on the foreground path instead of silently losing features.
 */
export async function requestChatDataBackend(
    arg: requestDataArgument,
    model: ModelModeExtended,
    abortSignal: AbortSignal = null
): Promise<requestDataResponse> {
    const db = getDatabase();
    // A planned server-side memory pipeline means body.messages contains a
    // placeholder only the server resolves — never fall back to a foreground
    // request with it, or the placeholder would be sent to the model as-is.
    const memoryPipeline = arg.hypaBackendPipeline;
    const memoryGuardedFallback = async (reason: string): Promise<requestDataResponse> => {
        if (memoryPipeline) {
            return { type: 'fail', result: `Backend memory pipeline cannot run: ${reason}` };
        }
        return await requestChatData(arg, model, abortSignal);
    };

    if (!db.useBackendChatJobs) {
        return await memoryGuardedFallback('backend chat jobs disabled');
    }

    const binding = resolveChatModelBinding(getCurrentChat(), model);
    let descriptorResponse: requestDataResponse;
    let descriptor: ChatJobDescriptor | null = null;

    if (binding.kind === 'modelPreset') {
        const support = getModelPresetBackendExecutionSupport(binding.preset);
        if (!support.supported) {
            console.info('[BackendJob] Model preset uses foreground execution', {
                preset: binding.preset.name,
                adapterKind: binding.preset.profileSnapshot.adapterKind,
                reason: support.code,
            });
            return await memoryGuardedFallback('model preset uses foreground execution');
        }

        descriptorResponse = await requestChatData(
            { ...arg, previewBody: true, useStreaming: true, skipBeforeRequestHooks: true },
            model,
            abortSignal
        );
        descriptor = parseDescriptor(descriptorResponse);
        if (!descriptor) {
            if (memoryPipeline) {
                return { type: 'fail', result: 'Backend memory pipeline cannot run: descriptor build failed' };
            }
            return descriptorResponse;
        }

        const caps = binding.preset.profileSnapshot.capabilities;
        descriptor.body.stream = !caps || caps.includes('streaming');
    } else {
        descriptorResponse = await requestChatData(
            { ...arg, backendJob: true, useStreaming: true, skipBeforeRequestHooks: true },
            model,
            abortSignal
        );
        descriptor = parseDescriptor(descriptorResponse);
        if (!descriptor) {
            if (memoryPipeline) {
                return { type: 'fail', result: 'Backend memory pipeline cannot run: descriptor build failed' };
            }
            return descriptorResponse;
        }
    }

    if (memoryPipeline) {
        descriptor.memory = memoryPipeline as unknown as Record<string, any>;
    }

    if (db.useBackendMultiagent) {
        const multiagentConfig = readMultiagentConfig();
        if (multiagentConfig) {
            descriptor.multiagent = multiagentConfig;
        }
    }

    const currentChar = getCurrentCharacter();
    const currentChat = getCurrentChat();
    if (!currentChar || !currentChat) {
        return { type: 'fail', result: 'No active chat for backend job' };
    }

    const target: ChatJobTarget = {
        chaId: currentChar.chaId,
        chatIndex: currentChar.chatPage ?? 0,
        chatId: currentChat.id || (currentChar.chatPage ?? 0).toString(),
        // For "continue", the AI message being extended is the last one (length - 1).
        // For a new reply, the message will be pushed at the current length.
        messageIndex: arg.continue ? currentChat.message.length - 1 : currentChat.message.length,
    };

    const startRes = await authenticatedBackendFetch('/api/chat-job/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ descriptor, target }),
        signal: abortSignal,
    });

    if (!startRes.ok) {
        const text = await startRes.text().catch(() => '');
        return { type: 'fail', result: `Backend job start failed: ${startRes.status} ${text}` };
    }

    const { jobId } = await startRes.json();
    if (!jobId) {
        return { type: 'fail', result: 'Backend job start returned no jobId' };
    }

    if (abortSignal?.aborted) {
        await authenticatedBackendFetch(`/api/chat-job/${jobId}/cancel`, { method: 'POST' }).catch(() => {});
        return { type: 'fail', result: 'Aborted' };
    }

    // Status-indicator info: reuse the message generationId (arg.chatId) as the
    // entry key so it lines up with the rest of the pipeline; mint a memory-only
    // key for aux requests that carry none. uuid v4 (not crypto.randomUUID) works
    // over plain HTTP. Label = bound preset name, else the resolved model id.
    const status: BackendStatusInfo | null = backendStatusEnabled()
        ? {
            genId: arg.chatId ?? `backend-${uuidv4()}`,
            label: binding.kind === 'modelPreset'
                ? binding.preset.name
                : (descriptorResponse.model || ''),
            chatId: target.chatId,
            roomId: target.chatId,
        }
        : null;

    return {
        type: 'streaming',
        result: createBackendJobStream(jobId, target, abortSignal, status),
        model: descriptorResponse.model,
    };
}

function createBackendJobStream(
    jobId: string,
    target: ChatJobTarget,
    abortSignal: AbortSignal = null,
    status: BackendStatusInfo | null = null,
): ReadableStream<StreamResponseChunk> {
    return new ReadableStream<StreamResponseChunk>({
        start(controller) {
            let closed = false;
            let connectionController: AbortController | null = null;
            let flushTimer: ReturnType<typeof setTimeout> | null = null;
            let pendingText: string | null = null;
            let lastQueuedText = '';

            // Request-status indicator state. The backend sends cumulative text in
            // each chunk, so track what we've already reported to derive deltas
            // for appendText (which accumulates). statusEnded guards idempotency.
            let lastStatusText = '';
            let statusEnded = false;
            if (status) {
                safeStatus(() => startStatus(status.genId, {
                    kind: 'main',
                    label: status.label,
                    chatId: status.chatId,
                    roomId: status.roomId,
                    phase: 'connecting',
                    now: Date.now(),
                }));
            }
            const reportStatusText = (text: string) => {
                if (!status || statusEnded) return;
                const delta = text.startsWith(lastStatusText)
                    ? text.slice(lastStatusText.length)
                    : text;
                lastStatusText = text;
                if (delta) safeStatus(() => appendText(status.genId, { response: delta }, Date.now()));
            };
            const endStatusOnce = (outcome: 'done' | 'failed' | 'aborted', error?: string) => {
                if (!status || statusEnded) return;
                statusEnded = true;
                safeStatus(() => endStatus(status.genId, outcome, { now: Date.now(), error }));
            };

            const clearFlushTimer = () => {
                if (flushTimer) {
                    clearTimeout(flushTimer);
                    flushTimer = null;
                }
            };

            const flushText = () => {
                clearFlushTimer();
                if (closed || pendingText === null || pendingText === lastQueuedText) return;
                lastQueuedText = pendingText;
                pendingText = null;
                controller.enqueue({ text: lastQueuedText });
            };

            const queueText = (text: string, immediate = false) => {
                if (closed || typeof text !== 'string' || text === lastQueuedText) return;
                pendingText = text;
                if (immediate) {
                    flushText();
                    return;
                }
                if (!flushTimer) {
                    flushTimer = setTimeout(flushText, STREAM_RENDER_INTERVAL_MS);
                }
            };

            const close = (acknowledge = true) => {
                if (closed) return;
                flushText();
                closed = true;
                clearFlushTimer();
                connectionController?.abort();
                endStatusOnce('done');
                if (acknowledge) void acknowledgeTarget(target);
                try { controller.close(); } catch { /* ignore */ }
            };

            const fail = (reason: string, acknowledge = true) => {
                if (closed) return;
                flushText();
                closed = true;
                clearFlushTimer();
                connectionController?.abort();
                endStatusOnce(reason === 'Aborted' ? 'aborted' : 'failed', reason === 'Aborted' ? undefined : reason);
                if (acknowledge) void acknowledgeTarget(target);
                try { controller.error(new Error(reason)); } catch { /* ignore */ }
            };

            const handleEvent = (data: any) => {
                if (!data || closed) return;
                // Phase hint from the server: flip the status-indicator chip between
                // the server-side MultiAgent pipeline and main prompt generation.
                if (data.type === 'phase') {
                    if (!status || statusEnded) return;
                    if (data.phase === 'memory') {
                        safeStatus(() => { setKind(status.genId, 'memory', Date.now()); markPhase(status.genId, 'thinking', Date.now()); });
                    } else if (data.phase === 'multiagent') {
                        safeStatus(() => { setKind(status.genId, 'multiagent', Date.now()); markPhase(status.genId, 'thinking', Date.now()); });
                    } else if (data.phase === 'main') {
                        safeStatus(() => {
                            // Self-heal: MultiAgent was predicted from toggles but
                            // never actually ran this turn (invalid config, no
                            // agents-init ever arrived) — don't leave those steps
                            // stuck pending.
                            setPendingStepsSkipped(status.genId, MULTIAGENT_STEP_KEYS, Date.now());
                            setStepStatus(status.genId, 'generation', 'active', { now: Date.now(), onlyIf: ['pending'] });
                            setKind(status.genId, 'main', Date.now());
                            markPhase(status.genId, 'connecting', Date.now());
                        });
                    }
                    return;
                }
                // Per-agent MultiAgent progress → status-indicator badges + steps.
                if (data.type === 'agent') {
                    if (!status || statusEnded) return;
                    if (data.phase === 'agents-init' && Array.isArray(data.agents)) {
                        for (const name of data.agents) {
                            safeStatus(() => addBadge(status.genId, multiagentAgentBadge(name, 'start')));
                        }
                        // Agents the server won't run (disabled individually) are
                        // omitted from this list — skip their predicted steps now
                        // rather than waiting for 'main' to self-heal them.
                        const active = new Set(data.agents);
                        const omitted = MULTIAGENT_AGENT_NAMES.filter((name) => !active.has(name)).map((name) => `ma-${name}`);
                        if (omitted.length > 0) {
                            safeStatus(() => setPendingStepsSkipped(status.genId, omitted, Date.now()));
                        }
                    } else if (typeof data.agent === 'string') {
                        safeStatus(() => addBadge(status.genId, multiagentAgentBadge(data.agent, data.status)));
                        const stepStatus = AGENT_STATUS_TO_STEP[data.status];
                        if (stepStatus) {
                            safeStatus(() => setStepStatus(status.genId, `ma-${data.agent}`, stepStatus, { now: Date.now() }));
                        }
                    }
                    return;
                }
                // Server-side memory pipeline produced updated HypaV3 data —
                // persist it into the target chat as soon as it exists so a
                // later disconnect can't lose the new summaries.
                if (data.type === 'memory-data') {
                    applyUpdatedMemoryToTarget(target, data.data);
                    return;
                }
                if (data.type === 'memory-progress') {
                    return;
                }
                if (data.type === 'chunk' && typeof data.text === 'string') {
                    queueText(data.text);
                    reportStatusText(data.text);
                    return;
                }
                if (data.type !== 'status') return;
                // A status event can carry the authoritative final text — notably
                // when we (re)connect to a job that has *already* finished, the
                // server sends a single status event with `text` and no preceding
                // chunk. Apply it before closing so the message isn't frozen at
                // whatever partial text was recovered earlier.
                if (typeof data.text === 'string') { queueText(data.text, true); reportStatusText(data.text); }
                if (data.status === 'done') {
                    flushText();
                    close(true);
                } else if (data.status === 'error') {
                    fail(data.error || 'Backend job failed', true);
                } else if (data.status === 'cancelled') {
                    fail('Aborted', true);
                }
            };

            const readSse = async (response: Response) => {
                if (!response.body) throw new Error('Backend stream returned no body');
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                try {
                    while (!closed) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
                        let splitIndex: number;
                        while ((splitIndex = buffer.indexOf('\n\n')) !== -1) {
                            const event = buffer.slice(0, splitIndex);
                            buffer = buffer.slice(splitIndex + 2);
                            const payload = event
                                .split('\n')
                                .filter((line) => line.startsWith('data:'))
                                .map((line) => line.slice(5).trimStart())
                                .join('\n');
                            if (!payload) continue;
                            try { handleEvent(JSON.parse(payload)); } catch { /* ignore malformed events */ }
                        }
                    }
                } finally {
                    try { reader.releaseLock(); } catch { /* ignore */ }
                }
            };

            const fetchStatus = async (): Promise<ChatJobStatus | null> => {
                const response = await authenticatedBackendFetch(`/api/chat-job/${jobId}`);
                if (response.status === 404) return null;
                if (!response.ok) throw new Error(`Backend job status failed: ${response.status}`);
                return response.json();
            };

            const run = async () => {
                while (!closed) {
                    connectionController = new AbortController();
                    try {
                        const response = await authenticatedBackendFetch(`/api/chat-job/${jobId}/stream`, {
                            headers: { Accept: 'text/event-stream' },
                            signal: connectionController.signal,
                        });
                        if (response.status === 404) {
                            fail('Backend job not found', false);
                            return;
                        }
                        if (!response.ok) {
                            throw new Error(`Backend stream failed: ${response.status}`);
                        }
                        await readSse(response);
                    } catch (error) {
                        if (closed || connectionController.signal.aborted) return;
                        console.warn('[BackendJob] Stream disconnected; reconnecting', error);
                    }

                    if (closed) return;
                    try {
                        const jobStatus = await fetchStatus();
                        if (!jobStatus) {
                            fail('Backend job not found', false);
                            return;
                        }
                        if (jobStatus.updatedMemory) { applyUpdatedMemoryToTarget(target, jobStatus.updatedMemory); }
                        if (typeof jobStatus.text === 'string') { queueText(jobStatus.text, true); reportStatusText(jobStatus.text); }
                        if (jobStatus.status === 'done') {
                            close(true);
                            return;
                        }
                        if (jobStatus.status === 'error') {
                            fail(jobStatus.error || 'Backend job failed', true);
                            return;
                        }
                        if (jobStatus.status === 'cancelled') {
                            fail('Aborted', true);
                            return;
                        }
                    } catch {
                        // Reconnect and retry after transient auth/network failures.
                    }
                    await sleep(STREAM_RECONNECT_DELAY_MS);
                }
            };

            const onAbort = () => {
                authenticatedBackendFetch(`/api/chat-job/${jobId}/cancel`, { method: 'POST' }).catch(() => {});
                fail('Aborted', false);
            };
            abortSignal?.addEventListener('abort', onAbort, { once: true });

            void run().finally(() => {
                abortSignal?.removeEventListener('abort', onAbort);
            });
        },
        cancel() {
            // Disconnecting the browser must not cancel the server-side job.
            // Explicit user aborts are handled by abortSignal above.
        },
    });
}

interface RecoveredResult {
    jobId: string;
    status: ChatJobState;
    text: string;
    error: string | null;
    updatedAt?: number;
    target: ChatJobTarget;
    updatedMemory?: any;
}

function upsertRecoveredMessage(char: character, chat: Chat, result: RecoveredResult) {
    const targetIndex = result.target.messageIndex;
    if (targetIndex < chat.message.length && chat.message[targetIndex]?.role === 'char') {
        chat.message[targetIndex].data = result.text ?? '';
        chat.message[targetIndex].chatId = chat.message[targetIndex].chatId || result.jobId;
        return true;
    }
    if (targetIndex >= chat.message.length) {
        // DB race condition: messages not yet persisted at page refresh time.
        // Pad with empty user messages if we're behind, then push the AI reply.
        while (chat.message.length < targetIndex) {
            chat.message.push({ role: 'user', data: '', saying: '', time: result.updatedAt ?? Date.now() });
        }
        chat.message.push({
            role: 'char',
            saying: char.chaId,
            time: result.updatedAt ?? Date.now(),
            data: result.text ?? '',
            chatId: result.jobId,
        });
        return true;
    }
    return false;
}

async function resumeBackendJobIntoChat(char: character, chat: Chat, result: RecoveredResult) {
    if (resumingJobIds.has(result.jobId)) return;
    resumingJobIds.add(result.jobId);
    const targetIndex = result.target.messageIndex;
    chat.isStreaming = true;

    const { doingChat, recoveryAbortController } = await import('../index.svelte');
    const abortController = new AbortController();
    recoveryAbortController.set(abortController);
    doingChat.set(true);

    try {
        const stream = createBackendJobStream(result.jobId, result.target, abortController.signal);
        const reader = stream.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = value?.[Object.keys(value)[0]];
            const message = chat.message[targetIndex];
            if (message?.role === 'char' && typeof text === 'string') {
                message.data = text;
                // Drive Svelte 5 reactivity per chunk, mirroring the normal streaming path.
                char.reloadKeys = (char.reloadKeys ?? 0) + 1;
            }
        }
    } catch (error) {
        console.error('[BackendJob] Failed to resume job', result.jobId, error);
    } finally {
        chat.isStreaming = false;
        resumingJobIds.delete(result.jobId);
        char.reloadKeys = (char.reloadKeys ?? 0) + 1;
        recoveryAbortController.set(null);
        doingChat.set(false);
    }
}

/**
 * Applies completed results and reconnects to jobs that are still running.
 * Called when a chat is opened, including immediately after a page refresh.
 */
export async function applyPendingBackendChatResults(char: character, chat: Chat): Promise<number> {
    const db = getDatabase();
    if (!db.useBackendChatJobs) return 0;
    if (!char?.chaId) return 0;
    
    const effectiveChatId = chat?.id || (char.chatPage ?? 0).toString();

    const res = await authenticatedBackendFetch(`/api/chat-job/results?chaId=${encodeURIComponent(char.chaId)}&chatId=${encodeURIComponent(effectiveChatId)}`).catch(() => null);
    if (!res?.ok) return 0;

    const results: RecoveredResult[] = await res.json();
    if (!Array.isArray(results) || results.length === 0) return 0;

    let applied = 0;
    for (const result of results) {
        if (!result?.target || !result.jobId) continue;

        // Memory data from the server-side pipeline survives refreshes via the
        // persisted job result; re-apply it whenever we see it.
        if (result.updatedMemory) {
            applyUpdatedMemoryToTarget(result.target, result.updatedMemory);
        }

        if (result.status === 'pending' || result.status === 'running') {
            if (upsertRecoveredMessage(char, chat, result)) {
                applied++;
                void resumeBackendJobIntoChat(char, chat, result);
            }
            continue;
        }

        if (result.status === 'done') {
            if (upsertRecoveredMessage(char, chat, result)) applied++;
            await acknowledgeTarget(result.target);
            continue;
        }

        // Failed/cancelled jobs should not be offered again on every chat open.
        await acknowledgeTarget(result.target);
    }

    return applied;
}

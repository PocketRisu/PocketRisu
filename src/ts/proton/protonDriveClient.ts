// Heavy part of the Proton import: SDK and OpenPGP. Loaded only through the
// dynamic import in protonImport.ts. The polyfills the SDK needs
// (Uint8Array base64/hex, Array.fromAsync) come from core-js/actual in main.ts.
import {
    AbortError,
    MemoryCache,
    OpenPGPCryptoWithCryptoProxy,
    ProtonDriveClient,
    type ProtonDriveHTTPClientBlobRequest,
    type ProtonDriveHTTPClientJsonRequest,
} from '@protontech/drive-sdk'
import { CryptoProxy } from '@protontech/crypto'
import { Api } from '@protontech/crypto/proxy/endpoint/api.ts'
import { computeKeyPassword, generateKeySalt, getSrp } from '@protontech/crypto/srp'
import { fetchViaProxy2 } from '../globalApi.svelte'
import { nodeOnlyVer } from '../storage/database.svelte'
import { anySignal, setSdkAbortError } from './protonImport'

Api.init({})
CryptoProxy.setEndpoint(new Api())
setSdkAbortError(AbortError)

// Proton asks third-party clients to identify themselves honestly.
const APP_VERSION = `external-drive-pocketrisu@${nodeOnlyVer}-stable`

// drive-api.proton.me only allows CORS from localhost and private IPs, so
// remote access (Tailscale, custom domains) must go through the server relay.
// The server only sees encrypted data; decryption stays in the browser.
async function request(
    req: ProtonDriveHTTPClientJsonRequest | ProtonDriveHTTPClientBlobRequest,
    signal?: AbortSignal,
): Promise<Response> {
    const headers: Record<string, string> = {}
    req.headers.forEach((value, key) => { headers[key] = value })
    headers['x-pm-appversion'] = APP_VERSION
    let body: Uint8Array | undefined
    if ('json' in req && req.json) {
        headers['content-type'] = 'application/json'
        body = new TextEncoder().encode(JSON.stringify(req.json))
    } else if (req.body) {
        body = new Uint8Array(await new Response(req.body).arrayBuffer())
    }
    const signals = [signal, req.signal, AbortSignal.timeout(req.timeoutMs)].filter((s): s is AbortSignal => !!s)
    return fetchViaProxy2(req.url, headers, body, {
        method: req.method,
        signal: anySignal(signals),
        requestTimeoutMs: req.timeoutMs,
    })
}

// The SDK logs every API call at info level; keep only problems.
const logger = {
    debug() {},
    info() {},
    warn(msg: string) { console.warn('[Proton]', msg) },
    error(msg: string, error?: unknown) { console.error('[Proton]', msg, error) },
}

export function createProtonDriveClient(signal?: AbortSignal) {
    const anonymousOnly = async (): Promise<never> => { throw new Error('Only public links are supported') }
    const fetchFn = (req: ProtonDriveHTTPClientJsonRequest | ProtonDriveHTTPClientBlobRequest) => request(req, signal)
    return new ProtonDriveClient({
        telemetry: { getLogger: () => logger, recordMetric: () => {} },
        httpClient: { fetchJson: fetchFn, fetchBlob: fetchFn },
        entitiesCache: new MemoryCache(),
        cryptoCache: new MemoryCache(),
        account: {
            getOwnPrimaryAddress: anonymousOnly,
            getOwnAddress: anonymousOnly,
            getOwnAddresses: async () => [],
            hasProtonAccount: async () => false,
            getPublicKeys: async () => [],
        },
        openPGPCryptoModule: new OpenPGPCryptoWithCryptoProxy(CryptoProxy),
        srpModule: {
            getSrp: (Version, Modulus, ServerEphemeral, Salt, password) =>
                getSrp({ Version, Modulus, ServerEphemeral, Salt }, { password }),
            computeKeyPassword,
            generateKeySalt,
            getSrpVerifier: anonymousOnly,
        },
    })
}

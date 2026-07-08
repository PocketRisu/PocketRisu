import { getDatabase } from '../storage/database.svelte'
import silentSound from '../../etc/send.mp3'

// Generation-scoped background keep-alive.
//
// The backend fetch relay (fetchJob.cjs) makes each individual request survive
// a webview suspension, but the pipeline that issues the *next* request
// (HypaMemory embedding → summarization → chat-job start) is client-side JS,
// which mobile browsers freeze while the app is backgrounded. Playing a
// near-silent looping audio track marks the tab as playing media, which
// exempts it from freezing on Android Chrome/WebView and iOS Safari — so the
// pipeline keeps advancing with the screen off.
//
// This is the same trick as the always-on `keepSessionAlive: 'sound'` setting,
// but scoped to an active generation: it starts when a generation begins
// (inside the send click's user-gesture context, which autoplay policies
// require) and stops when the generation ends.

let audio: HTMLAudioElement | null = null

export function startGenerationKeepAlive() {
    try {
        const db = getDatabase()
        // Scoped to backend-job mode: that is the "generation survives the
        // screen turning off" feature this keep-alive completes. The always-on
        // keepSessionAlive setting already covers the rest.
        if (!db?.useBackendChatJobs) return
        if (audio) return
        const element = new Audio(silentSound)
        element.loop = true
        element.volume = 0.000001
        audio = element
        void element.play().catch(() => {
            // Autoplay blocked (no user gesture, e.g. backend-job recovery on
            // page load). The relay still protects individual requests.
            if (audio === element) audio = null
        })
    } catch {
        audio = null
    }
}

export function stopGenerationKeepAlive() {
    const element = audio
    audio = null
    if (!element) return
    try {
        element.pause()
        element.src = ''
    } catch { /* ignore */ }
}

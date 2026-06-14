// Root scroll guard.
//
// This app pins the page to the window: <body> has overflow:hidden and every
// real scroll happens inside an inner container (.default-chat-screen, the
// sidebar, modals…). The document root (documentElement) is therefore never
// meant to scroll.
//
// But overflow:hidden only blocks *user* scrolling — it does not stop
// programmatic scrolls (scrollIntoView, focus without preventScroll, plugin
// DOM APIs). If anything inflates documentElement.scrollHeight past the
// viewport (a body-level absolutely-positioned element injected by a plugin,
// custom CSS, a future browser regression…), one such programmatic scroll can
// drag the whole page up — leaving the UI shoved off the top and a blank band
// of background below. Zoom/refresh "fixes" it only because the reflow clamps
// scrollTop back to 0.
//
// Rather than chase every inflation source and every trigger, we assert the
// invariant directly: the root's scrollTop is always 0. The listener is
// capture+passive and bails on a single pointer comparison for the common case
// (inner-container scrolls, whose event target is the element, not `document`),
// so it costs effectively nothing on the hot path and only touches the root
// when the root itself has actually been displaced. For a viewport/root scroll
// the scroll event's target is `document` (verified — see the forensics note).
//
// See .agent/notes/root-scroll-displacement-forensics.md for the full
// investigation (instrumented v1.7.3 repro, rejected fixes, measurements).
export function installRootScrollGuard() {
    if (typeof document === 'undefined') return
    // One-time signal: this app has no legitimate root scroll, so a clamp means
    // something (plugin DOM, custom CSS, browser quirk) tried to scroll the root.
    let clampLogged = false
    document.addEventListener('scroll', (e) => {
        if (e.target !== document) return
        const de = document.documentElement
        if (de.scrollTop === 0 && de.scrollLeft === 0) return
        if (!clampLogged) {
            clampLogged = true
            console.warn('[rootScrollGuard] root scroll clamped to 0; an inflated root was scrolled (plugin/custom CSS?)')
        }
        de.scrollTop = 0
        de.scrollLeft = 0
    }, { capture: true, passive: true })
}

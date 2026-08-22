// Dynamic viewport height tracking.
//
// The app is sized with 100dvh (styles.css) so it follows mobile Chrome's URL
// bar. But dvh only updates once the browser-UI animation settles, while the
// visible area grows/shrinks continuously during it — measured on device: 4-5
// visualViewport resize events (e.g. 736→738→741→746) land before the single
// dvh/window resize. For those ~200ms the app bottom (composer) visibly lags
// the screen edge. Feeding visualViewport.height into --risu-height-size on
// every step shrinks the lag from the full URL-bar height to a few px.
//
// Deliberately skipped:
// - while an editable element is focused: the on-screen keyboard also resizes
//   the visual viewport, and the platform keyboard path (pan/lift, see the
//   rootScrollGuard removal in 37ef6e3b) must keep its native behavior.
// - while pinch-zoomed (scale != 1): vv.height is in visual px there, not a
//   layout size.
export function installDynamicViewportHeight() {
    if (typeof window === 'undefined') return
    const vv = window.visualViewport
    if (!vv) return
    let raf = 0
    const apply = () => {
        raf = 0
        if (Math.abs(vv.scale - 1) > 0.01) return
        const ae = document.activeElement as HTMLElement | null
        if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT' || ae.isContentEditable)) return
        document.documentElement.style.setProperty('--risu-height-size', `${Math.round(vv.height)}px`)
    }
    vv.addEventListener('resize', () => { if (!raf) raf = requestAnimationFrame(apply) })
    apply()
}

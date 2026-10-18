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
// - while the on-screen keyboard is open over a focused editable element: the
//   keyboard also shrinks the visual viewport, and the platform keyboard path
//   (pan/lift, see the rootScrollGuard removal in 37ef6e3b) must keep its
//   native behavior. Chrome and Safari leave window.innerHeight (the layout
//   viewport) unchanged for the keyboard, so a large gap below it means the
//   keyboard is up; browser toolbars move innerHeight too and stay under the
//   threshold.
// - while pinch-zoomed (scale != 1): vv.height is in visual px there, not a
//   layout size.
//
// Once written, the px value replaces 100dvh, so a skipped resize must be
// caught up later: the keyboard can be dismissed (Android Back) while focus
// stays in the composer, and the toolbars that reappear with it would
// otherwise leave the app taller than the screen, with the composer under the
// browser UI until the next unfocused resize. Re-measure when focus leaves an
// editable element and on window resizes (which land after the vv steps).
const KEYBOARD_MIN_HEIGHT = 150

export function installDynamicViewportHeight() {
    if (typeof window === 'undefined') return
    const vv = window.visualViewport
    if (!vv) return
    let raf = 0
    const isEditable = (el: Element | null) => {
        const he = el as HTMLElement | null
        return !!he && (he.tagName === 'TEXTAREA' || he.tagName === 'INPUT' || he.isContentEditable)
    }
    const apply = () => {
        raf = 0
        if (Math.abs(vv.scale - 1) > 0.01) return
        if (isEditable(document.activeElement) && window.innerHeight - vv.height > KEYBOARD_MIN_HEIGHT) return
        document.documentElement.style.setProperty('--risu-height-size', `${Math.round(vv.height)}px`)
    }
    const schedule = () => { if (!raf) raf = requestAnimationFrame(apply) }
    vv.addEventListener('resize', schedule)
    window.addEventListener('resize', schedule)
    // activeElement is only updated after focusout, so measure on the next frame.
    document.addEventListener('focusout', (ev) => { if (isEditable(ev.target as Element)) schedule() })
    apply()
}

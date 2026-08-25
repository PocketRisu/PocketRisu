// scrollIntoView walks all scrollable ancestors; if documentElement is
// bloated (e.g. by sidebar layout leakage) it gets scrolled too, pushing
// the viewport off body and revealing gray space below. Use this helper
// to scroll only the given container instead of climbing to the root.
import { suspendChatScrollAnchor } from './chatScrollAnchor'

export function scrollWithinContainer(
    el: HTMLElement,
    container: HTMLElement,
    options: { block: 'start' | 'end'; behavior: ScrollBehavior }
) {
    const resumeScrollAnchor = suspendChatScrollAnchor(container)
    const elRect = el.getBoundingClientRect()
    const containerRect = container.getBoundingClientRect()
    const offset = options.block === 'start'
        ? elRect.top - containerRect.top
        : elRect.bottom - containerRect.bottom
    container.scrollTo({ top: container.scrollTop + offset, behavior: options.behavior })

    if (options.behavior !== 'smooth') {
        requestAnimationFrame(resumeScrollAnchor)
        return
    }

    let fallbackTimer: ReturnType<typeof setTimeout> | null = null
    let finished = false
    const finish = () => {
        if (finished) return
        finished = true
        container.removeEventListener('scrollend', finish)
        if (fallbackTimer !== null) clearTimeout(fallbackTimer)
        resumeScrollAnchor()
    }
    container.addEventListener('scrollend', finish, { once: true })
    fallbackTimer = setTimeout(finish, 700)
}

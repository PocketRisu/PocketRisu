// scrollIntoView walks all scrollable ancestors; if documentElement is
// bloated (e.g. by sidebar layout leakage) it gets scrolled too, pushing
// the viewport off body and revealing gray space below. Use this helper
// to scroll only the given container instead of climbing to the root.
export function scrollWithinContainer(
    el: HTMLElement,
    container: HTMLElement,
    options: { block: 'start' | 'end'; behavior: ScrollBehavior }
) {
    const elRect = el.getBoundingClientRect()
    const containerRect = container.getBoundingClientRect()
    const offset = options.block === 'start'
        ? elRect.top - containerRect.top
        : elRect.bottom - containerRect.bottom
    container.scrollTo({ top: container.scrollTop + offset, behavior: options.behavior })
}

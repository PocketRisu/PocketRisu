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
    // getBoundingClientRect is the border box, so its bottom sits below any
    // bottom-padding. When the floating composer reserves space via padding-bottom,
    // align 'end' to the content-box bottom instead, so the target message lands
    // above the composer rather than behind it. (padding-bottom is 0 otherwise.)
    const padBottom = options.block === 'end'
        ? parseFloat(getComputedStyle(container).paddingBottom) || 0
        : 0
    const offset = options.block === 'start'
        ? elRect.top - containerRect.top
        : elRect.bottom - (containerRect.bottom - padBottom)
    container.scrollTo({ top: container.scrollTop + offset, behavior: options.behavior })
}

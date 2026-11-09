/// <reference lib="dom" />
// Keeps the reader's text in place through content and viewport reflow.
import { scroll } from './scroll.ts'

type Anchor = {
	width: number
	height: number
	top: number
	bottom: number
	range?: Range
	element?: Element
	fraction: number
	point: number
	offset: number
}

function capture(el: HTMLElement): Anchor {
	let box = el.getBoundingClientRect()
	let x = box.left + el.clientWidth / 2,
		y = box.top + el.clientHeight / 2
	let anchor: Anchor = {
		width: el.clientWidth,
		height: el.clientHeight,
		top: el.scrollTop,
		bottom: Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop),
		fraction: 0,
		point: 0,
		offset: 0,
	}
	if (scroll.state.pinned) return anchor
	// WebKit supplies caretRangeFromPoint; other engines may supply a
	// caret position instead. Extend to one character for a measurable rect.
	for (let step = 0; step <= 40; step += 2) {
		for (let delta of step ? [-step, step] : [0]) {
			let range = document.caretRangeFromPoint?.(x, y + delta)
			if (!range && document.caretPositionFromPoint) {
				let caret = document.caretPositionFromPoint(x, y + delta)
				if (caret) {
					range = document.createRange()
					range.setStart(caret.offsetNode, caret.offset)
					range.collapse(true)
				}
			}
			if (!range || !el.contains(range.startContainer) || range.startContainer.nodeType !== Node.TEXT_NODE) continue
			let node = range.startContainer as Text
			if (!node.length) continue
			let offset = Math.min(range.startOffset, node.length - 1)
			range.setStart(node, offset)
			range.setEnd(node, offset + 1)
			let rect = range.getBoundingClientRect()
			if (rect.height) {
				anchor.range = range
				anchor.offset = rect.top + rect.height / 2 - y
				return anchor
			}
		}
	}
	// Images and gaps have no text caret. Keep a point in the nearest card
	// (or its edge plus the gap); no content at all falls back to pixels.
	let distance = Infinity
	for (let child of el.children) {
		let rect = child.getBoundingClientRect()
		let point = Math.max(rect.top, Math.min(y, rect.bottom)),
			d = Math.abs(point - y)
		if (d >= distance || !rect.height) continue
		distance = d
		anchor.element = child
		anchor.fraction = (point - rect.top) / rect.height
		anchor.point = point - rect.top
		anchor.offset = point - y
	}
	return anchor
}

function restore(el: HTMLElement, anchor: Anchor, resized: boolean): void {
	let top = anchor.top <= 40,
		bottom = anchor.bottom <= 40
	let target: number
	if (resized && top !== bottom) target = top ? anchor.top : el.scrollHeight - el.clientHeight - anchor.bottom
	else {
		let y: number | undefined
		if (anchor.range?.startContainer.nodeType === Node.TEXT_NODE && el.contains(anchor.range.startContainer)) {
			let rect = anchor.range.getBoundingClientRect()
			if (rect.height) y = rect.top + rect.height / 2
		} else if (anchor.element && el.contains(anchor.element)) {
			let rect = anchor.element.getBoundingClientRect()
			y = rect.top + (resized ? rect.height * anchor.fraction : anchor.point)
		}
		target =
			y === undefined
				? anchor.top + (anchor.height - el.clientHeight) / 2
				: el.scrollTop + y - anchor.offset - el.getBoundingClientRect().top - el.clientHeight / 2
	}
	el.scrollTop = Math.max(0, Math.min(target, el.scrollHeight - el.clientHeight))
}

function watch(el: HTMLElement): { stop: () => void; capture: () => void; restore: () => void } {
	let anchor = capture(el)
	let resized = () => el.clientWidth !== anchor.width || el.clientHeight !== anchor.height
	let update = () => {
		if (scroll.state.pinned) scroll.put(el, scroll.target(el, 0))
		else if (!scroll.keep()) restore(el, anchor, resized())
		scroll.state.top = el.scrollTop
		anchor = capture(el)
	}
	let scrolled = () => {
		if (resized()) update()
		else anchor = capture(el)
	}
	el.addEventListener('load', update, true)
	el.addEventListener('scroll', scrolled, { passive: true })
	let resize = new ResizeObserver(update)
	resize.observe(el)
	let stop = () => {
		el.removeEventListener('load', update, true)
		el.removeEventListener('scroll', scrolled)
		resize.disconnect()
	}
	return { stop, capture: () => void (anchor = capture(el)), restore: update }
}

export const reflow = { watch }

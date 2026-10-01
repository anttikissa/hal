/// <reference lib="dom" />
// Keep a pre-layout reading anchor: an exclusive nearby edge, otherwise
// the text at the visible centre. Resize events arrive after layout, so
// scroll/content observers refresh it only while the box size is unchanged.

type Anchor = {
	width: number; height: number; top: number; bottom: number
	range?: Range; element?: Element; fraction: number; offset: number
}

function capture(el: HTMLElement): Anchor {
	let box = el.getBoundingClientRect()
	let x = box.left + el.clientWidth / 2, y = box.top + el.clientHeight / 2
	let anchor: Anchor = { width: el.clientWidth, height: el.clientHeight, top: el.scrollTop, bottom: Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop), fraction: 0, offset: 0 }
	// Most streaming readers need only an edge gap, not text geometry.
	if ((anchor.top <= 40) !== (anchor.bottom <= 40)) return anchor
	// WebKit supplies caretRangeFromPoint; other engines may supply a
	// caret position instead. Extend to one character for a measurable rect.
	for (let step = 0; step <= 40; step += 2) {
		for (let delta of step ? [-step, step] : [0]) {
			let range = document.caretRangeFromPoint?.(x, y + delta)
			if (!range && document.caretPositionFromPoint) {
				let caret = document.caretPositionFromPoint(x, y + delta)
				if (caret) { range = document.createRange(); range.setStart(caret.offsetNode, caret.offset); range.collapse(true) }
			}
			if (!range || !el.contains(range.startContainer) || range.startContainer.nodeType !== Node.TEXT_NODE) continue
			let node = range.startContainer as Text
			if (!node.length) continue
			let offset = Math.min(range.startOffset, node.length - 1)
			range.setStart(node, offset); range.setEnd(node, offset + 1)
			let rect = range.getBoundingClientRect()
			if (rect.height) { anchor.range = range; anchor.offset = rect.top + rect.height / 2 - y; return anchor }
		}
	}
	// Images and gaps have no text caret. Keep a point in the nearest card
	// (or its edge plus the gap); no content at all falls back to pixels.
	let distance = Infinity
	for (let child of el.children) {
		let rect = child.getBoundingClientRect()
		let point = Math.max(rect.top, Math.min(y, rect.bottom)), d = Math.abs(point - y)
		if (d >= distance || !rect.height) continue
		distance = d; anchor.element = child
		anchor.fraction = (point - rect.top) / rect.height; anchor.offset = point - y
	}
	return anchor
}

function restore(el: HTMLElement, anchor: Anchor): void {
	let top = anchor.top <= 40, bottom = anchor.bottom <= 40
	let target: number
	if (top !== bottom) target = top ? anchor.top : el.scrollHeight - el.clientHeight - anchor.bottom
	else {
		let y: number | undefined
		if (anchor.range && el.contains(anchor.range.startContainer)) {
			let rect = anchor.range.getBoundingClientRect()
			if (rect.height) y = rect.top + rect.height / 2
		} else if (anchor.element && el.contains(anchor.element)) {
			let rect = anchor.element.getBoundingClientRect()
			y = rect.top + rect.height * anchor.fraction
		}
		target = y === undefined ? anchor.top + (anchor.height - el.clientHeight) / 2 : el.scrollTop + y - anchor.offset - el.getBoundingClientRect().top - el.clientHeight / 2
	}
	el.scrollTop = Math.max(0, Math.min(target, el.scrollHeight - el.clientHeight))
}

// `onResize` returns true when it keeps the view itself (a glide to the
// bottom is running), so the anchor is left alone.
function watch(el: HTMLElement, onResize: () => boolean): () => void {
	let anchor = capture(el)
	let update = () => {
		if (el.clientWidth !== anchor.width || el.clientHeight !== anchor.height) {
			if (!onResize()) restore(el, anchor)
		}
		anchor = capture(el)
	}
	// Images acquire intrinsic height outside a controller redraw. Keep the
	// pre-load reading anchor, including a card just revealed by a deep link.
	let loaded = () => {
		if (!onResize()) restore(el, anchor)
		anchor = capture(el)
	}
	el.addEventListener('load', loaded, true)
	// A resize may clamp scrollTop and emit scroll before ResizeObserver.
	// Detect the changed geometry there too, before replacing the anchor.
	el.addEventListener('scroll', update, { passive: true })
	let resize = new ResizeObserver(update)
	resize.observe(el)
	let content = new MutationObserver(update)
	content.observe(el, { childList: true, characterData: true, subtree: true })
	return () => {
		el.removeEventListener('load', loaded, true)
		el.removeEventListener('scroll', update)
		resize.disconnect(); content.disconnect()
	}
}

export const reflow = { watch }

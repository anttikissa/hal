/// <reference lib="dom" />
// How a card moves (Card.tsx): it fades in when it enters the page, and
// a click opens or closes it while the reader's place stays put.

import { flush } from 'solid-js'
import { scroll } from './scroll.ts'

// A new card fades in (--fade-ms, --ease-out from the page's CSS). A
// script animation, not a CSS one: moving the card in the list, as when
// a pending command lands where it ran (task rk), would restart a CSS
// animation, which reads as the card appearing again. Started once the
// card is in the page: a node cloned from a template belongs to an inert
// document, whose animations never run.
let fade: KeyframeAnimationOptions | undefined
function enter(el: HTMLElement): void {
	// Find's preview redraws cards as you move: they never fade (STYLE.md).
	if (scroll.state.quiet || el.closest('dialog')) return
	if (!fade) {
		let css = getComputedStyle(document.documentElement)
		fade = {
			duration: parseFloat(css.getPropertyValue('--fade-ms')) || 0,
			easing: css.getPropertyValue('--ease-out').trim() || 'ease-out',
		}
	}
	el.animate({ opacity: [0, 1] }, fade)
}

type Toggle = {
	root: () => HTMLElement | undefined
	canToggle: () => boolean
	expanded: () => boolean
	// Opens or closes the card's fold.
	disclose: () => void
}

// A card's click handlers. A mouse click toggles after 200 ms, so a
// double-click can select a word instead; keyboard activation (detail 0)
// toggles at once. The second press cancels it, since a
// double-click-drag clicks only on release.
function toggler(card: Toggle): { click: (e: MouseEvent) => void; press: (e: MouseEvent) => void } {
	let pending: ReturnType<typeof setTimeout> | undefined
	let click = (e: MouseEvent) => {
		clearTimeout(pending)
		if (e.detail > 1) return
		if (e.detail === 1 && !getSelection()?.isCollapsed) return
		let hit = e.target as Element
		let control = hit.closest('.mark, .CardHeader:not(.inline)')
		if (!card.canToggle() || hit.closest('a, .command-toggle, .kill, .edit, .send, .discard, .undo, .raw-tool')) return
		if (!control && card.expanded()) return
		let flip = () =>
			scroll.follow(() => {
				let root = card.root(),
					el = scroll.state.el as HTMLElement | undefined,
					top = root?.getBoundingClientRect().top,
					edge = el?.getBoundingClientRect().top
				if (
					!scroll.state.pinned &&
					card.expanded() &&
					el &&
					top !== undefined &&
					edge !== undefined &&
					top + (root?.querySelector('header')?.offsetHeight ?? 0) <= edge
				) {
					scroll.leave('toggle')
					el.scrollTo({ top: el.scrollTop + top - edge, behavior: 'instant' })
					scroll.moved()
				}
				card.disclose()
				flush()
			})
		if (e.detail === 0) flip()
		else pending = setTimeout(flip, 200)
	}
	let press = (e: MouseEvent) => void (e.detail > 1 && clearTimeout(pending))
	return { click, press }
}

export const cardMotion = { enter, toggler }

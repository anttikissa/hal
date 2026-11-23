/// <reference lib="dom" />
// A panel a chip opens: a popover (light dismiss, Escape and the top
// layer come with it) that sits on the chip's row, so the composer and
// its draft stay in view and usable. A sheet across the app on touch
// screens, docked over its chip with a pointer. Its height holds while it
// is open, so filtering never moves the rows under a finger. Chips open
// it with popovertarget, which also closes it on a second tap.
import { createEffect, untrack } from 'solid-js'
import type { JSX } from '@solidjs/web'

export function Panel(props: {
	id: string
	open: boolean
	onOpen: () => void
	onClose: () => void
	anchor?: HTMLElement
	label: string
	onCancel?: () => void
	children: JSX.Element
}) {
	let box!: HTMLDivElement
	// The scrim dims the page above the chip row and takes the taps there:
	// a tap only closes the panel, never presses what lies under it.
	let scrim!: HTMLDivElement
	// Hiding runs the close and focus handlers here; they read state untracked.
	createEffect(
		() => props.open,
		(open) => {
			if (!open && box.matches(':popover-open')) untrack(() => box.hidePopover())
		},
	)
	// --y: how far the chip's row sits above the app's foot, which the
	// keyboard moves; the CSS adds the app's own place (--app-top).
	let before = (e: ToggleEvent) => {
		if (e.newState === 'closed') return props.onClose()
		let a = props.anchor!.getBoundingClientRect()
		let row = props.anchor!.parentElement!.getBoundingClientRect()
		let foot = props.anchor!.closest('.App')!.getBoundingClientRect().bottom
		let right = a.left + a.width / 2 > innerWidth / 2
		box.style.setProperty('--x', right ? 'auto' : `${a.left}px`)
		box.style.setProperty('--r', right ? `${innerWidth - a.right}px` : 'auto')
		for (let el of [box, scrim]) el.style.setProperty('--y', `${foot - row.top}px`)
		box.style.minHeight = ''
		props.onOpen()
	}
	// Focus moves in, so Escape closes the panel and never reaches the
	// session (keys.ts pauses it); a pointer starts in the panel's field.
	let shown = (e: ToggleEvent) => {
		if (e.newState !== 'open') return
		box.style.minHeight = `${box.offsetHeight}px`
		;((matchMedia('(pointer: fine)').matches && box.querySelector('input')) || box).focus()
	}
	return (
		<>
			<div ref={(e) => (scrim = e)} class={['Scrim', props.open && 'open']} aria-hidden="true" />
			<div
				ref={(e) => (box = e)}
				id={props.id}
				popover="auto"
				role="dialog"
				tabindex="-1"
				class="Panel plain"
				aria-label={props.label}
				onBeforeToggle={before}
				onToggle={shown}
				onKeyDown={(e) => {
					e.stopPropagation()
					if (e.key === 'Escape') props.onCancel?.()
				}}
			>
				{props.children}
			</div>
		</>
	)
}

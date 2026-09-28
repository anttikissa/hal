/// <reference lib="dom" />
// The host's tabs above the conversation. Each tab is a link to its
// address (Cmd- or middle-click opens it in a browser tab; a plain
// click shows it here) with its number, name and the same marker as the
// terminal's tab bar. A close button per tab and a new tab button (in the shown
// tab's cwd). The strip wraps and never scrolls sideways, which would
// fight the back-swipe gesture; on narrow screens it is one button
// opening a sheet with the same list and actions.

import { createEffect, createSignal, For } from 'solid-js'
import type { Tab } from '../../common/protocol.ts'
import { tabMark } from '../../common/tab-mark.ts'
import { router } from '../router.ts'
import { tabs } from '../tabs.ts'
import { push } from '../push.ts'

// The marker: the same glyph as the terminal's (common/tab-mark.ts),
// styled by its kind; a blinking one pulses.
function marker(tab: Tab): { glyph: string; label: string; class: string[] } | undefined {
	let m = tabMark.mark(tab)
	return m && { glyph: m.glyph, label: m.label, class: [m.kind, ...(m.blinks ? ['blink'] : [])] }
}

// A plain left click shows the tab here; anything else is the browser's.
function click(e: MouseEvent, id: string, then?: () => void): void {
	if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
	e.preventDefault()
	tabs.show(id, false)
	then?.()
}

function Link(props: { tab: Tab; n: number; shown: boolean; onPick?: () => void }) {
	let m = () => marker(props.tab)
	return (
		<a
			href={router.format(props.tab.id)}
			class="tab"
			aria-current={props.shown ? 'page' : undefined}
			title={`${props.tab.name} · ${props.tab.cwd}`}
			onClick={(e) => click(e, props.tab.id, props.onPick)}
		>
			<span class="n">{props.n}</span>
			<span class="name">{props.tab.name}</span>
			<span class={['marker', ...(m()?.class ?? [])]} role="img" aria-label={m()?.label} hidden={!m()}>
				{m()?.glyph ?? ''}
			</span>
		</a>
	)
}

function Close(props: { tab: Tab }) {
	return (
		<button type="button" class="close" aria-label={`Close ${props.tab.name}`} onClick={() => tabs.closeTab(props.tab.id)}>
			×
		</button>
	)
}

export function Tabs(props: { tabs: Tab[]; shown: string | undefined; pushReady: boolean }) {
	let [requested, setRequested] = createSignal(false)
	let enable = () => void push.enable().then(() => setRequested(true)).catch((e) => alert(`Notifications: ${e.message}`))
	let [open, setOpen] = createSignal(false)
	let sheet!: HTMLDialogElement
	createEffect(open, (o) => {
		if (o && !sheet.open) sheet.showModal()
		if (!o && sheet.open) sheet.close()
	})
	let current = () => props.tabs.findIndex((t) => t.id === props.shown)
	let newTab = () => {
		setOpen(false)
		tabs.newTab()
	}
	return (
		<header class="Tabs tab">
			<nav class="strip" aria-label="Tabs">
				<For each={props.tabs}>
					{(tab, i) => (
						<span class="item">
							<Link tab={tab} n={i() + 1} shown={tab.id === props.shown} />
							<Close tab={tab} />
						</span>
					)}
				</For>
				<button type="button" class="new" aria-label="New tab" onClick={newTab}>
					+
				</button>
				{props.pushReady && !requested() && push.available() && <button type="button" class="notify" onClick={enable}>Notify me</button>}
			</nav>
			<button type="button" class="menu" aria-haspopup="dialog" aria-expanded={open() ? 'true' : 'false'} onClick={() => void setOpen(true)}>
				<span class="n">{current() + 1 || ''}</span>
				<span class="name">{props.tabs[current()]?.name ?? 'tabs'}</span>
				<span aria-hidden="true">▾</span>
				<span class="count">{`${props.tabs.length} tabs`}</span>
			</button>
			{props.pushReady && !requested() && push.available() && <button type="button" class="notify-mobile" onClick={enable}>Notify me</button>}
			<dialog
				ref={(e) => (sheet = e)}
				class="sheet"
				aria-label="Tabs"
				onClose={() => setOpen(false)}
				onClick={(e) => e.target === e.currentTarget && setOpen(false)}
			>
				<ul>
					<For each={props.tabs}>
						{(tab, i) => (
							<li>
								<Link tab={tab} n={i() + 1} shown={tab.id === props.shown} onPick={() => setOpen(false)} />
								<Close tab={tab} />
							</li>
						)}
					</For>
				</ul>
				<button type="button" class="new" onClick={newTab}>
					+ New tab
				</button>
			</dialog>
		</header>
	)
}

/// <reference lib="dom" />
// The host's tabs above the conversation. Each tab is a link to its
// address (Cmd- or middle-click opens it in a browser tab; a plain
// click shows it here) with its number, name and a marker: a dot while
// it works, ? when it waits for an answer, a bell when it wants
// attention. A close button per tab and a new tab button (in the shown
// tab's cwd). The strip wraps and never scrolls sideways, which would
// fight the back-swipe gesture; on narrow screens it is one button
// opening a sheet with the same list and actions.

import { createEffect, createSignal, For } from 'solid-js'
import type { Tab } from '../../common/protocol.ts'
import { states } from '../../common/states.ts'
import { router } from '../router.ts'
import { tabs } from '../tabs.ts'

// The marker: what it shows and says.
function marker(tab: Tab): { glyph: string; label: string; class: string } | undefined {
	if (tab.state.type === 'blocked') return { glyph: '?', label: 'waiting for an answer', class: 'asking' }
	if (states.busy(tab.state)) return { glyph: '●', label: 'working', class: 'working' }
	if (tab.attention) return { glyph: '🔔', label: 'wants attention', class: 'attention' }
	return undefined
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
			<span class={['marker', m()?.class]} role="img" aria-label={m()?.label} hidden={!m()}>
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

export function Tabs(props: { tabs: Tab[]; shown: string | undefined }) {
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
			</nav>
			<button type="button" class="menu" aria-haspopup="dialog" aria-expanded={open() ? 'true' : 'false'} onClick={() => void setOpen(true)}>
				<span class="n">{current() + 1 || ''}</span>
				<span class="name">{props.tabs[current()]?.name ?? 'tabs'}</span>
				<span aria-hidden="true">▾</span>
				<span class="count">{`${props.tabs.length} tabs`}</span>
			</button>
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

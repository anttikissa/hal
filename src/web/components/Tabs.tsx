/// <reference lib="dom" />
// The host's tabs above the conversation: one row that never wraps or
// scrolls sideways (that would fight the back-swipe gesture). A menu
// button opens a sheet with the full list and a close button per tab;
// then equal cells in tab order (number, the terminal's marker, a name
// only when every tab fits with one; the shown tab's number
// underlined), paged between two edges when not every number fits
// (common/tab-pages.ts, task 3k), and a new tab button (in the shown
// tab's cwd). Each tab is a link to its address (Cmd- or middle-click
// opens it in a browser tab; a plain click shows it here).

import { createEffect, createMemo, createSignal, For, onSettled } from 'solid-js'
import type { Tab } from '../../common/protocol.ts'
import type { Edge } from '../../common/tab-pages.ts'
import { tabMark, type Mark } from '../../common/tab-mark.ts'
import { tabPages } from '../../common/tab-pages.ts'
import { router } from '../router.ts'
import { tabs } from '../tabs.ts'
import { push } from '../push.ts'

// Characters a name gets in a cell.
const NAME = 12

// The marker: the same glyph as the terminal's (common/tab-mark.ts),
// styled by its kind; a blinking one pulses. Always there, so an empty
// one keeps its slot.
function Marker(props: { mark: Mark | undefined }) {
	return (
		<span class={['marker', ...(props.mark ? [props.mark.kind, ...(props.mark.blinks ? ['blink'] : [])] : [])]} role="img" aria-label={props.mark?.label}>
			{props.mark?.glyph ?? ''}
		</span>
	)
}

// A plain left click shows the tab here; anything else is the browser's.
function click(e: MouseEvent, id: string, then?: () => void): void {
	if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
	e.preventDefault()
	tabs.show(id, false)
	then?.()
}

function Link(props: { tab: Tab; n: number; shown: boolean; name: boolean; onPick?: () => void }) {
	return (
		<a
			href={router.format(props.tab.id)}
			class="tab"
			aria-current={props.shown ? 'page' : undefined}
			title={`${props.n} ${props.tab.name} · ${props.tab.cwd}`}
			onClick={(e) => click(e, props.tab.id, props.onPick)}
		>
			<span class="n">{props.n}</span>
			<Marker mark={tabMark.mark(props.tab)} />
			{props.name && <span class="name">{props.tab.name}</span>}
		</a>
	)
}

// A page edge: ‹N or N› and that side's most urgent mark, a link to the
// nearest tab there; hidden (keeping its width) when that side is empty.
function EdgeLink(props: { edge: Edge | undefined; to: Tab | undefined; left: boolean }) {
	let count = () => props.edge?.count ?? 0
	return (
		<a
			class={['edge', props.left ? 'left' : 'right']}
			href={props.to ? router.format(props.to.id) : undefined}
			hidden={!props.edge}
			style={{ visibility: count() ? 'visible' : 'hidden' }}
			aria-label={`${count()} more tabs`}
			onClick={(e) => props.to && click(e, props.to.id)}
		>
			{props.left ? `‹${count()}` : `${count()}›`}
			<Marker mark={props.edge?.mark} />
		</a>
	)
}

export function Tabs(props: { tabs: Tab[]; shown: string | undefined; pushReady: boolean }) {
	let [requested, setRequested] = createSignal(false)
	let enable = () => void push.enable().then(() => setRequested(true)).catch((e) => alert(`Notifications: ${e.message}`))
	let [open, setOpen] = createSignal(false)
	let sheet!: HTMLDialogElement
	createEffect(open, (o) => {
		if (o && !sheet.open) {
			sheet.showModal()
			// The list opens on the shown tab, however far down it is.
			sheet.querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest' })
		}
		if (!o && sheet.open) sheet.close()
	})
	// The room for cells and edges, and one character's width, in px.
	let pages!: HTMLElement
	let probe!: HTMLElement
	let [room, setRoom] = createSignal({ width: 0, ch: 8 })
	onSettled(() => {
		let measure = () => setRoom({ width: pages.clientWidth, ch: probe.getBoundingClientRect().width / 10 || 8 })
		let seen = new ResizeObserver(measure)
		seen.observe(pages)
		return () => seen.disconnect()
	})
	let current = () => props.tabs.findIndex((t) => t.id === props.shown)
	// Cells and edges in px, touch-sized on a coarse pointer.
	let page = createMemo(() => {
		let { width, ch } = room()
		let d = tabPages.digits(props.tabs.length)
		let touch = matchMedia('(pointer: coarse)').matches ? 44 : 0
		let cell = Math.max(touch, (d + 2) * ch)
		let sizes = { cell, named: cell + (NAME + 1) * ch, edge: Math.max(touch, (d + 3) * ch) }
		return { ...tabPages.page(props.tabs, current(), width, sizes), sizes, d }
	})
	let shownTabs = createMemo(() => props.tabs.slice(page().start, page().end))
	let newTab = () => {
		setOpen(false)
		tabs.newTab()
	}
	return (
		<header class="Tabs tab" style={{ '--digits': page().d, '--cell': `${page().names ? page().sizes.named! : page().sizes.cell}px`, '--edge': `${page().sizes.edge}px` }}>
			<nav class="strip" aria-label="Tabs">
				<button type="button" class="menu" aria-label="All tabs" aria-haspopup="dialog" aria-expanded={open() ? 'true' : 'false'} onClick={() => void setOpen(true)}>
					≡
				</button>
				<div class="pages" ref={(e) => (pages = e)}>
					<span class="probe" ref={(e) => (probe = e)} aria-hidden="true">
						0000000000
					</span>
					<EdgeLink edge={page().left} to={props.tabs[page().start - 1]} left />
					<For each={shownTabs()}>
						{(tab) => <Link tab={tab} n={props.tabs.indexOf(tab) + 1} shown={tab.id === props.shown} name={page().names} />}
					</For>
					<EdgeLink edge={page().right} to={props.tabs[page().end]} left={false} />
				</div>
				<button type="button" class="new" aria-label="New tab" onClick={newTab}>
					+
				</button>
				{props.pushReady && !requested() && push.available() && (
					<button type="button" class="notify" onClick={enable}>
						Notify
					</button>
				)}
			</nav>
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
								<Link tab={tab} n={i() + 1} shown={tab.id === props.shown} name onPick={() => setOpen(false)} />
								<button type="button" class="close" aria-label={`Close ${tab.name}`} onClick={() => tabs.closeTab(tab.id)}>
									×
								</button>
							</li>
						)}
					</For>
				</ul>
				<button type="button" class="new" onClick={newTab}>
					+ New tab
				</button>
				<button type="button" class="reload" onClick={() => location.reload()}>
					Reload page
				</button>
			</dialog>
		</header>
	)
}

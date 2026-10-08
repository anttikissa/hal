/// <reference lib="dom" />
// The host's tabs above the conversation. Web overflow scrolls independently
// of selection (task ce); terminal paging stays in common/tab-pages.ts.
// Native horizontal momentum scrolling; edge buttons provide secondary paging.
// Tab links retain native Cmd- and middle-click behavior.

import { createEffect, createMemo, createSignal, For, onSettled, Show, untrack } from 'solid-js'
import { settings } from '../../common/settings.ts'
import type { Tab } from '../../common/protocol.ts'
import type { Edge } from '../../common/tab-pages.ts'
import { tabMark, type Mark } from '../../common/tab-mark.ts'
import { tabPages } from '../../common/tab-pages.ts'
import { router } from '../router.ts'
import { Notifications } from './Notifications.tsx'
import { tabs } from '../tabs.ts'
import { push } from '../push.ts'
import { diagnostics } from '../diagnostics.ts'
import { touchDebug } from '../touch-debug.ts'
import { Icon } from './Icon.tsx'

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

function Link(props: { tab: Tab; n: number; shown: boolean; name: boolean; dir?: boolean; onPick?: () => void }) {
	return (
		<a
			href={router.format(props.tab.id)}
			class="tab"
			style={props.tab.color === undefined ? undefined : { '--project': `var(--p${props.tab.color})` }}
			aria-current={props.shown ? 'page' : undefined}
			title={`${props.n} ${props.tab.name} · ${props.tab.cwd}`}
			onClick={(e) => click(e, props.tab.id, props.onPick)}
		>
			<span class="n">{props.n}</span>
			<Marker mark={tabMark.mark(props.tab)} />
			{props.name && <span class="name">{props.tab.name}</span>}
			{props.dir && <span class="dir">{props.tab.cwd}</span>}
		</a>
	)
}

// Hidden counts and urgent status; never a session-selection link.
function EdgeButton(props: { edge: Edge; left: boolean; active: boolean; onClick: () => void }) {
	return (
		<button
			type="button"
			class={['edge', props.left ? 'left' : 'right', ...(props.active ? ['offscreen'] : [])]}
			disabled={!props.edge.count}
			aria-label={`Scroll tabs ${props.left ? 'left' : 'right'}: ${props.edge.count} hidden${props.active ? ', active tab here' : ''}${props.edge.mark ? `, ${props.edge.mark.label}` : ''}`}
			onClick={props.onClick}
		>
			{props.left ? '‹' : '›'}
			<Marker mark={props.edge.mark} />
		</button>
	)
}

export function Tabs(props: { tabs: Tab[]; shown: string | undefined; pushReady: boolean }) {
	let [touchProbe, setTouchProbe] = createSignal(false)
	let [requested, setRequested] = createSignal(false)
	let enable = () => void push.enable().then(() => setRequested(true)).catch((e) => alert(`Notifications: ${e.message}`))
	let [open, setOpen] = createSignal(false)
	let [alerts, setAlerts] = createSignal(false)
	let sheet!: HTMLDialogElement
	// showModal()/close() move focus, running focus handlers (Composer's
	// dismissMenu reads state) inside this effect: untracked, as of the event.
	createEffect(open, (o) => untrack(() => {
		if (o && !sheet.open) {
			sheet.showModal()
			// The list opens on the shown tab, however far down it is.
			sheet.querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest' })
		}
		if (!o && sheet.open) sheet.close()
	}))
	let pages!: HTMLElement
	let track!: HTMLElement
	let probe!: HTMLElement
	let [room, setRoom] = createSignal({ width: 0, ch: 8 })
	let [visible, setVisible] = createSignal({ start: 0, end: 0 })
	let current = () => props.tabs.findIndex((t) => t.id === props.shown)
	let layout = createMemo(() => {
		let { width, ch } = room()
		let d = tabPages.digits(props.tabs.length)
		let base = Math.max(44, (d + 2) * ch)
		let named = base + (NAME + 1) * ch
		let names = props.tabs.length * named <= width
		let overflow = !names && props.tabs.length * base > width
		let edge = 24
		let available = Math.max(1, width - (overflow ? 2 * edge : 0))
		let per = Math.max(1, Math.floor(available / base))
		// Fill fractional leftover room instead of black gaps beside the cells.
		let cell = overflow ? available / per : names ? named : base
		return { names, overflow, edge, cell, d }
	})
	let measureVisible = () => {
		if (!track) return
		let n = props.tabs.length
		// Rendered cells round to layout units; layout().cell drifts over many tabs.
		let cell = track.scrollWidth / n || layout().cell
		let right = track.scrollLeft + track.clientWidth
		let start = Math.max(0, Math.ceil((track.scrollLeft - 1) / cell))
		let end = right >= track.scrollWidth - 1 ? n : Math.min(n, Math.floor((right + 1) / cell))
		setVisible({ start, end })
	}
	let center = (smooth: boolean) => {
		if (!track) return
		let cell = layout().cell
		let target = Math.round(((current() + .5) * cell - track.clientWidth / 2) / cell) * cell
		smooth &&= !matchMedia('(prefers-reduced-motion: reduce)').matches
		track.scrollTo({ left: Math.max(0, target), behavior: smooth ? 'smooth' : 'instant' })
		measureVisible()
	}
	onSettled(() => {
		let measure = () => {
			setRoom({ width: pages.clientWidth, ch: probe.getBoundingClientRect().width / 10 || 8 })
		}
		let seen = new ResizeObserver(measure)
		seen.observe(pages)
		return () => seen.disconnect()
	})
	// Status/mark updates must not reset a manually scrolled strip.
	let centered = ''
	// Only a tab switch in an already laid-out strip animates; first paint and resizes jump.
	createEffect(() => `${props.shown}:${room().width}:${layout().cell}:${props.tabs.length}`, (key) => {
		if (key === centered) return
		let [was, ...rest] = centered.split(':')
		let smooth = !!was && was !== 'undefined' && rest.join(':') === key.slice(key.indexOf(':') + 1)
		centered = key
		let frame = requestAnimationFrame(() => center(smooth))
		return () => cancelAnimationFrame(frame)
	})
	let edge = (left: boolean): Edge => {
		let hidden = left ? props.tabs.slice(0, visible().start) : props.tabs.slice(visible().end)
		return { count: hidden.length, mark: tabPages.urgent(hidden) }
	}
	let page = (left: boolean) => {
		let { start, end } = visible()
		let cell = layout().cell
		let target = left ? (start + 1) * cell - track.clientWidth : (end - 1) * cell
		// Even a one-cell viewport must make progress.
		if (end - start <= 1) target = track.scrollLeft + (left ? -cell : cell)
		track.scrollTo({ left: target, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
	}
	let newTab = () => {
		setOpen(false)
		tabs.newTab()
	}
	return (
		<header class="Tabs tab" style={{ '--digits': layout().d, '--cell': `${layout().cell}px`, '--edge': `${layout().edge}px` }}>
			<nav class="strip" aria-label="Tabs">
				<button type="button" class="menu" aria-label="All tabs" aria-haspopup="dialog" aria-expanded={open() ? 'true' : 'false'} onClick={() => void setOpen(true)}>
					<Icon name="menu" />
				</button>
				<div class="pages" ref={(e) => (pages = e)}>
					<span class="probe" ref={(e) => (probe = e)} aria-hidden="true">
						0000000000
					</span>
					{layout().overflow && <EdgeButton edge={edge(true)} left active={current() >= 0 && current() < visible().start} onClick={() => page(true)} />}
					<div class="track" ref={(e) => (track = e)} onScroll={measureVisible}>
						<For each={props.tabs.map((tab) => tab.id)}>
							{(id) => {
								let tab = () => props.tabs.find((t) => t.id === id)!
								return <Link tab={tab()} n={props.tabs.findIndex((t) => t.id === id) + 1} shown={id === props.shown} name={layout().names} onPick={() => requestAnimationFrame(() => center(true))} />
							}}
						</For>
					</div>
					{layout().overflow && <EdgeButton edge={edge(false)} left={false} active={current() >= visible().end} onClick={() => page(false)} />}
				</div>
				<button type="button" class="new" aria-label="New tab" onClick={newTab}>
					<Icon name="plus" />
				</button>
				{props.pushReady && !requested() && push.available() && (
					<button type="button" class="notify" onClick={enable}>
						<Icon name="bell" />Notify
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
				<ul tabindex={-1} autofocus>
					<For each={props.tabs}>
						{(tab, i) => (
							<li>
								<Link tab={tab} n={i() + 1} shown={tab.id === props.shown} name dir onPick={() => setOpen(false)} />
								<button type="button" class="close" aria-label={`Close ${tab.name}`} onClick={() => tabs.closeTab(tab.id)}>
									<Icon name="close" />
								</button>
							</li>
						)}
					</For>
				</ul>
				<button type="button" class="new" onClick={newTab}>
					<Icon name="plus" />New tab
				</button>
				<button type="button" onClick={() => { setOpen(false); setAlerts(true) }}><Icon name="bell" />Notifications</button>
				<Show when={settings.webDiagnostics()}>
					<button type="button" onClick={() => { diagnostics.record('manual'); diagnostics.report() }}><Icon name="bug" />Send diagnostics</button>
				</Show>
				<button type="button" aria-pressed={touchProbe() ? 'true' : 'false'} onClick={() => {
					if (touchProbe()) touchDebug.stop(); else touchDebug.start()
					setTouchProbe(!touchProbe())
					setOpen(false)
				}}><Icon name="bug" />Touch debug {touchProbe() ? 'on' : 'off'}</button>
				<button type="button" class="reload" onClick={() => location.reload()}>
					<Icon name="reload" />Reload page
				</button>
			</dialog>
			<Notifications open={alerts()} onClose={() => setAlerts(false)} />
		</header>
	)
}

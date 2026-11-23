/// <reference lib="dom" />
// The host's tabs above the conversation. Each number is lit in its
// project color; the shown tab is a solid key in that color with its
// name. A number rings while its tab waits for you; a working tab
// blinks a block cursor. The strip scrolls natively, independent of
// selection (task ce); the count at the right opens the full list and
// dots when a tab off screen waits. Terminal paging stays in
// common/tab-pages.ts. Tab links retain native Cmd- and middle-click
// behavior, and native link drags; a drag dropped on the strip
// reorders the tabs.

import { createEffect, createMemo, createSignal, flush, For, onSettled, Show, untrack } from 'solid-js'
import { home } from '../../common/home.ts'
import { settings } from '../../common/settings.ts'
import type { Tab } from '../../common/protocol.ts'
import { tabMark, type Mark, type MarkKind } from '../../common/tab-mark.ts'
import { tabPages } from '../../common/tab-pages.ts'
import { router } from '../router.ts'
import { Notifications } from './Notifications.tsx'
import { tabs } from '../tabs.ts'
import { push } from '../push.ts'
import { diagnostics } from '../diagnostics.ts'
import { touchDebug } from '../touch-debug.ts'
import { find } from '../find.ts'
import { Icon } from './Icon.tsx'

// A tab's width, for drag autoscroll.
const CELL = 44
// Marks that wait for you, most urgent first: they dot the count.
const WAITS: MarkKind[] = ['failed', 'approval', 'blocked', 'asking', 'done']

// A blinking block while the tab works; other marks ring the number
// (CSS) and only label it here.
function Marker(props: { mark: Mark | undefined }) {
	let marker!: HTMLSpanElement
	// A memo: an effect reruns whenever its source does, equal or not,
	// and the mark is a new object with each tabs event.
	let blinking = createMemo(() => props.mark?.blinks && props.mark.kind)
	createEffect(blinking, (blinking) => {
		if (!blinking) return
		let frame = requestAnimationFrame(() => {
			for (let animation of marker.getAnimations()) animation.startTime = performance.now() - (Date.now() % 2000)
		})
		return () => cancelAnimationFrame(frame)
	})
	return (
		<span
			ref={(e) => (marker = e)}
			class={[
				'marker',
				...(props.mark
					? [props.mark.kind, ...(props.mark.blinks ? ['blink'] : []), ...(props.mark.jobs ? ['with-jobs'] : [])]
					: []),
			]}
			role="img"
			aria-label={props.mark?.label}
		/>
	)
}

// A plain left click shows the tab here; anything else is the browser's.
function click(e: MouseEvent, id: string, then?: () => void): void {
	if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
	e.preventDefault()
	tabs.show(id, false)
	then?.()
}

function Link(props: {
	tab: Tab
	n: number
	shown: boolean
	name: boolean
	dir?: boolean
	drop?: 'before' | 'after'
	onPick?: () => void
	firstCard?: () => void
}) {
	let mark = () => tabMark.mark(props.tab)
	return (
		<a
			href={router.format(props.tab.id)}
			class="tab"
			data-id={props.tab.id}
			data-drop={props.drop}
			data-mark={mark()?.kind}
			style={props.tab.color === undefined ? undefined : { '--project': `var(--p${props.tab.color})` }}
			aria-current={props.shown ? 'page' : undefined}
			title={`${props.n} ${props.tab.name} · ${props.tab.cwd}${mark() ? ` · ${mark()!.label}` : ''}`}
			onPointerDown={() => tabs.press(props.tab.id)}
			onClick={(e) => {
				if (props.shown && props.firstCard && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
					e.preventDefault()
					props.firstCard()
				} else click(e, props.tab.id, props.onPick)
			}}
		>
			<span class="face">
				<span class="n">{props.n}</span>
				<Marker mark={mark()} />
				{props.name && <span class="name">{props.tab.name}</span>}
				{props.dir && <span class="dir">{home.short(props.tab.cwd)}</span>}
			</span>
		</a>
	)
}

export function Tabs(props: { firstCard: () => void; tabs: Tab[]; shown: string | undefined; pushReady: boolean }) {
	let [touchProbe, setTouchProbe] = createSignal(false)
	let [requested, setRequested] = createSignal(false)
	let enable = () =>
		void push
			.enable()
			.then(() => setRequested(true))
			.catch((e) => alert(`Notifications: ${e.message}`))
	let [open, setOpen] = createSignal(false)
	let [alerts, setAlerts] = createSignal(false)
	let sheet!: HTMLDialogElement
	// showModal()/close() move focus, running focus handlers (Composer's
	// dismissMenu reads state) inside this effect: untracked, as of the event.
	createEffect(open, (o) =>
		untrack(() => {
			if (o && !sheet.open) {
				sheet.showModal()
				// The list opens on the shown tab, however far down it is.
				sheet.querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest' })
			}
			if (!o && sheet.open) sheet.close()
		}),
	)
	let track!: HTMLElement
	let byId = createMemo(() => new Map(props.tabs.map((tab) => [tab.id, tab])))
	let ids = createMemo(() => props.tabs.map((tab) => tab.id), {
		equals: (a, b) => a.length === b.length && a.every((id, i) => id === b[i]),
	})
	let [width, setWidth] = createSignal(0)
	// start..end-1 are fully visible; tabs under 10% visible count as off screen for the count's dot.
	let [visible, setVisible] = createSignal({ start: 0, end: 0, markStart: 0, markEnd: 0 })
	let current = () => props.tabs.findIndex((t) => t.id === props.shown)
	// The shown tab is wider than the others, so ranges come from rendered rects.
	let measureVisible = () => {
		if (!track) return
		let { left, right } = track.getBoundingClientRect()
		let start = -1,
			end = 0,
			markStart = -1,
			markEnd = 0
		for (let [i, tab] of [...track.children].entries()) {
			let r = tab.getBoundingClientRect()
			let seen = Math.min(r.right, right) - Math.max(r.left, left)
			if (seen >= r.width - 1) {
				if (start < 0) start = i
				end = i + 1
			}
			if (seen > r.width / 10) {
				if (markStart < 0) markStart = i
				markEnd = i + 1
			}
		}
		start = Math.max(0, start)
		setVisible({ start, end, markStart: Math.max(0, Math.min(start, markStart)), markEnd: Math.max(end, markEnd) })
		tabs.onScreen(start, end)
	}
	// Centers the shown tab on the nearest tab start, where scroll snapping lands anyway.
	let center = (smooth: boolean) => {
		let key = track?.children[current()] as HTMLElement | undefined
		if (!key) return measureVisible()
		let ideal = key.offsetLeft + key.offsetWidth / 2 - track.clientWidth / 2
		let target = 0
		for (let tab of track.children as HTMLCollectionOf<HTMLElement>)
			if (Math.abs(tab.offsetLeft - ideal) < Math.abs(target - ideal)) target = tab.offsetLeft
		smooth &&= !matchMedia('(prefers-reduced-motion: reduce)').matches
		track.scrollTo({ left: target, behavior: smooth ? 'smooth' : 'instant' })
		measureVisible()
	}
	onSettled(() => {
		let seen = new ResizeObserver(() => setWidth(track.clientWidth))
		seen.observe(track)
		return () => seen.disconnect()
	})
	// Status/mark updates must not reset a manually scrolled strip.
	let centered = ''
	// Only a tab switch in an already laid-out strip animates; first paint and resizes jump.
	createEffect(
		() => `${props.shown}/${current()}:${width()}:${props.tabs.length}`,
		(key) => {
			if (key === centered) return
			let [was, ...rest] = centered.split(':')
			let smooth = !!was && !was.startsWith('undefined/') && rest.join(':') === key.slice(key.indexOf(':') + 1)
			centered = key
			let frame = requestAnimationFrame(() => center(smooth))
			return () => cancelAnimationFrame(frame)
		},
	)
	let waiting = createMemo(() => {
		let { markStart, markEnd } = visible()
		let marks = [...props.tabs.slice(0, markStart), ...props.tabs.slice(markEnd)].map(tabMark.mark)
		for (let kind of WAITS) {
			let mark = marks.find((m) => m?.kind === kind)
			if (mark) return mark
		}
	})
	let newTab = () => {
		setOpen(false)
		tabs.newTab()
	}
	// The strip tab being dragged, and the gap (0..n) it would drop into.
	let dragged: string | undefined
	let [gap, setGap] = createSignal<number>()
	let lastOver = 0
	let gapAt = (e: DragEvent) =>
		[...track.children].filter((t) => {
			let r = t.getBoundingClientRect()
			return r.left + r.width / 2 < e.clientX
		}).length
	let drop = (i: number): 'before' | 'after' | undefined => {
		let g = gap()
		let from = props.tabs.findIndex((t) => t.id === dragged)
		if (g === undefined || g === from || g === from + 1) return undefined
		if (g === i) return 'before'
		if (g === props.tabs.length && i === g - 1) return 'after'
	}
	let over = (e: DragEvent) => {
		if (!dragged) return
		e.preventDefault()
		e.dataTransfer!.dropEffect = 'move'
		// Browsers do not autoscroll the strip; dragover repeats while the pointer
		// rests. It scrolls 8 cells a second, however often dragover fires.
		let now = performance.now()
		let step = (Math.min(100, now - lastOver) * CELL * 8) / 1000
		lastOver = now
		let { left, right } = track.getBoundingClientRect()
		if (e.clientX < left + CELL) track.scrollLeft -= step
		else if (e.clientX > right - CELL) track.scrollLeft += step
		setGap(gapAt(e))
	}
	let endDrag = () => {
		dragged = undefined
		setGap(undefined)
	}
	return (
		<header
			class="Tabs tab"
			onClick={(e) => {
				if (!(e.target as Element).closest('button,a,dialog')) props.firstCard()
			}}
			style={{ '--digits': tabPages.digits(props.tabs.length) }}
		>
			<nav
				class={['strip', ...(gap() === undefined ? [] : ['dragging'])]}
				aria-label="Tabs"
				onDragStart={(e) => (dragged = (e.target as HTMLElement).closest<HTMLElement>('.track .tab')?.dataset.id)}
				onDragEnter={over}
				onDragOver={over}
				onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setGap(undefined)}
				onDrop={(e) => {
					if (!dragged) return
					e.preventDefault()
					let from = props.tabs.findIndex((t) => t.id === dragged)
					let to = gapAt(e)
					if (to > from) to--
					if (from >= 0 && to !== from) tabs.move(dragged, to)
					endDrag()
				}}
				onDragEnd={endDrag}
			>
				<div class="track" ref={(e) => (track = e)} onScroll={measureVisible}>
					<For each={ids()}>
						{(id, i) => {
							let tab = () => byId().get(id)!
							return (
								<Link
									tab={tab()}
									n={i() + 1}
									shown={id === props.shown}
									name={id === props.shown}
									drop={drop(i())}
									firstCard={props.firstCard}
									onPick={() => requestAnimationFrame(() => center(true))}
								/>
							)
						}}
					</For>
				</div>
				<button type="button" class="new" aria-label="New tab" onClick={newTab}>
					<Icon name="plus" />
				</button>
				{props.pushReady && !requested() && push.available() && (
					<button type="button" class="notify" onClick={enable}>
						<Icon name="bell" />
						Notify
					</button>
				)}
				<button
					type="button"
					class="count"
					aria-label={`All ${props.tabs.length} tabs${waiting() ? `, one off screen ${waiting()!.label}` : ''}`}
					aria-haspopup="dialog"
					aria-expanded={open() ? 'true' : 'false'}
					onClick={() => void setOpen(true)}
				>
					<span class="box">{props.tabs.length}</span>
					{waiting() && <span class="dot" data-mark={waiting()!.kind} />}
				</button>
			</nav>
			<dialog
				ref={(e) => (sheet = e)}
				class="sheet"
				aria-label="Tabs"
				onClose={() => setOpen(false)}
				onClick={(e) => e.target === e.currentTarget && setOpen(false)}
			>
				<ul tabindex={-1} autofocus>
					{/* Keyed by id: each tabs event brings new objects, and a row
					    replaced between touch down and up loses its click. */}
					<For each={ids()}>
						{(id, i) => {
							let tab = () => byId().get(id)!
							return (
								<li>
									<Link tab={tab()} n={i() + 1} shown={id === props.shown} name dir onPick={() => setOpen(false)} />
									<button
										type="button"
										class="close"
										aria-label={`Close ${tab().name}`}
										onClick={() => tabs.closeTab(id)}
									>
										<Icon name="close" />
									</button>
								</li>
							)
						}}
					</For>
				</ul>
				<button type="button" class="new" onClick={newTab}>
					<Icon name="plus" />
					New tab
				</button>
				<button
					type="button"
					onClick={() => {
						// iOS opens the keyboard only for focus inside the tap: close the
						// sheet, then open Find and focus its field before returning.
						setOpen(false)
						flush()
						find.open()
						flush()
					}}
				>
					<Icon name="google" />
					Find
				</button>
				<button
					type="button"
					onClick={() => {
						setOpen(false)
						setAlerts(true)
					}}
				>
					<Icon name="bell" />
					Notifications
				</button>
				<Show when={settings.webDiagnostics()}>
					<button
						type="button"
						onClick={() => {
							diagnostics.record('manual')
							diagnostics.report()
						}}
					>
						<Icon name="bug" />
						Send diagnostics
					</button>
				</Show>
				<button
					type="button"
					aria-pressed={touchProbe() ? 'true' : 'false'}
					onClick={() => {
						if (touchProbe()) touchDebug.stop()
						else touchDebug.start()
						setTouchProbe(!touchProbe())
						setOpen(false)
					}}
				>
					<Icon name="bug" />
					Touch debug {touchProbe() ? 'on' : 'off'}
				</button>
				<button
					type="button"
					onClick={() => {
						setOpen(false)
						touchDebug.inspect()
					}}
				>
					<Icon name="bug" />
					Touch debug logs
				</button>
				<button type="button" class="reload" onClick={() => location.reload()}>
					<Icon name="reload" />
					Reload page
				</button>
			</dialog>
			<Notifications open={alerts()} onClose={() => setAlerts(false)} />
		</header>
	)
}

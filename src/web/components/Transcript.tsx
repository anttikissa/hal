/// <reference lib="dom" />
// The session's transcript: one card per row (transcriptRows.rows), keyed by the
// row's key (task w5), so a row keeps its DOM and whether it is open
// when a snapshot replaces every item, a streaming item grows, earlier
// history arrives above or a pending prompt lands; the open question as
// a form; the mark where replayed history ends; the prompts still
// pending, after the rows; and Hal's cursor, inside the card that
// streams (Card.tsx), else on a line of its own. The one scroller: the
// browser keeps a bottom reader at the bottom (scroll.ts).

import {
	createEffect,
	createMemo,
	createProjection,
	createSignal,
	flush,
	For,
	onSettled,
	Show,
	untrack,
} from 'solid-js'
import type { SessionMeta } from '../../common/session.ts'
import type { Sending } from '../../common/drafts.ts'
import type { Tab } from '../../common/protocol.ts'
import { amend } from '../../common/amend.ts'
import { backfill } from '../../common/backfill.ts'
import { bashResult } from '../../common/bash-result.ts'
import { card } from '../../common/card.ts'
import { forms } from '../../common/forms.ts'
import { toolDetails } from '../../common/tool-details.ts'
import { transcript, type Item } from '../../common/transcript.ts'
import { transcriptLive } from '../../common/transcript-live.ts'
import { app } from '../app.ts'
import { cardRows } from '../card-rows.ts'
import { folds } from '../folds.ts'
import { scroll } from '../scroll.ts'
import { target } from '../target.ts'
import { view, type ViewState } from '../view.ts'
import { transcriptRows, type Row } from '../transcript-rows.ts'
import { Card } from './Card.tsx'
import { Question } from './Question.tsx'

const none: Item[] = []
const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((k) => b.has(k))
// A row's marks, bits in Transcript's `marks`.
const CURSOR = 1,
	LAST = 2,
	TARGET = 4,
	JOB = 8,
	EDIT = 16,
	DISCARD = 32,
	RUNNING = 64
type Shared = { session: string; blocks?: SessionMeta['blocks']; formId?: string; since?: string }

// A tab shows its newest rows first: building every card of a long
// session takes most of a second. Earlier rows are added a few at a
// time as the reader nears the top (60 at once dropped frames while
// scrolling: ADEMark A11), per session so a tab keeps its
// rows when shown again. The first shown row is kept by key, so new
// rows only add below: a row once shown never leaves the top, and text
// a reader is reading or selecting never moves.
const first = 40
const page = 100
// Rows the window moves at a time: 64 cards took over 150 ms to build,
// a visible stall mid-fling; 16 cost about a quarter.
const step = 16
const [starts, setStarts] = createSignal<ReadonlyMap<string, string>>(new Map())

// Session `id`'s tab is shown again. Read at the bottom, it starts over
// from its newest rows: rows a long turn added while it was shown would
// otherwise all be built again (ADEMark A11 took 10 s to switch).
export function reopened(id: string): void {
	if (scroll.state.places.has(id) || !starts().has(id)) return
	let next = new Map(starts())
	next.delete(id)
	setStarts(next)
}

// `target`: the block the address links to (target.ts), whose card is
// marked and opens.
export function Transcript(props: {
	view: ViewState
	pending: Sending[]
	target?: NonNullable<typeof app.state.target>
	tabs?: Tab[]
	onEnd?: () => void
}) {
	let el!: HTMLElement
	let id = () => props.view.transcript?.meta.id ?? ''
	const limit = 200
	let start = () => {
		let rows = all(),
			key = starts().get(id())
		let i = key === undefined ? -1 : rows.findIndex((r) => r.key === key)
		return i >= 0 ? i : Math.max(0, rows.length - first)
	}
	let setStart = (i: number) =>
		untrack(() => {
			let key = all()[i]?.key
			if (key !== undefined && starts().get(id()) !== key) setStarts(new Map(starts()).set(id(), key))
		})
	// Space above the rows stands for the rows not mounted and the history
	// not fetched, so a fling up has room. Moving the window changes this
	// margin, never scrollTop: on iOS a scrollTop write ends a fling. The
	// margin becomes its estimate once scrolling settles.
	let rowsEl!: HTMLElement
	let last = 0
	let placed: string | undefined
	let heights = new Map<string, number>()
	let cachedWidth = 0
	let syncWidth = () => {
		let w = rowsEl?.clientWidth ?? 0
		if (w > 0 && Math.abs(w - cachedWidth) > 2) {
			heights.clear()
			cachedWidth = w
		}
		return w
	}
	let measureRow = () => {
		let w = syncWidth() || el.clientWidth || innerWidth
		let sample = rowsEl.firstElementChild as HTMLElement | null
		let lh = (sample && parseFloat(getComputedStyle(sample).lineHeight)) || 20
		let cols = Math.max(20, Math.floor((w - 20) / 8.4))
		let session = id(),
			blocks = shared.blocks
		return (row: Row) => {
			let item = row.item
			let bash = !!bashResult.background(item) || (item.type === 'tool' && item.name === 'bash')
			let open =
				untrack(() =>
					folds.level(
						`${session}#${row.job ? row.key : item.key}`,
						folds.start(session, item, card.initial(item, blocks, card.failed(row.result, bash))),
					),
				) === 'long'
			if (open) {
				let cached = heights.get(`${session}\0${row.key}`)
				if (cached !== undefined) return cached
			}
			return cardRows.height(row, open, cols, lh)
		}
	}
	let setPad = (px: number) => {
		px = Math.max(0, Math.round(px))
		scroll.state.pad = px
		rowsEl.style.marginTop = `${px}px`
	}
	let estimate = () => {
		let rows = all(),
			i = start()
		let b = app.state.older.get(id()),
			sample = b?.older ? (b.loaded.slice(0, 50) ?? []) : []
		let unfetched =
			b?.older && sample.length
				? (b.older / JSON.stringify(sample).length) * sample.length * (rows.length / b.loaded.length)
				: 0
		if (!i && !unfetched) return 0
		return cardRows.space(rows, i, unfetched, measureRow())
	}
	let settle = () => {
		if (!rowsEl) return
		let pad = scroll.state.pad,
			next = estimate()
		if (Math.abs(next - pad) < 1) return
		let top = el.scrollTop + next - pad
		scroll.note(`settle ${pad}>${next}`)
		setPad(next)
		el.scrollTop = top
		last = el.scrollTop
	}
	onSettled(() => {
		last = el.scrollTop
		let shift = (next: number, moved: () => number) => {
			scroll.reading()
			scroll.note(`shift ${next}`)
			placed = `${id()}\n${all()[next]!.key}`
			scroll.quiet(() => {
				setStart(next)
				flush()
			})
			setPad(scroll.state.pad - moved())
			last = el.scrollTop
			if (!scroll.state.moving?.()) settle()
		}
		// The view is in the space above the rows (the scrollbar, or a fling
		// outrunning them): the window moves to the row estimated there.
		let place = () => {
			let pad = scroll.state.pad,
				center = el.scrollTop + el.clientHeight / 2,
				i = start()
			if (center >= pad) return false
			let rows = all(),
				h = measureRow()
			let row = cardRows.locate(rows, i, pad, center, h)
			// Not fetched yet: rows mounted now would be replaced page by page.
			if (row < 0 && !backfill.complete(app.state.older, id())) {
				app.older()
				return true
			}
			let next = Math.max(0, row - limit / 2)
			if (next < i) shift(next, () => cardRows.span(rows, next, i, h))
			return true
		}
		let advance = () => {
			let top = el.scrollTop,
				delta = top - last,
				pad = scroll.state.pad
			last = top
			if (!delta || (props.target && !props.target.shown)) return
			let i = start(),
				up = delta < 0
			if (top < pad && !i && backfill.complete(app.state.older, id())) return settle()
			if (up && i <= page) app.older()
			if (place()) return
			let ahead = Math.max(el.clientHeight * 8, Math.abs(delta) * 8)
			if (up ? top - pad > ahead : scroll.gap(el) > ahead) return
			let next = up ? Math.max(0, i - step) : Math.min(i + step, all().length - limit)
			if (up ? next >= i : next <= i) return
			let box = el.getBoundingClientRect()
			let anchor = document
				.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
				?.closest('[data-scroll-key]')
			if (!anchor) return
			let index = all().findIndex((row) => row.key === anchor.getAttribute('data-scroll-key'))
			if (index < next || index >= next + limit) return
			let y = anchor.getBoundingClientRect().top
			shift(next, () => anchor.getBoundingClientRect().top - y)
		}
		let dispose = scroll.init(
			el,
			() => {
				place()
				if (!start()) app.older()
			},
			settle,
		)
		scroll.state.showEnd = () => {
			if (all().length > start() + limit) {
				scroll.note('showEnd')
				scroll.quiet(() => {
					setStart(Math.max(0, all().length - first))
					flush()
				})
			}
		}
		el.addEventListener('scroll', advance, { passive: true })
		return () => {
			el.removeEventListener('scroll', advance)
			scroll.state.showEnd = undefined
			dispose()
		}
	})
	// Another tab, or the window moved by a jump: the margin is estimated
	// again at once, keeping the view in place until the jump positions it.
	createEffect(
		() => `${id()}\n${starts().get(id())}`,
		(now) => {
			if (now === placed) return
			placed = now
			untrack(settle)
		},
	)
	// Scrolled well above the bottom: a pill on the cards' bar takes the
	// reader back down. Checked on scroll and when rows change, since
	// content growing below a still reader moves the bottom away.
	let [away, setAway] = createSignal(false)
	let [pressed, setPressed] = createSignal(false)
	let released: ReturnType<typeof setTimeout> | undefined
	function end() {
		props.onEnd?.()
		scroll.note('end')
		setPressed(true)
		flush()
		if (el && start() + limit >= all().length && scroll.near(scroll.gap(el))) scroll.bottom(true)
		else {
			scroll.dim()
			scroll.land(() => scroll.bottom())
		}
		clearTimeout(released)
		released = setTimeout(() => setPressed(false), 150)
	}
	let seen = new Map<string, string>()
	let [missed, setMissed] = createSignal(0)
	let check = () => {
		if (!el) return
		let above = start() + limit < all().length || scroll.gap(el) > scroll.awayPx
		setAway(above)
		let list = rows(),
			key = id(),
			last = list.at(-1)?.key
		if (!last) return setMissed(0)
		if (!above || !seen.has(key)) seen.set(key, last)
		let index = list.findLastIndex((r) => r.key === seen.get(key))
		setMissed(index < 0 ? 0 : list.length - index - 1)
	}
	// Headers stick only on blocks over 10 lines tall, of every kind, and
	// only while they fit in a third of the transcript: a long open title
	// pinned at the top would hide the body scrolling under it.
	let tall = new ResizeObserver((entries) => {
		let session = untrack(id),
			w = syncWidth()
		let found = entries.map(({ target }) => {
			let block = target as HTMLElement
			let head = block.querySelector<HTMLElement>(':scope .CardHeader:not(.inline)')
			let fits = !head || head.offsetHeight <= el.clientHeight / 3
			let lh = parseFloat(getComputedStyle(block).lineHeight) || 20
			let h = block.offsetHeight
			if (
				w > 0 &&
				h > 0 &&
				block.isConnected &&
				block.parentElement === rowsEl &&
				(block.classList.contains('open') || block.classList.contains('Question'))
			) {
				let key = block.dataset.scrollKey
				if (key) {
					if (heights.size >= 4000) heights.clear()
					heights.set(`${session}\0${key}`, h + lh * 0.5)
				}
			}
			return [block, fits && h > 10 * lh] as const
		})
		for (let [block, on] of found) block.toggleAttribute('data-tall', on)
	})
	onSettled(() => {
		el.addEventListener('scroll', check, { passive: true })
		return () => el.removeEventListener('scroll', check)
	})
	// Rows follow the items alone: redraws that leave them be (typing, the
	// status) keep every row object, so no card binding runs again.
	let items = createMemo(() => (props.view.transcript ? transcript.shown(props.view.transcript) : none))
	let rows = createMemo<Row[]>((before) => transcriptRows.rows(items(), props.view.sent, before))
	let tabIds = createMemo(() => props.tabs?.map((t) => t.id), {
		equals: (a, b) => a?.length === b?.length && (a?.every((id, i) => id === b?.[i]) ?? true),
	})
	let jobCalls = createMemo(() => (props.view.transcript ? transcriptLive.jobItems(props.view.transcript) : none), {
		equals: (a, b) => a.length === b.length && a.every((item, i) => item === b[i]),
	})
	let all = createMemo(() =>
		transcriptRows.withPending(
			rows(),
			props.pending,
			props.view.transcript?.inbox,
			tabIds(),
			props.view.transcript?.queueHold,
			jobCalls(),
		),
	)
	// The row Hal's cursor sits in: the last, while it streams.
	let streaming = createMemo(() => view.streaming(props.view))
	let lastKey = createMemo(() => rows().at(-1)?.key)
	// The call the session runs now: its card ticks (task hyt).
	let running = createMemo(
		() => {
			let st = props.view.transcript?.state
			return st?.type === 'running' && st.phase === 'tools' && st.call ? { call: st.call, since: st.since } : undefined
		},
		{ equals: (a, b) => a?.call === b?.call && a?.since === b?.since },
	)
	// Otherwise its own line after the last row, before waiting and
	// pending messages: the cursor is the work now, they the future.
	let line = () => (
		<div class="cursor-line" aria-hidden="true">
			<span />
		</div>
	)
	// Background jobs still running, by call key: their cards offer Kill.
	let jobs = createMemo(() => transcriptRows.jobs(all()), { equals: sameSet })
	// Prompts the user may edit and resend (task 26q): their cards offer Edit.
	// One queued message is edited at a time, in one window.
	let editableWaiting = (r: Row, held: string | undefined) =>
		!held && r.note !== undefined && r.item.type === 'prompt' && r.item.from === undefined && r.item.origin !== 'model'
	let editable = createMemo(() => amend.editable(items()), { equals: sameSet })
	let hit = createMemo(() => props.target && target.row(all(), props.target.key)?.key)
	// What cards read, as stores: a card subscribes to its own row's
	// marks and to shared leaves, never to a memo of props.view. Every
	// streamed event replaces props.view, and Solid marks each node
	// downstream of it, so one read of such a memo per card made each
	// event cost O(rows). A store notifies only readers of the keys that
	// changed (createProjection, Solid 2's createSelector).
	let shared = createProjection<Shared>(
		(draft) => {
			draft.session = id()
			draft.blocks = forms.cards(props.view.form, props.view.transcript?.meta.blocks)
			draft.formId = props.view.form?.id
			draft.since = running()?.since
		},
		{ session: '' },
	)
	let marks = createProjection<Record<string, number>>((draft) => {
		let next = new Map<string, number>()
		let add = (key: string | undefined | false, bit: number) =>
			key !== undefined && key !== false && next.set(key, (next.get(key) ?? 0) | bit)
		let call = running()?.call,
			held = props.view.transcript?.queueHold,
			edits = editable(),
			busy = jobs()
		add(lastKey(), streaming() ? CURSOR : LAST)
		add(hit(), TARGET)
		for (let r of all()) {
			if (busy.has(r.item.key)) add(r.key, JOB)
			if (!r.pending && (r.waiting ? editableWaiting(r, held) : edits.has(r.item.key))) add(r.key, EDIT)
			if (r.note !== undefined && r.key !== held) add(r.key, DISCARD)
			if (call && !r.job && r.item.type === 'tool' && r.item.id === call) add(r.key, RUNNING)
		}
		for (let key of Object.keys(draft)) if (!next.has(key)) delete draft[key]
		for (let [key, bits] of next) if (draft[key] !== bits) draft[key] = bits
	}, {})
	let marked = (key: string, bit: number) => !!((marks[key] ?? 0) & bit)
	createEffect(
		() => props.target,
		(request) =>
			untrack(() => {
				if (!request || request.shown) return
				let key = target.row(all(), request.key)?.key
				if (!key) return
				let index = all().findIndex((r) => r.key === key)
				if (index >= 0 && (index < start() || index >= start() + limit)) setStart(index)
			}),
	)
	let shown = createMemo(() => all().slice(start(), start() + limit))
	// Pin the first shown row once the tab has rows.
	createEffect(
		() => (all().length && !starts().has(id()) ? start() : -1),
		(i) => void (i >= 0 && setStart(i)),
	)
	// New cards only: observing every card again on each streamed event
	// re-measured them all.
	let added = new MutationObserver((records) => {
		for (let { removedNodes } of records) for (let n of removedNodes) if (n instanceof HTMLElement) tall.unobserve(n)
		for (let { addedNodes } of records)
			for (let node of addedNodes)
				if (node instanceof HTMLElement && node.matches('.Card, .Question')) tall.observe(node)
	})
	onSettled(() => {
		let list = el.querySelector(':scope > .rows')!
		for (let block of list.querySelectorAll(':scope > :is(.Card, .Question)')) tall.observe(block)
		added.observe(list, { childList: true })
		return () => added.disconnect()
	})
	// One check a frame, however many events arrive in it.
	let frame = 0
	createEffect(shown, () => {
		frame ||= requestAnimationFrame(() => {
			frame = 0
			check()
		})
	})
	let open = (row: Row) => (row.item.type === 'question' && shared.formId === row.item.id ? row.item : undefined)
	let waiting = (title: string) => toolDetails.waiting(title, props.view.transcript?.meta.id ?? '', items(), props.tabs)
	return (
		<>
			<main class="Transcript" role="log" ref={(e) => (el = e)}>
				<div class="rows" ref={(e) => (rowsEl = e)}>
					<For each={shown()} keyed={(row) => row.key}>
						{(row) => {
							let cursor = createMemo(() => marked(row().key, CURSOR))
							let last = createMemo(() => marked(row().key, LAST))
							return (
								<>
									<Show
										when={open(row())}
										fallback={
											<Card
												row={row()}
												session={shared.session}
												blocks={shared.blocks}
												running={
													row().job
														? { call: (row().item as { id: string }).id, since: row().item.ts }
														: marked(row().key, RUNNING)
															? { call: (row().item as { id: string }).id, since: shared.since }
															: undefined
												}
												cursor={cursor()}
												target={marked(row().key, TARGET)}
												job={marked(row().key, JOB) ? row().item.key : undefined}
												edit={marked(row().key, EDIT)}
												discard={marked(row().key, DISCARD)}
												waiting={waiting}
											/>
										}
									>
										{(q) => (
											<Question
												item={q()}
												form={props.view.form!}
												session={shared.session}
												target={marked(row().key, TARGET)}
											/>
										)}
									</Show>
									<Show when={last()}>{line()}</Show>
								</>
							)
						}}
					</For>
					<Show when={!streaming() && !rows().length}>{line()}</Show>
				</div>
			</main>
			<div class="to-bottom">
				<Show when={away() || pressed()}>
					<button
						type="button"
						aria-label={missed() ? `Scroll to the bottom: ${missed()} new cards` : 'Scroll to the bottom'}
						data-count={missed() || undefined}
						title="Scroll to the bottom"
						data-activated={pressed() || undefined}
						onPointerDown={() => {
							clearTimeout(released)
							setPressed(true)
							flush()
						}}
						onPointerUp={() => setPressed(false)}
						onPointerCancel={() => setPressed(false)}
						onPointerLeave={() => setPressed(false)}
						onClick={end}
					>
						<svg viewBox="0 0 24 24" aria-hidden="true">
							<path d="M12 4v15m-7-7 7 7 7-7" />
						</svg>
					</button>
				</Show>
			</div>
		</>
	)
}

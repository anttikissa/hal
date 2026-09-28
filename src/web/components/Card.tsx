/// <reference lib="dom" />
// One transcript row as a card in its theme colours (view.show). A
// thinking or tool card (the call with its result) folds, closed at
// first: its header is a button naming what is inside, and a click
// anywhere on the card toggles it, except on a link or a click that
// ends a text selection. Hidden contents are inert. The height
// animates in CSS; scroll.ts tracks the bottom meanwhile. `cursor`:
// the card streams, so Hal's cursor follows its last character (in the
// header while a folding card is closed). Whether a card is open is
// kept by its session and row key (task w5), not by its DOM, so no other
// item's card ever shows open in its place.
// Every card links to itself (target.ts, task 0z); `target`: the
// address links here, so the card is marked and opens, a tool card
// with its whole output. An open tool card shows a glimpse of its
// result and can show all of it; the transcript holds all of it
// (host tools cap what they keep), so nothing is fetched.

import { createEffect, createMemo, createSignal, flush, onSettled, Show } from 'solid-js'
import { titles } from '../../common/titles.ts'
import { scroll } from '../scroll.ts'
import { target } from '../target.ts'
import { view, type Row } from '../view.ts'

const [opened, setOpened] = createSignal<ReadonlySet<string>>(new Set())
// Tool cards showing their whole result, by the same key.
const [whole, setWhole] = createSignal<ReadonlySet<string>>(new Set())

function toggled(set: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> {
	let next = new Set(set)
	if (on) next.add(id)
	else next.delete(id)
	return next
}

// A new card fades in (--fade-ms, --ease-out from the page's CSS). A
// script animation, not a CSS one: moving the card in the list, as when
// a pending command lands where it ran (task rk), would restart a CSS
// animation, which reads as the card appearing again. Started once the
// card is in the page: a node cloned from a template belongs to an inert
// document, whose animations never run.
let fade: KeyframeAnimationOptions | undefined
function enter(el: HTMLElement): void {
	if (!fade) {
		let css = getComputedStyle(document.documentElement)
		fade = { duration: parseFloat(css.getPropertyValue('--fade-ms')) || 0, easing: css.getPropertyValue('--ease-out').trim() || 'ease-out' }
	}
	el.animate({ opacity: [0, 1] }, fade)
}

// An image row shows the image itself, from the session's blob.
export function Card(props: { row: Row; session: string; cursor?: boolean; target?: boolean }) {
	let id = () => `${props.session}#${props.row.key}`
	let root: HTMLElement | undefined
	onSettled(() => root && enter(root))
	let open = () => opened().has(id())
	let setOpen = (on: boolean) => setOpened(toggled(opened(), id(), on))
	let full = () => whole().has(id())
	let setFull = (on: boolean) => setWhole(toggled(whole(), id(), on))
	createEffect(
		() => props.target,
		(on) => {
			if (!on) return
			setOpen(true)
			setFull(true)
		},
	)
	let shown = () => view.show(props.row.item)
	let result = () => props.row.result && view.show(props.row.result, full())
	// Whether the result is longer than its glimpse.
	let long = () => (props.row.result?.output.replace(/\n$/, '').split('\n').length ?? 0) > view.resultRows()
	// The link shows the block's id, #35, as the terminal does. Its
	// text is drawn by CSS from data-ref, so copying the card's text
	// leaves it out.
	let href = () => (props.row.pending ? undefined : target.href(props.session, props.row.item.key))
	let link = () => (
		<Show when={href()}>
			{(h) => (
				<a class="link" href={h()} data-ref={`#${props.row.item.key}`} title="Link to this block" aria-label={`Link to block ${props.row.item.key}`} />
			)}
		</Show>
	)
	let folds = () => props.row.item.type === 'thinking' || props.row.item.type === 'tool'
	// A tool's first line (its description or call) heads the card;
	// thinking is headed by the terminal's header words and its first
	// line. Prompts and model text show those words above their text
	// (task hp).
	// A pending row has none: it may yet turn out a command.
	let title = () => titles.title(props.row.item)
	let lines = () => (shown()?.text ?? '').replace(/^▸ /, '').split('\n')
	let head = () => (props.row.item.type === 'thinking' ? `${title()}: ${lines()[0]}` : lines()[0])
	let body = () => {
		let rest = props.row.item.type === 'thinking' ? lines() : lines().slice(1).map((l) => l.replace(/^ {2}/, ''))
		return [...rest, ...(result() ? [result()!.text] : [])].join('\n')
	}
	let failed = () => !!props.row.result?.isError
	let toggle = (e: MouseEvent) => {
		if (!folds() || (e.target as Element).closest('a, .more') || !getSelection()?.isCollapsed) return
		scroll.follow(() => {
			setOpen(!open())
			flush()
		}, 'track')
	}
	// Show all of a tool's result, or its glimpse again, keeping the
	// button (the card's end) in view as the card shrinks.
	let more = (e: MouseEvent) => {
		let button = e.currentTarget as HTMLElement
		scroll.follow(() => {
			setFull(!full())
			flush()
		}, 'track')
		if (!full()) button.scrollIntoView({ block: 'nearest' })
	}
	let cursor = () => <span class="cursor" aria-hidden="true" />
	// A prompt's [image/<name>] markers are links (task qy), rebuilt only
	// when its text changes, not when a snapshot brings a new row object.
	let text = createMemo(() => shown()?.text ?? '')
	let linked = createMemo(() => (props.row.item.type === 'prompt' && text().includes('[image/') ? view.links(text()) : text()))
	let parts = () => {
		let l = linked()
		return typeof l === 'string' ? l : l.map((p) => (typeof p === 'string' ? p : <a href={p.href} target="_blank" rel="noopener">{p.text}</a>))
	}
	// Built once per card: the bindings follow a new row object, so the
	// DOM (and its fade-in) stays when a snapshot or stream replaces it.
	let plain = (s: () => { kind: string; text: string }) => (
		<div ref={(e) => (root = e)} class={['Card', ...s().kind.split(' '), props.row.pending ? 'pending' : '', props.target ? 'target' : '']}>
			{link()}
			<Show when={!props.row.pending && title()}>{(t) => <div class="who">{t()}</div>}</Show>
			<Show when={props.row.item.type === 'image' && props.row.item} fallback={parts()}>
				{(img) => <img src={view.blobUrl(props.session, img().blob)} alt={s().text} />}
			</Show>
			<Show when={props.cursor}>{cursor()}</Show>
		</div>
	)
	return (
		<Show when={shown()}>
			{(s) => (
				<Show when={folds()} fallback={plain(s)}>
					<article ref={(e) => (root = e)} class={['Card', 'folds', ...s().kind.split(' '), open() ? 'open' : '', props.target ? 'target' : '']} onClick={toggle}>
						{link()}
						<button type="button" class="head" aria-expanded={open() ? 'true' : 'false'}>
							<span class="mark" aria-hidden="true">
								{open() ? '▾' : '▸'}
							</span>
							<span class="title">{head()}</span>
							<Show when={props.cursor && !open()}>{cursor()}</Show>
							<Show when={failed()}>
								<span class="error">✗</span>
							</Show>
						</button>
						<div class="body" inert={!open()}>
							<div class="contents">
								{body()}
								<Show when={props.cursor}>{cursor()}</Show>
								<Show when={long()}>
									<button type="button" class="more" onClick={more}>
										{full() ? 'show less' : 'show all'}
									</button>
								</Show>
							</div>
						</div>
					</article>
				</Show>
			)}
		</Show>
	)
}

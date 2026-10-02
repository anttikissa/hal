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

import { createEffect, createMemo, createSignal, flush, For, onSettled, Show } from 'solid-js'
import { markdown as parser } from '../../common/markdown.ts'
import { titles } from '../../common/titles.ts'
import { toolDetails } from '../../common/tool-details.ts'
import { transcript } from '../../common/transcript.ts'
import { Markdown } from './Markdown.tsx'
import { CardHeader } from './CardHeader.tsx'
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
	let expanded = open
	// A tool still streaming after a second opens and stays open (task
	// a5): opening at once and closing on the result made quick calls
	// flash and jolted the scroll.
	let running = () => props.row.item.type === 'tool' && !!props.row.item.partial && !props.row.result
	createEffect(running, (on) => {
		if (!on) return
		let t = setTimeout(() => running() && setOpen(true), 1000)
		return () => clearTimeout(t)
	})
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
	let long = () => (props.row.result ? props.row.result.output.replace(/\n$/, '').split('\n').length : 0) > view.resultRows()
	// The link shows the block's id, #35, as the terminal does. Its
	// text is drawn by CSS from data-ref, so copying the card's text
	// leaves it out.
	let href = () => (props.row.pending || (props.row.waiting && props.row.note === undefined) ? undefined : target.href(props.session, props.row.item.key))
	let link = () => (
		<Show when={href()}>
			{(h) => (
				<a class="link" href={h()} data-ref={`#${props.row.item.key}`} title="Link to this block" aria-label={`Link to block ${props.row.item.key}`} />
			)}
		</Show>
	)
	// Another session's message with a summary folds under it.
	let folds = () => props.row.item.type === 'thinking' || props.row.item.type === 'tool' || (props.row.item.type === 'prompt' && !!props.row.item.summary)
	// A tool's first line (its description or call) heads the card;
	// thinking is headed by the terminal's header words and its first
	// line. Prompts and model text show those words above their text
	// (task hp).
	let title = () => titles.title(props.row.item)
	let source = () => props.row.item.type === 'prompt' && props.row.item.label?.match(/^bash #(\d+)$/)?.[1]
	let who = () => {
		let ref = source(), t = titles.who(props.row.item)
		return ref && t?.endsWith(`#${ref}`) ? <>{t.slice(0, -ref.length - 1)}<a class="call" href={transcript.href(props.session, ref)} title="Go to Bash call">#{ref}</a></> : t
	}
	let marked = (s: string) => {
		let match = /\[exit [1-9]\d*\]/.exec(s)
		return match ? <>{s.slice(0, match.index)}<span class="error exit">{match[0]}</span>{s.slice(match.index + match[0].length)}</> : s
	}
	let lines = () => (shown()?.text ?? '').replace(/^▸ /, '').split('\n')
	let head = () => {
		let item = props.row.item
		// Folded thinking previews its first line as plain text (OpenAI
		// summaries open with **Heading**); open, the body shows it, so
		// the head is the header words alone (task hp).
		if (item.type === 'thinking') return expanded() ? titles.who(item) : `${titles.who(item)}: ${parser.inline(lines()[0] ?? '').map((r) => r.text).join('')}`
		if (item.type === 'prompt' && item.summary) return item.summary
		return item.type === 'tool' ? toolDetails.headline(item.name, item.input).text : lines()[0]
	}
	let headerParts = createMemo(() => view.urlParts(head() ?? ''))
	let body = () => {
		let item = props.row.item
		if (item.type !== 'tool') return lines().join('\n')
		// The call once (task 8t), then its output: the result, or what
		// has streamed so far.
		let call = toolDetails.lines(item.name, item.input)
		let out = result()?.text ?? item.partial?.replace(/\n$/, '')
		return [...call, ...(out ? [...(call.length ? [''] : []), out] : [])].join('\n')
	}
	let failed = () => !!props.row.result?.isError
	let toggle = (e: MouseEvent) => {
		if ((!folds() && props.row.note === undefined) || (e.target as Element).closest('a, .more') || !getSelection()?.isCollapsed) return
		scroll.follow(() => {
			setOpen(!expanded())
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
	// Model text and inter-tab prose are Markdown (tasks fn, sz); human
	// prompts and background Bash output stay literal. A memo preserves DOM.
	let md = createMemo(() => {
		let item = props.row.item
		return item.type === 'text' || item.type === 'thinking' || item.type === 'output' ||
			(item.type === 'prompt' && !!item.from && !/^bash (?:#\d+|b[0-9a-f]{6})$/.test(item.label ?? ''))
	})
	let markdown = () => (
		<Markdown text={shown()?.text ?? ''} streaming={props.cursor}>
			<Show when={props.cursor}>{cursor()}</Show>
		</Markdown>
	)
	// A prompt's [image/<name>] markers are links (task qy), rebuilt only
	// when its text changes, not when a snapshot brings a new row object.
	let text = createMemo(() => shown()?.text ?? '')
	let linked = createMemo(() => (props.row.item.type === 'prompt' && text().includes('[image/') ? view.links(text()) : text()))
	let parts = () => {
		let l = linked()
		return typeof l === 'string' ? l : l.map((p) => (typeof p === 'string' ? p : <a href={p.href} target="_blank" rel="noopener">{p.text}</a>))
	}
	let time = () => titles.time((props.row.item as { ts?: string }).ts)
	let heading = () => <CardHeader time={time()} label={who()} reference={link()} />
	// Content branches share the shell, header and normal body inset.
	let plain = (s: () => { kind: string; text: string }) => (
		<>
			<Show when={title()} fallback={link()}>{heading()}</Show>
			<div class="content">
				<Show when={props.row.item.type === 'image' && props.row.item} fallback={md() ? markdown() : props.row.item.type === 'prompt' && source() ? marked(s().text) : parts()}>
					{(img) => <a href={view.blobUrl(props.session, img().blob)} target="_blank" rel="noopener" title="Open image in a separate tab to zoom"><img src={view.blobUrl(props.session, img().blob)} alt={s().text} /></a>}
				</Show>
				<Show when={props.cursor && !md()}>{cursor()}</Show>
			</div>
		</>
	)
	// A queued message's compact row (task 16): its note and text, no
	// header, at most 3 lines until a click (or its link) opens it.
	let queued = () => {
		let all = `${props.row.note} ${text()}`.split('\n')
		return expanded() || all.length <= 3 ? all.join('\n') : [...all.slice(0, 3), `… ${all.length - 3} more lines`].join('\n')
	}
	let compact = () => (
		<>
			<Show when={expanded() && md()} fallback={<>{link()}<div class="content">{queued()}</div></>}>
				{heading()}
				<div class="content"><div class="sender">{props.row.note}</div>{markdown()}</div>
			</Show>
		</>
	)
	return (
		<Show when={shown()}>
			{(s) => (
				<article ref={(e) => (root = e)} class={['Card', ...s().kind.split(' '), props.row.pending ? 'pending' : '', props.row.note !== undefined ? 'queued' : '', folds() ? 'folds' : '', expanded() ? 'open' : '', props.target ? 'target' : '']} onClick={toggle}>
					<Show when={props.row.note === undefined} fallback={compact()}>
						<Show when={folds()} fallback={plain(s)}>
							<CardHeader time={time()} name={head()} open={expanded()} reference={link()}
								label={<For each={headerParts()}>{(part) => typeof part === 'string' ? part : <a href={part.href} target="_blank" rel="noopener noreferrer">{part.text}</a>}</For>}>
								<Show when={props.cursor && !open()}>{cursor()}</Show>
								<Show when={failed()}><span class="error">✗</span></Show>
							</CardHeader>
							<div class="body" inert={!expanded()}>
								<div class="contents">
									<div class="content">
										<Show when={props.row.item.type === 'prompt'}><div class="sender">{who()}</div></Show>
										{md() ? markdown() : props.row.item.type === 'tool' && props.row.item.name === 'bash' ? marked(body()) : body()}
										<Show when={props.cursor && !md()}>{cursor()}</Show>
										<Show when={long()}><button type="button" class="more" onClick={more}>{full() ? 'show less' : 'show all'}</button></Show>
									</div>
								</div>
							</div>
						</Show>
					</Show>
				</article>
			)}
		</Show>
	)
}

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

import { createSignal, flush, Show } from 'solid-js'
import { scroll } from '../scroll.ts'
import { view, type Row } from '../view.ts'

const [opened, setOpened] = createSignal<ReadonlySet<string>>(new Set())

// An image row shows the image itself, from the session's blob.
export function Card(props: { row: Row; session: string; cursor?: boolean }) {
	let id = () => `${props.session}#${props.row.key}`
	let open = () => opened().has(id())
	let setOpen = (on: boolean) => {
		let next = new Set(opened())
		if (on) next.add(id())
		else next.delete(id())
		setOpened(next)
	}
	let shown = () => view.show(props.row.item)
	let result = () => props.row.result && view.show(props.row.result)
	let folds = () => props.row.item.type === 'thinking' || props.row.item.type === 'tool'
	// A tool's first line (its description or call) heads the card;
	// thinking is headed by its first line.
	let lines = () => (shown()?.text ?? '').replace(/^▸ /, '').split('\n')
	let head = () => (props.row.item.type === 'thinking' ? `thinking: ${lines()[0]}` : lines()[0])
	let body = () => {
		let rest = props.row.item.type === 'thinking' ? lines() : lines().slice(1).map((l) => l.replace(/^ {2}/, ''))
		return [...rest, ...(result() ? [result()!.text] : [])].join('\n')
	}
	let failed = () => !!props.row.result?.isError
	let toggle = (e: MouseEvent) => {
		if (!folds() || (e.target as Element).closest('a') || !getSelection()?.isCollapsed) return
		scroll.follow(() => {
			setOpen(!open())
			flush()
		}, 'track')
	}
	let cursor = () => <span class="cursor" aria-hidden="true" />
	// Built once per card: the bindings follow a new row object, so the
	// DOM (and its fade-in) stays when a snapshot or stream replaces it.
	let plain = (s: () => { kind: string; text: string }) => (
		<div class={['Card', ...s().kind.split(' '), props.row.pending ? 'pending' : '']}>
			<Show when={props.row.item.type === 'image' && props.row.item} fallback={s().text}>
				{(img) => <img src={view.blobUrl(props.session, img().blob)} alt={s().text} />}
			</Show>
			<Show when={props.cursor}>{cursor()}</Show>
		</div>
	)
	return (
		<Show when={shown()}>
			{(s) => (
				<Show when={folds()} fallback={plain(s)}>
					<article class={['Card', 'folds', ...s().kind.split(' '), open() ? 'open' : '']} onClick={toggle}>
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
							</div>
						</div>
					</article>
				</Show>
			)}
		</Show>
	)
}

/// <reference lib="dom" />
// One transcript row as a card in its theme colours (view.show). A
// thinking or tool card (the call with its result) folds, closed at
// first: its header is a button naming what is inside, and a click
// anywhere on the card toggles it, except on a link or a click that
// ends a text selection. Hidden contents are inert. The height
// animates in CSS; scroll.ts tracks the bottom meanwhile.

import { createSignal, flush, Show } from 'solid-js'
import { scroll } from '../scroll.ts'
import { view, type Row } from '../view.ts'

export function Card(props: { row: Row }) {
	let [open, setOpen] = createSignal(false)
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
	return (
		<Show when={shown()}>
			{(s) => (
				<Show when={folds()} fallback={<div class={['Card', ...s().kind.split(' ')]}>{s().text}</div>}>
					<article class={['Card', 'folds', ...s().kind.split(' '), open() ? 'open' : '']} onClick={toggle}>
						<button type="button" class="head" aria-expanded={open() ? 'true' : 'false'}>
							<span class="mark" aria-hidden="true">
								{open() ? '▾' : '▸'}
							</span>
							<span class="title">{head()}</span>
							<Show when={failed()}>
								<span class="error">✗</span>
							</Show>
						</button>
						<div class="body" inert={!open()}>
							<div class="contents">{body()}</div>
						</div>
					</article>
				</Show>
			)}
		</Show>
	)
}

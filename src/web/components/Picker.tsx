/// <reference lib="dom" />
// Native modal shell and search box shared by the model picker and find.
import { createEffect, For, Show } from 'solid-js'
import { fuzzy } from '../../common/fuzzy.ts'
import { findDialog } from '../../common/find-dialog.ts'
import type { ModalState } from '../../common/modals.ts'
import { app } from '../app.ts'
import { picker } from '../../common/picker.ts'
import { find } from '../find.ts'

function marked(text: string, query: string | undefined, literal = false) {
	let out: (string | ReturnType<typeof Match>)[] = [], at = 0
	for (let [from, to] of query ? (literal ? findDialog.marks(text, query) : fuzzy.marks(text, query)) : []) {
		out.push(text.slice(at, from), Match({ text: text.slice(from, to) }))
		at = to
	}
	out.push(text.slice(at))
	return out
}
function Match(props: { text: string }) { return <b class="match">{props.text}</b> }

export function Picker(props: { modal: ModalState | undefined }) {
	let box!: HTMLDialogElement, search!: HTMLInputElement, list!: HTMLUListElement
	// A new query reorders the list, so scroll from the top as the TUI
	// does: the rows above the selection stay in view.
	let query: string | undefined
	createEffect(
		() => ({ selected: props.modal?.selected, query: props.modal?.query, items: props.modal?.items }),
		({ selected, query: q }) => {
			if (selected === undefined) { if (box.open) box.close(); return }
			if (!box.open) { box.showModal(); search.focus() }
			if (q !== query) { query = q; list.scrollTop = 0 }
			list.children[selected]?.scrollIntoView({ block: 'nearest' })
		},
	)
	let cancel = (e: Event) => { e.preventDefault(); app.modalKey({ key: 'escape' }) }
	let outside = (e: MouseEvent) => {
		let r = box.getBoundingClientRect()
		if (e.target === box && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) cancel(e)
	}
	return (
		<dialog ref={(e) => (box = e)} class="Picker" aria-label={props.modal?.title ?? 'Picker'} onCancel={cancel} onClick={outside}>
			<div class="top">
				<div class="title">{props.modal?.title ?? ''}</div>
				<button type="button" class="close" aria-label="Close" onClick={cancel}>✕</button>
			</div>
			<input ref={(e) => (search = e)} class="input" type="text" aria-label="Search" autocomplete="off"
				aria-activedescendant={props.modal?.items.length ? `modal-item-${props.modal.selected}` : ''}
				value={props.modal?.form?.values[0] ?? ''} onInput={(e) => app.search(e.currentTarget.value)} onFocus={() => find.focus(0)} />
			<Show when={props.modal?.find}>
				<div class="filters" role="group" aria-label="Search kinds">
					<For each={findDialog.labels}>{(label, i) => (
						<button type="button" aria-pressed={props.modal?.find?.filters.includes(findDialog.filters[i()]!) ? 'true' : 'false'}
							onFocus={() => find.focus(i() + 1)} onClick={() => find.toggle(i())}>
							{props.modal?.find?.filters.includes(findDialog.filters[i()]!) ? '[x] ' : '[ ] '}{label}
						</button>
					)}</For>
				</div>
			</Show>
			<ul ref={(e) => (list = e)} role="listbox" aria-label="Results" tabindex={props.modal?.find ? 0 : undefined}
				onFocus={() => find.focus(5)} aria-activedescendant={props.modal?.items.length ? `modal-item-${props.modal.selected}` : ''}>
				<For each={props.modal?.items ?? []}>{(item, i) => (
					<li role="option" id={`modal-item-${i()}`} aria-selected={i() === props.modal?.selected ? 'true' : 'false'}
						onClick={() => { if (!props.modal?.find) app.modalPick(i()) }}>
						<Show when={props.modal?.find} fallback={marked(item, props.modal?.query)}>
							<a href={props.modal?.find?.results[i()]?.href} tabindex={-1}>{marked(item, props.modal?.query, true)}</a>
						</Show>
					</li>
				)}</For>
			</ul>
			<Show when={props.modal?.tree}>
				<div class="effort-controls" role="group" aria-label="Selected model effort">
					<button type="button" aria-label={`Lower effort (${props.modal ? picker.label(props.modal, props.modal.tree?.rows[props.modal.selected]?.id ?? '') : ''})`} disabled={!props.modal || !picker.canAdjust(props.modal, 'left')} onClick={() => app.modalKey({ key: 'left' })}>Lower</button>
					<button type="button" aria-label={`Higher effort (${props.modal ? picker.label(props.modal, props.modal.tree?.rows[props.modal.selected]?.id ?? '') : ''})`} disabled={!props.modal || !picker.canAdjust(props.modal, 'right')} onClick={() => app.modalKey({ key: 'right' })}>Higher</button>
				</div>
			</Show>
			<div class="log" role="status">{props.modal?.hint ?? ''}</div>
		</dialog>
	)
}

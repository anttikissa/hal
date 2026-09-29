/// <reference lib="dom" />
// The model picker: a native modal <dialog> with a title, a search box
// that filters as typed, the list (click or Enter picks) and a hint.
// keys.key gives it Up, Down, Enter and Escape first. A tap outside it
// or its close button closes it, as Escape does.

import { createEffect, For } from 'solid-js'
import { fuzzy } from '../../common/fuzzy.ts'
import type { ModalState } from '../../common/modals.ts'
import { app } from '../app.ts'
import { picker } from '../../common/picker.ts'

// `text` in pieces, the search matches in <b> (index.html makes them bright).
function marked(text: string, query: string | undefined) {
	let out: (string | ReturnType<typeof Match>)[] = []
	let at = 0
	for (let [from, to] of query ? fuzzy.marks(text, query) : []) {
		out.push(text.slice(at, from), Match({ text: text.slice(from, to) }))
		at = to
	}
	out.push(text.slice(at))
	return out
}

function Match(props: { text: string }) {
	return <b class="match">{props.text}</b>
}

export function Picker(props: { modal: ModalState | undefined }) {
	let box!: HTMLDialogElement
	let search!: HTMLInputElement
	let list!: HTMLUListElement
	createEffect(
		() => props.modal?.selected,
		(selected) => {
			if (selected === undefined) {
				if (box.open) box.close()
				return
			}
			if (!box.open) { box.showModal(); search.focus() }
			list.children[selected]?.scrollIntoView({ block: 'nearest' })
		},
	)
	// Escape the browser handles itself (it closes the dialog).
	let cancel = (e: Event) => {
		e.preventDefault()
		app.modalKey({ key: 'escape' })
	}
	// A backdrop click lands on the dialog itself, outside its box (a
	// click on its padding is inside and stays open).
	let outside = (e: MouseEvent) => {
		let r = box.getBoundingClientRect()
		if (e.target === box && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) cancel(e)
	}
	return (
		<dialog ref={(e) => (box = e)} class="Picker" aria-label="Model picker" onCancel={cancel} onClick={outside}>
			<div class="top">
				<div class="title">{props.modal?.title ?? ''}</div>
				<button type="button" class="close" aria-label="Close" onClick={cancel}>
					✕
				</button>
			</div>
			<input
				ref={(e) => (search = e)}
				class="input"
				type="text"
				aria-label="Search"
				autocomplete="off"
				aria-activedescendant={props.modal?.items.length ? `modal-item-${props.modal.selected}` : ''}
				value={props.modal?.form?.values[0] ?? ''}
				onInput={(e) => app.search(e.currentTarget.value)}
			/>
			<ul ref={(e) => (list = e)} role="listbox">
				<For each={props.modal?.tree?.rows ?? []}>
					{(row, i) => (
						<li role="option" id={`modal-item-${i()}`} aria-selected={i() === props.modal?.selected ? 'true' : 'false'} onClick={() => app.modalPick(i())}>
							{marked(props.modal?.items[i()] ?? '', props.modal?.query)}
						</li>
					)}
				</For>
			</ul>
			<div class="effort-controls" role="group" aria-label="Selected model effort">
				<button type="button" aria-label={`Lower effort (${props.modal ? picker.label(props.modal, props.modal.tree?.rows[props.modal.selected]?.id ?? '') : ''})`} disabled={!props.modal || !picker.canAdjust(props.modal, 'left')} onClick={() => app.modalKey({ key: 'left' })}>Lower</button>
				<button type="button" aria-label={`Higher effort (${props.modal ? picker.label(props.modal, props.modal.tree?.rows[props.modal.selected]?.id ?? '') : ''})`} disabled={!props.modal || !picker.canAdjust(props.modal, 'right')} onClick={() => app.modalKey({ key: 'right' })}>Higher</button>
			</div>
			<div class="log">{props.modal?.hint ?? ''}</div>
		</dialog>
	)
}

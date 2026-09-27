/// <reference lib="dom" />
// The model picker: a native modal <dialog> with a title, a search box
// that filters as typed, the list (click or Enter picks) and a hint.
// keys.key gives it Up, Down, Enter and Escape first. A tap outside it
// or its close button closes it, as Escape does.

import { createEffect, For } from 'solid-js'
import type { ModalState } from '../../common/modals.ts'
import { app } from '../app.ts'

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
			if (!box.open) box.showModal()
			if (document.activeElement !== search) search.focus()
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
				<For each={props.modal?.items ?? []}>
					{(item, i) => (
						<li role="option" id={`modal-item-${i()}`} aria-selected={i() === props.modal?.selected ? 'true' : 'false'} onClick={() => app.modalPick(i())}>
							{item}
						</li>
					)}
				</For>
			</ul>
			<div class="log">{props.modal?.hint ?? ''}</div>
		</dialog>
	)
}

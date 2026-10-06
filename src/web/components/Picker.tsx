/// <reference lib="dom" />
// Native modal shell and search box shared by the model picker, find and
// /config, whose rows add a value column, a faint note shown on the
// selected, hovered or focused row, an in-place edit field and the
// selected row's details below (common/modals.ts).
import { createEffect, For, Show, untrack } from 'solid-js'
import { fuzzy } from '../../common/fuzzy.ts'
import { findDialog } from '../../common/find-dialog.ts'
import { blocksDialog } from '../../common/blocks-dialog.ts'
import { modals, type ModalState } from '../../common/modals.ts'
import { app } from '../app.ts'
import { picker } from '../../common/picker.ts'
import { settings } from '../../common/settings.ts'
import { find } from '../find.ts'
import { folds } from '../folds.ts'
import { forms } from '../../common/forms.ts'
import { Icon } from './Icon.tsx'

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
	let box!: HTMLDialogElement, search: HTMLInputElement | undefined, list!: HTMLUListElement
	let edit: HTMLInputElement | undefined
	// An edit starting takes the focus; one ending gives it back.
	createEffect(
		() => props.modal?.edit?.index,
		(index) => untrack(() => { if (index === undefined) { if (box.open) search?.focus() } else edit?.focus() }),
	)
	let width = () => `${Math.max(0, ...(props.modal?.items ?? []).map((s) => s.length)) + 2}ch`
	// Model picker table: postfix, effort, name and ID columns, each as
	// wide as its longest model row (effort: its widest choice).
	let columns = () => {
		let m = props.modal, values = m?.values ?? []
		let model = (i: number) => !!values[i]
		let cell = (k: number) => Math.max(0, ...values.map((v) => (v.split('\t')[k] ?? '').length))
		let label = Math.max(0, ...(m?.items ?? []).map((s, i) => (model(i) ? s.length : 0)))
		// +1ch: marks such as ✓ may render wider than one cell.
		return `${label + 1}ch ${m ? picker.effortWidth(m) : 0}ch ${cell(1)}ch auto`
	}
	// A new query reorders the list, so scroll from the top as the TUI
	// does: the rows above the selection stay in view.
	let query: string | undefined
	createEffect(
		() => ({ selected: props.modal?.selected, query: props.modal?.query, items: props.modal?.items }),
		({ selected, query: q }) => {
			// Moving focus runs focus handlers here; they read state untracked.
			if (selected === undefined) { if (box.open) untrack(() => box.close()); return }
			if (!box.open) untrack(() => { box.showModal(); (props.modal?.form && search ? search : list).focus() })
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
		<dialog ref={(e) => (box = e)} class={props.modal?.compact ? 'Picker compact' : 'Picker'} aria-label={props.modal?.title ?? 'Picker'} onCancel={cancel} onClick={outside}>
			<div class="top">
				<div class="title">{props.modal?.title ?? ''}</div>
				<button type="button" class="close" aria-label="Close" onClick={cancel}><Icon name="close" /></button>
			</div>
			<Show when={props.modal?.form}>
				<input ref={(e) => (search = e)} class="input" type="text" aria-label="Search" autocomplete="off"
					aria-activedescendant={props.modal?.items.length ? `modal-item-${props.modal.selected}` : ''}
					placeholder={props.modal?.compact && props.modal.form ? forms.example(props.modal.form, 0, 0).text : undefined}
					value={props.modal?.form?.values[0] ?? ''} onInput={(e) => (props.modal?.compact ? folds.input(e.currentTarget.value) : app.search(e.currentTarget.value))} onFocus={() => find.focus(0)} />
			</Show>
			<Show when={props.modal?.blocks}>{(b) => (
				<>
					<div class={b().invalid ? 'blocks-hint refused' : 'blocks-hint'} role="status">{b().hint}</div>
					<Show when={b().choices} fallback={
						<div class="blocks-help">
							<dl><For each={blocksDialog.help}>{([k, d]) => <div><dt>{k}</dt><dd>{d}</dd></div>}</For></dl>
							<p>{blocksDialog.note}</p>
							<p>Kinds: <For each={blocksDialog.kinds}>{(w, i) => <>{i() ? ', ' : ''}<b>{w[0]}</b>{w.slice(1)}</>}</For></p>
						</div>}>
						{(ids) => <ul class="blocks-ids" aria-label="Matching blocks"><For each={ids().length > 40 ? [...ids().slice(0, 39), `+${ids().length - 39} more`] : ids()}>{(id) => <li>{id}</li>}</For></ul>}
					</Show>
				</>
			)}</Show>
			<Show when={props.modal?.restart}>{(r) => {
				let lines = () => modals.restartLines(r().calls)
				return <div class="details">{lines().head}<For each={lines().calls}>{(c) => <>{'\n'}<Show when={c.href} fallback={c.block}><a href={c.href}>{c.block}</a></Show>{c.rest}</>}</For></div>
			}}</Show>
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
			<ul ref={(e) => (list = e)} hidden={props.modal?.compact} role="listbox" aria-label={props.modal?.restart ? 'Choices' : 'Results'} tabindex={props.modal?.find || !props.modal?.form ? 0 : undefined}
				onFocus={() => find.focus(5)} aria-activedescendant={props.modal?.items.length ? `modal-item-${props.modal.selected}` : ''}>
				<For each={props.modal?.items ?? []}>{(item, i) => (
					<li role="option" id={`modal-item-${i()}`} aria-selected={i() === props.modal?.selected ? 'true' : 'false'}
						class={props.modal?.tree ? 'row model-row' : props.modal?.values ? 'row' : undefined} style={props.modal?.tree ? (props.modal.values?.[i()] ? { '--columns': columns() } : undefined) : props.modal?.values ? { '--label': width() } : undefined}
						onClick={() => { if (!props.modal?.find) app.modalPick(i()) }}>
						<Show when={props.modal?.values} fallback={
						<Show when={props.modal?.find} fallback={marked(item, props.modal?.query)}>
							<a href={props.modal?.find?.results[i()]?.href} tabindex={-1}>{marked(item, props.modal?.query, true)}</a>
						</Show>}>
							<span class="label">{marked(item, props.modal?.query)}</span>
							<Show when={props.modal?.edit?.index === i()} fallback={<Show when={props.modal?.tree} fallback={<span class="value">{marked(props.modal?.values?.[i()] ?? '', props.modal?.query)}</span>}>
								<For each={props.modal?.values?.[i()] ? props.modal.values[i()]!.split('\t') : []}>{(cell, k) => <span class={k() === 0 ? 'effort' : 'value'}>{marked(cell, props.modal?.query)}</span>}</For>
							</Show>}>
								<input ref={(e) => (edit = e)} class="value input" autocomplete="off" aria-label={`${item}: value`}
									type={props.modal?.edit?.form.form.fields[0]?.type === 'secret' ? 'password' : 'text'}
									inputmode={settings.table.find((s) => s.name === props.modal?.settings?.names[i()])?.type.kind === 'integer' ? 'numeric' : undefined}
									value={props.modal?.edit?.form.values[0] ?? ''} onInput={(e) => app.search(e.currentTarget.value, true)} onClick={(e) => e.stopPropagation()} />
							</Show>
							<span class="note popup-note">{props.modal?.notes?.[i()] ?? ''}</span>
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
			<Show when={props.modal?.details}>
				<div class="details">{props.modal?.details?.[props.modal.selected] ?? ''}</div>
			</Show>
			<Show when={props.modal?.error}>
				<div class="refused" role="alert">{props.modal?.error}</div>
			</Show>
			<div class="log" role="status">{props.modal?.hint ?? ''}</div>
		</dialog>
	)
}

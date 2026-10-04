/// <reference lib="dom" />
// The /rebase view (task bzf): a full-height native modal over the
// transcript, its row list the one scroller. Each row: #n, time, kind,
// tokens with a bar scaled to the heaviest row, summary and what it
// carries; keep/drop/edit, shift-click (or Range on a phone) for a run.
// Tapping a row opens its whole text, images and blobs. The footer
// always shows tokens now → after and where the cache rebuilds; only
// Apply sends (rebase.ts decides everything).
import { createEffect, createMemo, createSignal, For, onSettled, Show } from 'solid-js'
import type { RebaseRow } from '../../common/rebase-rows.ts'
import { rebaseView, type Action, type Part, type RebaseState } from '../rebase.ts'
import { view } from '../view.ts'
import { Icon } from './Icon.tsx'

const labels: Action[] = ['keep', 'drop', 'edit']

// A text blob's first part, or its image; fetched when its row opens.
function Blob(props: { session: string; id: string; size: string }) {
	let url = () => view.blobUrl(props.session, props.id)
	let [shown, setShown] = createSignal<{ image?: true; text?: string; more?: boolean; error?: string }>({})
	onSettled(() => {
		let gone = false
		fetch(url()).then(async (res) => {
			if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
			if (res.headers.get('content-type')?.startsWith('image/')) return !gone && setShown({ image: true })
			let text = await res.text()
			if (!gone) setShown({ text: text.slice(0, 4000), more: text.length > 4000 })
		}).catch((e: unknown) => !gone && setShown({ error: `blob ${props.id}: ${e instanceof Error ? e.message : String(e)}` }))
		return () => { gone = true }
	})
	return (
		<div class="part blob">
			<div class="label"><a href={url()} target="_blank" rel="noopener">blob {props.id}</a>{props.size ? ` · ${props.size}` : ''}</div>
			<Show when={shown().image}><a href={url()} target="_blank" rel="noopener"><img src={url()} alt={`blob ${props.id}`} /></a></Show>
			<Show when={shown().text !== undefined}><pre>{shown().text}{shown().more ? '\n…' : ''}</pre></Show>
			<Show when={shown().error}><pre class="error">{shown().error}</pre></Show>
		</div>
	)
}

function Detail(props: { st: RebaseState; row: RebaseRow }) {
	let parts = createMemo(() => rebaseView.parts(props.st, props.row))
	let first = () => props.st.snapshot.rows[0]?.n === props.row.n
	return (
		<div class="detail">
			<For each={parts()}>{(p: Part) => (
				p.kind === 'text' ? <div class="part"><Show when={p.label}><div class="label">{p.label}</div></Show><pre>{p.text}</pre></div>
				: p.kind === 'image' ? <div class="part"><div class="label">image{p.bytes ? ` · ${Math.round(p.bytes / 100) / 10} kB` : ''}</div><a href={view.blobUrl(props.st.sessionId, p.blob)} target="_blank" rel="noopener"><img src={view.blobUrl(props.st.sessionId, p.blob)} alt={`image ${p.blob}`} /></a></div>
				: <Blob session={props.st.sessionId} id={p.id} size={p.size} />
			)}</For>
			<Show when={!parts().length}><div class="part label">(no text)</div></Show>
			<Show when={!first()}><button type="button" class="before" onClick={() => rebaseView.dropBefore(props.row.n)}>Drop everything before #{props.row.n}</button></Show>
		</div>
	)
}

function Row(props: { st: RebaseState; row: RebaseRow; gone: Set<number>; max: number }) {
	let n = props.row.n
	let state = () => rebaseView.shown(props.st, props.row, props.gone)
	let open = () => !!props.st.open[n]
	let pct = () => (props.max ? Math.round((props.row.tokens / props.max) * 100) : 0)
	let pressed = (a: Action) => (a === 'drop' ? state() === 'drop' || state() === 'group' : state() === a)
	// A row whose time carries a date starts a day: the date heads it.
	let date = props.row.time.length > 5 ? props.row.time.slice(0, -6) : undefined
	return (
		<>
		<Show when={date}><li class="date" aria-hidden="true">{date}</li></Show>
		<li class={['row', state(), { open: open() }]}>
			<button type="button" class="info" aria-expanded={open() ? 'true' : 'false'} onClick={() => rebaseView.toggle(n)}>
				<span class="n">#{n}</span>
				<span class="time" title={props.row.time}>{props.row.time.slice(-5)}</span>
				<span class="kind">{props.row.kind}</span>
				<span class="tokens">{rebaseView.kilo(props.row.tokens)}</span>
				<span class="bar" aria-hidden="true"><span class={`heat-${pct()}`} style={{ width: `${Math.max(pct(), props.row.tokens ? 1 : 0)}%` }} /></span>
				<span class="summary">{props.row.summary || '(empty)'}</span>
				<Show when={props.row.carries.length || state() === 'group'}>
					<span class="carries">{[...props.row.carries, ...(state() === 'group' ? ['dropped with its group'] : [])].join(' · ')}</span>
				</Show>
			</button>
			<div class="acts" role="group" aria-label={`Action for #${n}`}>
				<For each={labels}>{(a) => (
					<button type="button" class={a} aria-pressed={pressed(a) ? 'true' : 'false'} disabled={a === 'edit' && !props.row.editable}
						onMouseDown={(e) => e.shiftKey && e.preventDefault()} onClick={(e) => rebaseView.act(n, a, e.shiftKey)}>{a}</button>
				)}</For>
			</div>
			<Show when={state() === 'edit'}>
				<textarea class="edit" aria-label={`New text for #${n}`} rows={Math.min(12, Math.max(3, (props.st.texts[n] ?? '').split('\n').length))}
					value={props.st.texts[n] ?? ''} onInput={(e) => rebaseView.edit(n, e.currentTarget.value)} />
			</Show>
			<Show when={open()}><Detail st={props.st} row={props.row} /></Show>
		</li>
		</>
	)
}

export function Rebase() {
	let box!: HTMLDialogElement
	let [st, setSt] = createSignal(rebaseView.state)
	onSettled(() => {
		rebaseView.changed = () => setSt(rebaseView.state)
		return () => { rebaseView.changed = () => {} }
	})
	createEffect(() => !!st(), (on) => {
		if (on && !box.open) box.showModal()
		else if (!on && box.open) box.close()
	})
	let gone = createMemo(() => { let s = st(); return s ? rebaseView.dropped(s) : new Set<number>() })
	let max = createMemo(() => Math.max(0, ...(st()?.snapshot.rows.map((r) => r.tokens) ?? [])))
	let plan = createMemo(() => { let s = st(); return s && rebaseView.plan(s) }, { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) })
	let sums = createMemo(() => { let s = st(), p = plan(); return s && p ? rebaseView.totals(s) : undefined })
	let dirty = () => !!plan() && (plan()!.drop.length > 0 || plan()!.edit.length > 0)
	let cancel = (e: Event) => { e.preventDefault(); if (!st()?.sending) rebaseView.cancel() }
	return (
		<dialog ref={(e) => (box = e)} class="Rebase diff" aria-label="Rebase history" onCancel={cancel}>
			<Show when={st()}>{(s) => (
				<>
					<div class="top">
						<div class="title">Rebase <span class="id">{s().sessionId}</span> · {s().snapshot.rows.length} rows</div>
						<button type="button" class="close" aria-label="Cancel rebase" onClick={cancel}><Icon name="close" /></button>
					</div>
					<div class="quick">
						<label>Drop outputs over <input type="number" inputmode="numeric" min="0" step="1000" value={s().threshold} onInput={(e) => rebaseView.threshold(e.currentTarget.valueAsNumber)} /> tokens</label>
						<button type="button" onClick={() => rebaseView.dropOver()}>Drop</button>
						<button type="button" class="range" aria-pressed={s().range ? 'true' : 'false'} onClick={() => rebaseView.range(!s().range)}>{s().range ? (s().anchor === undefined ? 'Range: first row' : 'Range: last row') : 'Range'}</button>
						<span class="hint">Shift-click acts on a run of rows</span>
					</div>
					<ul class="rows" aria-label="History rows">
						<For each={s().snapshot.rows}>{(row) => <Row st={s()} row={row} gone={gone()} max={max()} />}</For>
					</ul>
					<div class="foot">
						<Show when={s().error}>
							<div class="error" role="alert"><pre>{s().error}</pre><Show when={s().error?.startsWith('Rebase is stale')}><button type="button" onClick={() => rebaseView.rebuild()}><Icon name="reload" />Reload rows</button></Show></div>
						</Show>
						<div class="sums" role="status">
							<span>{rebaseView.kilo(sums()?.tokens ?? 0)} → <b>{rebaseView.kilo(sums()?.after ?? 0)}</b> tokens</span>
							<span>{sums()?.cacheFrom === undefined ? 'cache kept' : `cache rebuilds from #${sums()!.cacheFrom}`}</span>
						</div>
						<div class="buttons">
							<button type="button" onClick={cancel} disabled={!!s().sending}><Icon name="close" />Cancel</button>
							<button type="button" class="apply" disabled={!dirty() || !!s().sending} onClick={() => rebaseView.apply()}><Icon name="check" />{s().sending ? 'Applying…' : 'Apply'}</button>
						</div>
					</div>
				</>
			)}</Show>
		</dialog>
	)
}

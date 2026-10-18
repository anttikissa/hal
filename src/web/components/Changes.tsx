/// <reference lib="dom" />
// The changes window over the chat (task ahr): a session's changed files
// beside the selected file's diff; one pane at a time on narrow screens.
// changes.ts holds the address and data; links for the shown tab open
// it in place.
import { createEffect, createMemo, createSignal, For, onSettled, Show, untrack } from 'solid-js'
import { changesView, type DiffLine, type FileDetail, type List, type Loaded, type Route } from '../changes.ts'
import { app } from '../app.ts'
import { router } from '../router.ts'
import { Icon } from './Icon.tsx'

const id = (block: string) => block.replace(/^#/, '')

function Counts(props: { text: string }) {
	let m = () => /^\+(\d+) -(\d+)$/.exec(props.text)
	return <Show when={m()} fallback={<span class="quiet">{props.text}</span>}>{(n) => <span class="counts"><span class="add">+{n()[1]}</span> <span class="del">-{n()[2]}</span></span>}</Show>
}

function Diff(props: { text: string }) {
	let rows = createMemo(() => changesView.lines(props.text))
	return (
		<div class="lines">
			<For each={rows()}>{(l: DiffLine) => (
				<div class={['line', l.kind]}>
					<span class="no">{l.old ?? ''}</span><span class="no">{l.new ?? ''}</span>
					<span class="sign">{l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ''}</span><span class="text">{l.text}</span>
				</div>
			)}</For>
		</div>
	)
}

export function Changes(props: { shown?: string }) {
	let box!: HTMLDialogElement, pane: HTMLElement | undefined
	let [route, setRoute] = createSignal<Route | undefined>(undefined, { equals: false })
	let [list, setList] = createSignal<Loaded<List>>()
	let [file, setFile] = createSignal<Loaded<FileDetail>>()
	let [wide, setWide] = createSignal(true)
	let open = createMemo(() => !!route() && route()!.id === props.shown)
	let session = createMemo(() => (open() ? route()!.id : undefined))
	let files = () => list()?.data?.files ?? []
	// Wide screens always show a file: the first when none is named.
	let selected = createMemo(() => route()?.path ?? (wide() ? files()[0]?.path : undefined))
	onSettled(() => {
		changesView.changed = () => setRoute(changesView.state.route)
		changesView.sync()
		let media = matchMedia('(min-width: 50rem)')
		let onMedia = () => setWide(media.matches)
		onMedia()
		media.addEventListener('change', onMedia)
		let onPop = () => changesView.sync()
		addEventListener('popstate', onPop)
		// A plain click on a link for the shown tab stays in the page.
		let onClick = (e: MouseEvent) => {
			if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
			let a = e.target instanceof Element ? e.target.closest('a') : null
			if (!a || a.target === '_blank') return
			let url = new URL(a.href, location.href)
			if (url.origin !== location.origin || router.parse(url.href) !== props.shown) return
			let r = router.changes(url.href)
			if (r) {
				e.preventDefault()
				for (let d of document.querySelectorAll('dialog[open]')) if (d !== box) (d as HTMLDialogElement).close()
				if (open()) changesView.select(r.path)
				else changesView.open(r.id, r.path)
			} else if (open()) {
				e.preventDefault()
				changesView.leave(url.pathname + url.search + url.hash)
				app.aim()
			}
		}
		document.addEventListener('click', onClick, true)
		return () => {
			media.removeEventListener('change', onMedia)
			removeEventListener('popstate', onPop)
			document.removeEventListener('click', onClick, true)
		}
	})
	createEffect(open, (o) => untrack(() => {
		if (o && !box.open) box.showModal()
		if (!o && box.open) box.close()
	}))
	// Fresh data each time the window opens: these are request-time views.
	createEffect(session, (s) => {
		setList(undefined)
		if (!s) return
		void changesView.list(s).then((l) => { if (session() === s) setList(l) })
	})
	createEffect(() => [session(), selected()] as const, ([s, path]) => {
		setFile(undefined)
		if (!s || path === undefined) return
		void changesView.file(s, path).then((f) => {
			if (session() !== s || selected() !== path) return
			setFile(f)
			pane?.scrollTo({ top: 0 })
		})
	})
	let title = () => {
		let l = list()?.data
		return `Changes · ${route()?.id ?? ''}${l?.name ? `: ${l.name}` : ''}`
	}
	let count = () => (list()?.data ? `${files().length} file${files().length === 1 ? '' : 's'}` : '')
	// Up and Down (or k and j) move between files.
	let onKey = (e: KeyboardEvent) => {
		e.stopPropagation()
		if (e.target instanceof HTMLInputElement || e.altKey || e.ctrlKey || e.metaKey) return
		let step = e.key === 'ArrowDown' || e.key === 'j' ? 1 : e.key === 'ArrowUp' || e.key === 'k' ? -1 : 0
		if (!step || !files().length) return
		e.preventDefault()
		let at = files().findIndex((f) => f.path === selected())
		let next = files()[Math.max(0, Math.min(files().length - 1, at + step))]!
		changesView.select(next.path)
		box.querySelector(`.files a[data-path="${CSS.escape(next.path)}"]`)?.scrollIntoView({ block: 'nearest' })
	}
	let cancel = (e: Event) => { e.preventDefault(); changesView.close() }
	let outside = (e: MouseEvent) => {
		let r = box.getBoundingClientRect()
		if (e.target === box && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) changesView.close()
	}
	return (
		<dialog ref={(e) => (box = e)} class={['Changes', 'plain', 'diff', { picked: selected() !== undefined }]} aria-label="File changes" onCancel={cancel} onClick={outside} onKeyDown={onKey}>
			<div class="top">
				<Show when={!wide() && selected() !== undefined}>
					<button type="button" class="back" onClick={() => changesView.select(undefined)}>← Files</button>
				</Show>
				<strong class="title">{title()}</strong>
				<span class="quiet">{count()}</span>
				<button type="button" class="close" aria-label="Close file changes" onClick={() => changesView.close()}><Icon name="close" /></button>
			</div>
			<Show when={list()?.error}>{(err) => <pre class="refused" role="alert">{err()}</pre>}</Show>
			<div class="body">
				<nav class="files" aria-label="Changed files">
					<Show when={list()?.data} fallback={<p class="quiet">{list()?.error ? '' : 'Loading…'}</p>}>
						<Show when={files().length} fallback={<p class="quiet">No file changes since the last /changes clear.</p>}>
							<ul>
								<For each={files()}>{(f) => (
									<li aria-current={f.path === selected() ? 'true' : undefined}>
										<a href={router.changesHref(list()!.data!.id, f.path)} data-path={f.path} title={f.path}>
											<span class="path">{f.shown}</span>
											<span class="meta"><Counts text={f.counts} /> <span class="quiet">{f.time}</span></span>
										</a>
									</li>
								)}</For>
							</ul>
						</Show>
					</Show>
				</nav>
				<section ref={(e) => (pane = e)} class="file" aria-label="Selected file">
					<Show when={file()?.error}>{(err) => <pre class="refused" role="alert">{err()}</pre>}</Show>
					<Show when={file()?.data} fallback={<p class="quiet">{selected() === undefined || file()?.error ? '' : 'Loading…'}</p>}>{(f) => (
						<>
							<header>
								<h2>{f().shown}</h2>
								<p><Counts text={f().counts} /> <span class="quiet">{f().time}</span><Show when={f().commit}>{(c) => <span class="quiet"> · committed in {c()}</span>}</Show></p>
								<Show when={f().calls.length}>
									<p class="links"><span class="quiet">Calls </span><For each={f().calls}>{(c) => <a href={c.href}>{id(c.block)}</a>}</For></p>
								</Show>
								<Show when={f().others.length}>
									<p class="links"><span class="quiet">Also changed by </span><For each={f().others}>{(o) => <a href={router.changesHref(o.id, f().path)}>{o.id}{o.name ? `: ${o.name}` : ''}</a>}</For></p>
								</Show>
							</header>
							<Diff text={f().diff} />
							<Show when={f().steps.length > 1}>
								<h3>Steps per call</h3>
								<For each={f().steps}>{(s) => (
									<details>
										<summary>{s.block ?? 'Call'} <span class="quiet">· {s.time}</span></summary>
										<Diff text={s.diff} />
									</details>
								)}</For>
							</Show>
						</>
					)}</Show>
				</section>
			</div>
		</dialog>
	)
}

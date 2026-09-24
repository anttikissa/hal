import { createEffect, createMemo, createSignal, For, onSettled, Show } from 'solid-js'
import type { SharedSessionInfo } from '../../common/ipc.ts'
import { appActions } from '../utils/app-actions.ts'
import { sessionActivity } from '../utils/session-activity.ts'
import { router } from '../router.ts'

type SessionTabsProps = {
	sessions: SharedSessionInfo[]
	selected: string
	status: string
	working?: Record<string, boolean>
	summarizing?: Record<string, boolean>
	onSelect: (sessionId: string) => void
	onCommand: (command: Record<string, unknown>) => void
}

function ActivityMarkers(props: { description: ReturnType<typeof sessionActivity.describe> }) {
	return <span class="SessionTabs-activity" aria-hidden="true">
		<For each={props.description.markers}>
			{(marker) => <span class={['SessionTabs-marker', marker.tone, marker.animated && 'animated']}>{marker.glyph}</span>}
		</For>
	</span>
}

// The strip ranks useful shortcuts; the menu always exposes every session.
export function SessionTabs(props: SessionTabsProps) {
	const [menuOpen, setMenuOpen] = createSignal(false)
	const [refreshError, setRefreshError] = createSignal(false)
	const [query, setQuery] = createSignal('')
	const [visibleCount, setVisibleCount] = createSignal(1)
	const shown = createMemo(() => sessionActivity.ordered(props.sessions, props.selected, props.working ?? {}, props.summarizing ?? {}).slice(0, visibleCount()))
	let rail: HTMLElement
	let dialog: HTMLDialogElement | undefined

	onSettled(() => {
		const observer = new ResizeObserver(() => {
			const width = rail.querySelector('a')?.getBoundingClientRect().width ?? 56
			const gap = parseFloat(getComputedStyle(rail).gap) || 0
			const prefix = rail.querySelector('.SessionTabs-prefix')?.getBoundingClientRect().width ?? 0
			setVisibleCount(sessionActivity.capacity(rail.clientWidth - prefix - gap, width, gap))
		})
		observer.observe(rail)
		return () => observer.disconnect()
	})

	createEffect(() => menuOpen(), (open) => {
		if (!dialog) return
		if (!open) {
			dialog.close()
			return
		}
		dialog.showModal()
		const current = dialog.querySelector<HTMLButtonElement>('[aria-current="page"]')
		current?.focus({ preventScroll: true })
		current?.scrollIntoView({ block: 'center' })
	})

	function refresh(): void {
		setRefreshError(!appActions.refresh())
	}

	function select(sessionId: string): void {
		setMenuOpen(false)
		props.onCommand({ type: 'focus', sessionId })
		props.onSelect(sessionId)
	}

	function newTab(): void {
		setMenuOpen(false)
		props.onCommand({ type: 'open' })
	}

	function closeTab(event: MouseEvent, sessionId: string): void {
		event.stopPropagation()
		if (props.sessions.length > 1) props.onCommand({ type: 'close', sessionId })
	}

	return <header class="SessionTabs">
		<nav class="SessionTabs-rail" ref={(element) => { rail = element }} aria-label="Session shortcuts">
			<span class="SessionTabs-prefix" aria-hidden="true">Tabs:</span>
			<For each={shown()} keyed={(session) => session.id}>
				{(item) => {
					const session = () => item()
					const activity = () => sessionActivity.describe(session(), !!props.working?.[session().id], !!props.summarizing?.[session().id])
					const number = () => session().tab ?? props.sessions.indexOf(session()) + 1
					return <a
						href={router.format(session().id)}
						class={{ selected: session().id === props.selected }}
						onClick={(event) => {
							if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
							event.preventDefault()
							select(session().id)
						}}
						aria-current={session().id === props.selected ? 'page' : undefined}
						aria-label={`Tab ${number()}, ${session().name || session().id}, ${activity().label}`}
						title={`${number()} ${session().name || session().id} · ${activity().label}`}
					>
						<span class="SessionTabs-number">{number()}</span>
						<ActivityMarkers description={activity()} />
					</a>
				}}
			</For>
		</nav>
		<button
			class="SessionTabs-menu"
			onClick={() => { setQuery(''); setMenuOpen(!menuOpen()) }}
			aria-label={`All ${props.sessions.length} sessions and actions`}
			aria-expanded={menuOpen() ? 'true' : 'false'}
			aria-haspopup="dialog"
			aria-controls="SessionTabs-panel"
		>☰</button>
		<span class="SessionTabs-title" title={props.status}>{props.status}</span>
		<button class="SessionTabs-new" onClick={newTab} aria-label="New tab">+</button>
		{/* Native modal supplies focus containment, Escape and focus restoration. */}
		<dialog id="SessionTabs-panel" ref={(element) => { dialog = element }} class="SessionTabs-sheet" onCancel={() => setMenuOpen(false)} onClick={(event) => {
			if (event.target === event.currentTarget) setMenuOpen(false)
		}} aria-label="Sessions and actions">
			<div class="SessionTabs-panel">
				<header class="SessionTabs-panelHeading">
					<strong>Sessions ({props.sessions.length})</strong>
					<button onClick={() => setMenuOpen(false)} aria-label="Close menu">×</button>
				</header>
				<input class="SessionTabs-search" type="search" aria-label="Find session" placeholder="Find number, name or path" value={query()} onInput={(event) => setQuery(event.currentTarget.value)} />
				<nav class="SessionTabs-list" aria-label="Open sessions">
					<For each={props.sessions}>
						{(session, index) => {
							const activity = () => sessionActivity.describe(session, !!props.working?.[session.id], !!props.summarizing?.[session.id])
							const number = () => session.tab ?? index() + 1
							// Model ids are `provider/model`; the provider prefix is noise here.
							const model = () => session.model?.split('/').at(-1)
							return <div class={{ selected: session.id === props.selected }} hidden={!sessionActivity.matches(session, query(), number())}>
								<a class="SessionTabs-open" href={router.format(session.id)} onClick={(event) => {
									if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
									event.preventDefault()
									select(session.id)
								}} aria-current={session.id === props.selected ? 'page' : undefined} aria-label={`Tab ${number()}, ${session.id}: ${session.name || session.id}, ${activity().label}`}>
									<span class="SessionTabs-number">{number()}</span>
									<ActivityMarkers description={activity()} />
									{session.name || session.id}
									<small>{session.id}{model() ? ` · ${model()}` : ''}{session.id === props.selected ? ' · Current' : ''}</small>
									<span class="SessionTabs-cwd" title={session.cwd}>{session.cwd}</span>
								</a>
								<Show when={props.sessions.length > 1}>
									<button class="SessionTabs-close" onClick={(event) => closeTab(event, session.id)} aria-label={`Close ${session.name || session.id}`}>×</button>
								</Show>
							</div>
						}}
					</For>
				</nav>
				<footer class="SessionTabs-actions" aria-label="Actions">
					<strong>Actions</strong>
					<div>
						<button class="SessionTabs-new" onClick={newTab}>+ New tab</button>
						<Show when={appActions.isInstalled()}><button onClick={refresh}>Refresh app</button></Show>
					</div>
					<Show when={refreshError()}><p role="alert">Refresh blocked: your draft could not be saved. Keep this app open and copy your draft before reloading.</p></Show>
				</footer>
			</div>
		</dialog>
	</header>
}

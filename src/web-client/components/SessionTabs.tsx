import { createEffect, createSignal, For, Show } from 'solid-js'
import type { SharedSessionInfo } from '../../common/ipc.ts'
import { appActions } from '../utils/app-actions.ts'
import { sessionActivity } from '../utils/session-activity.ts'

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

// Small sets keep direct tab access. Larger sets show the current session title
// and move navigation into the selector on both phone and desktop.
export function SessionTabs(props: SessionTabsProps) {
	const [menuOpen, setMenuOpen] = createSignal(false)
	const [refreshError, setRefreshError] = createSignal(false)
	let dialog: HTMLDialogElement | undefined

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

	return <header class={['SessionTabs', props.sessions.length > 4 && 'compact']}>
		<button
			class="SessionTabs-menu"
			onClick={() => setMenuOpen(!menuOpen())}
			aria-label="Sessions and actions"
			aria-expanded={menuOpen() ? 'true' : 'false'}
			aria-haspopup="dialog"
			aria-controls="SessionTabs-panel"
		>☰</button>
		<span class="SessionTabs-title" title={props.status}>{props.status}</span>
		<nav class="SessionTabs-rail" aria-label="Open sessions">
			<For each={props.sessions}>
				{(session, index) => {
					const activity = () => sessionActivity.describe(session, !!props.working?.[session.id], !!props.summarizing?.[session.id])
					const number = () => session.tab ?? index() + 1
					return <button
						class={{ selected: session.id === props.selected }}
						onClick={() => select(session.id)}
						aria-current={session.id === props.selected ? 'page' : undefined}
						aria-label={`Tab ${number()}, ${session.name || session.id}, ${activity().label}`}
						title={`${number()} ${session.name || session.id} · ${activity().label}`}
					>
						<span class="SessionTabs-number">{number()}</span>
						<ActivityMarkers description={activity()} />
						<span class="SessionTabs-railName">{sessionActivity.shortName(session)}</span>
					</button>
				}}
			</For>
		</nav>
		<div class="SessionTabs-row">
			<For each={props.sessions}>
				{(session) => {
					const activity = () => sessionActivity.describe(session, !!props.working?.[session.id], !!props.summarizing?.[session.id])
					return <button class={{ selected: session.id === props.selected }} onClick={() => select(session.id)} aria-label={`${session.tab ?? ''} ${session.name || session.id}, ${activity().label}`}>
						<ActivityMarkers description={activity()} />
						{session.tab ?? ''} {session.name || session.id}
						<Show when={props.sessions.length > 1}>
							<span class="SessionTabs-close" onClick={(event) => closeTab(event, session.id)}>×</span>
						</Show>
					</button>
				}}
			</For>
			<button class="SessionTabs-new" onClick={newTab} aria-label="New tab">+</button>
		</div>
		{/* Native modal supplies focus containment, Escape and focus restoration. */}
		<dialog id="SessionTabs-panel" ref={(element) => { dialog = element }} class="SessionTabs-sheet" onCancel={() => setMenuOpen(false)} onClick={(event) => {
			if (event.target === event.currentTarget) setMenuOpen(false)
		}} aria-label="Sessions and actions">
			<div class="SessionTabs-panel">
				<header class="SessionTabs-panelHeading">
					<strong>Sessions</strong>
					<button onClick={() => setMenuOpen(false)} aria-label="Close menu">×</button>
				</header>
				<nav class="SessionTabs-list" aria-label="Open sessions">
					<For each={props.sessions}>
						{(session) => {
							const activity = () => sessionActivity.describe(session, !!props.working?.[session.id], !!props.summarizing?.[session.id])
							return <div class={{ selected: session.id === props.selected }}>
								<button class="SessionTabs-open" onClick={() => select(session.id)} aria-current={session.id === props.selected ? 'page' : undefined} aria-label={`${session.id}: ${session.name || session.id}, ${activity().label}`}>
									<ActivityMarkers description={activity()} />
									{session.name || session.id}
									<small>{session.id}{session.id === props.selected ? ' · Current' : ''}</small>
								</button>
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

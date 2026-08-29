import { createSignal, For, Show } from 'solid-js'
import type { SharedSessionInfo } from '../../common/ipc.ts'
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

// Desktop shows full tabs. On a phone the same space becomes a wrapping rail:
// every session remains visible and directly selectable, while the selected tab
// expands to show its name. The menu remains for close and new-tab actions.
export function SessionTabs(props: SessionTabsProps) {
	const [menuOpen, setMenuOpen] = createSignal(false)

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

	function closeMenuOnEscape(event: KeyboardEvent): void {
		if (event.key === 'Escape') setMenuOpen(false)
	}

	return <header class="SessionTabs">
		<button
			class="SessionTabs-menu"
			onClick={() => setMenuOpen(!menuOpen())}
			aria-label="Manage sessions"
			aria-expanded={menuOpen() ? 'true' : 'false'}
			aria-haspopup="dialog"
			aria-controls="SessionTabs-panel"
		>☰</button>
		<span class="SessionTabs-title">{props.status}</span>
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
		<Show when={menuOpen()}>
			{/* Backdrop click dismisses; the inner list stops propagation. */}
			<div class="SessionTabs-sheet" onClick={() => setMenuOpen(false)} onKeyDown={closeMenuOnEscape}>
				<div id="SessionTabs-panel" class="SessionTabs-panel" role="dialog" aria-modal="true" aria-label="Manage sessions" onClick={(event) => event.stopPropagation()}>
					<For each={props.sessions}>
						{(session) => {
							const activity = () => sessionActivity.describe(session, !!props.working?.[session.id], !!props.summarizing?.[session.id])
							return <div class={{ selected: session.id === props.selected }}>
								<button class="SessionTabs-open" onClick={() => select(session.id)} aria-label={`${session.tab ?? ''} ${session.name || session.id}, ${activity().label}`}>
									<ActivityMarkers description={activity()} />
									{session.tab ?? ''} {session.name || session.id}
								</button>
								<Show when={props.sessions.length > 1}>
									<button class="SessionTabs-close" onClick={(event) => closeTab(event, session.id)} aria-label={`Close ${session.name || session.id}`}>×</button>
								</Show>
							</div>
						}}
					</For>
					<button class="SessionTabs-new" onClick={newTab}>+ New tab</button>
				</div>
			</div>
		</Show>
	</header>
}

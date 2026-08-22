import { createSignal, For, Show } from 'solid-js'
import type { SharedSessionInfo } from '../../common/ipc.ts'

type SessionTabsProps = {
	sessions: SharedSessionInfo[]
	selected: string
	working?: Record<string, boolean>
	onSelect: (sessionId: string) => void
	onCommand: (command: Record<string, unknown>) => void
}

// All tabs stay reachable without sideways scrolling: desktop wraps them into
// rows; phone collapses the row into a ☰ sheet where every tab is listed.
export function SessionTabs(props: SessionTabsProps) {
	const [menuOpen, setMenuOpen] = createSignal(false)

	function select(sessionId: string): void {
		setMenuOpen(false)
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
	<button class="SessionTabs-menu" onClick={() => setMenuOpen(!menuOpen())} aria-label="Sessions">☰</button>
		<span class="SessionTabs-title">{props.sessions.find((session) => session.id === props.selected)?.name ?? ''}</span>
		<div class="SessionTabs-row">
			<For each={props.sessions}>
				{(session) => <button class={{ selected: session.id === props.selected }} onClick={() => select(session.id)}>
					<Show when={props.working?.[session.id]}><span class="SessionTabs-dot" /></Show>
					<Show when={session.attention === 'new'}><span class="SessionTabs-bell">🔔</span></Show>
					{session.tab ?? ''} {session.name || session.id}
					<Show when={props.sessions.length > 1}>
						<span class="SessionTabs-close" onClick={(event) => closeTab(event, session.id)}>×</span>
					</Show>
				</button>}
			</For>
			<button class="SessionTabs-new" onClick={newTab} aria-label="New tab">+</button>
		</div>
		<Show when={menuOpen()}>
			{/* Backdrop click dismisses; the inner list stops propagation. */}
			<div class="SessionTabs-sheet" onClick={() => setMenuOpen(false)}>
				<div class="SessionTabs-panel" onClick={(event) => event.stopPropagation()}>
				<For each={props.sessions}>
					{(session) => <div class={{ selected: session.id === props.selected }}>
						<button class="SessionTabs-open" onClick={() => select(session.id)}>
							<Show when={props.working?.[session.id]}><span class="SessionTabs-dot" /></Show>
							<Show when={session.attention === 'new'}><span class="SessionTabs-bell">🔔</span></Show>
							{session.tab ?? ''} {session.name || session.id}
						</button>
						<Show when={props.sessions.length > 1}>
							<button class="SessionTabs-close" onClick={(event) => closeTab(event, session.id)}>×</button>
						</Show>
					</div>}
				</For>
				<button class="SessionTabs-new" onClick={newTab}>+ New tab</button>
				</div>
			</div>
		</Show>
	</header>
}

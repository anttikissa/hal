import { For } from 'solid-js'
import type { SharedSessionInfo } from '../../common/ipc.ts'

type SessionTabsProps = {
	sessions: SharedSessionInfo[]
	selected: string
	onSelect: (sessionId: string) => void
}

export function SessionTabs(props: SessionTabsProps) {
	return <header class="SessionTabs">
		<For each={props.sessions}>
			{(session) => <button class={{ selected: session.id === props.selected }} onClick={() => props.onSelect(session.id)}>
				{session.tab ?? ''} {session.name || session.id}
			</button>}
		</For>
	</header>
}

// Facts already pushed with the transcript's Stats, never polled.
import { For } from 'solid-js'
import { view, type ViewState } from '../view.ts'

export function StatusRow(props: { view: ViewState }) {
	return (
		<div class="StatusRow status" aria-label="Session status">
			<For each={view.status(props.view)}>
				{(group, index) => <span class="group">
					{index() > 0 && <span class="separator" aria-hidden="true"> · </span>}
					<For each={group.parts}>{(part) => <span class={part.heat ? `status-${part.heat}` : ''}>{part.text}</span>}</For>
				</span>}
			</For>
		</div>
	)
}

// Facts already pushed with the transcript's Stats, never polled.
import { For } from 'solid-js'
import { view, type ViewState } from '../view.ts'

export function StatusRow(props: { view: ViewState }) {
	return (
		<div class="StatusRow status" aria-label="Session status">
			<For each={view.status(props.view)}>
				{(group) => <span class={group.path ? 'group path' : 'group'} dir={group.path ? 'rtl' : undefined}>
					<span dir="ltr"><For each={group.parts}>{(part) => <span class={part.heat ? `status-${part.heat}` : ''}>{part.text}</span>}</For></span>
				</span>}
			</For>
		</div>
	)
}

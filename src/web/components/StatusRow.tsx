// Facts already pushed with the transcript's Stats, never polled.
import { For } from 'solid-js'
import { view, type StatusGroup, type ViewState } from '../view.ts'

function Parts(props: { group: StatusGroup }) {
	return <span dir="ltr"><For each={props.group.parts}>{(part) => <span class={part.heat ? `status-${part.heat}` : ''}>{part.text}</span>}</For></span>
}

export function StatusRow(props: { view: ViewState }) {
	return (
		<div class="StatusRow status" aria-label="Session status">
			<For each={view.status(props.view)}>
				{(group) => <span class={group.path ? 'group path' : 'group'} dir={group.path ? 'rtl' : undefined}>
					{group.href ? <a href={group.href}><Parts group={group} /></a> : <Parts group={group} />}
				</span>}
			</For>
		</div>
	)
}

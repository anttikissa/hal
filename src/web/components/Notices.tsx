/// <reference lib="dom" />
// The notice stack (task qm, common/notices.ts) at the bottom right,
// over the transcript's foot: square cards behind a bar in the tab's
// project color on a dim tint of it (else the kind's color), newest lowest; a card for a session is a link that shows its
// tab. Beyond three the oldest fold into one '+N more' line.

import { For, Show } from 'solid-js'
import { notices, type Notice } from '../../common/notices.ts'
import { router } from '../router.ts'
import { tabs } from '../tabs.ts'

function click(e: MouseEvent, n: Notice): void {
	if (!n.session || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
	e.preventDefault()
	tabs.show(n.session, false)
	notices.remove(n.key)
}

export function Notices(props: { entries: Notice[] }) {
	let folded = () => notices.fold(props.entries)
	return (
		<div class="Notices" role="status" aria-live="polite">
			<div class="stack">
				<Show when={folded().more}>
					<div class="more notice">{notices.moreText(folded().more!)}</div>
				</Show>
				<For each={folded().shown}>
					{(n) => (
						<a class={['card', 'notice', n.kind, ...(n.color === undefined ? [] : ['project', 'project-tint', 'tinted'])]} style={n.color === undefined ? undefined : { '--bar': `var(--p${n.color})`, '--tint': `var(--p${n.color}-bg)` }} href={n.session ? router.format(n.session) : undefined} onClick={(e) => click(e, n)}>
							<strong>{n.title}</strong>
							<span class="line">{n.line}</span>
						</a>
					)}
				</For>
			</div>
		</div>
	)
}

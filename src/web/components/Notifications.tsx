/// <reference lib="dom" />
// Push notifications for this device, the registered devices and the
// history of past notices and pushes (task py).
import { createEffect, For, Show } from 'solid-js'
import { connection } from '../../common/connection.ts'
import { notices } from '../../common/notices.ts'
import { transcript } from '../../common/transcript.ts'
import { router } from '../router.ts'
import { tabs } from '../tabs.ts'
import { push } from '../push.ts'
import { Icon } from './Icon.tsx'

const said = {
	unsupported: 'Not available here. On iPhone, Hal must be opened from its Home Screen icon.',
	blocked: 'Blocked. Allow notifications for Hal in iOS Settings → Notifications.',
	on: 'On for this device. Hal notifies when a turn ends while no screen shows that tab.',
	off: 'Off for this device.',
}

export function Notifications(props: { open: boolean; onClose: () => void }) {
	let dialog!: HTMLDialogElement
	createEffect(() => props.open, (o) => {
		if (o && !dialog.open) { dialog.showModal(); connection.send({ type: 'push', action: 'list' }) }
		if (!o && dialog.open) dialog.close()
		push.watchHistory(o)
	})
	let fail = (e: any) => alert(`Notifications: ${e?.message ?? e}`)
	return (
		<dialog ref={(e) => (dialog = e)} class="Notifications sheet" aria-label="Notifications" onClose={props.onClose} onClick={(e) => e.target === e.currentTarget && props.onClose()}>
			<h2>Notifications</h2>
			<p role="status">{said[push.status()]}</p>
			<Show when={push.problem()}>{(p) => <p>Reason: {p()}.</p>}</Show>
			<Show when={push.status() === 'off'}>
				<button type="button" class="new" onClick={() => void push.enable().catch(fail)}><Icon name="bell" />Turn on</button>
			</Show>
			<Show when={push.status() === 'on'}>
				<button type="button" onClick={push.test}><Icon name="send" />Send test notification</button>
				<button type="button" onClick={() => void push.disable().catch(fail)}><Icon name="close" />Turn off</button>
			</Show>
			<Show when={push.devices().result}>{(r) => <p role="status">{r()}</p>}</Show>
			<h3>History</h3>
			<Show when={push.history()} fallback={<p role="status">Loading…</p>}>
				{(list) => (
					<ol class="history">
						<For each={list()} fallback={<li>No notifications yet.</li>}>
							{(e) => (
								<li class={e.kind}>
									<a href={(e.block && transcript.href(e.session, e.block)) || router.format(e.session)} onClick={(ev) => {
										if (ev.button || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return
										props.onClose()
										if (e.block) return
										ev.preventDefault()
										tabs.show(e.session, false)
									}}>
										<span class="head"><time datetime={e.at}>{notices.stamp(e.at)}</time> {e.name} · {notices.reason(e)}</span>
										<span class="line">{e.line}</span>
									</a>
								</li>
							)}
						</For>
					</ol>
				)}
			</Show>
			<p>Keeps the latest 200.</p>
			<h3>Devices</h3>
			<ul>
				<For each={push.devices().devices} fallback={<li>None registered.</li>}>
					{(d) => (
						<li>
							<span class="name">
								{d.device ?? 'Unnamed device'}
								{d.endpoint === push.mine() ? ' (this device)' : ''}
								{d.added ? ` · added ${new Date(d.added!).toLocaleDateString()}` : ''}
							</span>
							<button type="button" class="close" aria-label={`Remove ${d.device ?? 'device'}`} onClick={() => push.remove(d.endpoint)}><Icon name="close" />Remove</button>
						</li>
					)}
				</For>
			</ul>
			<button type="button" onClick={props.onClose}><Icon name="close" />Close</button>
		</dialog>
	)
}

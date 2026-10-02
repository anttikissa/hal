/// <reference lib="dom" />
// Push notifications for this device and the list of registered devices.
import { createEffect, For, Show } from 'solid-js'
import { connection } from '../../common/connection.ts'
import { push } from '../push.ts'

const said = {
	unsupported: 'Not available here. On iPhone, open Hal from its Home Screen icon (Share → Add to Home Screen).',
	blocked: 'Blocked. Allow notifications for Hal in iOS Settings → Notifications.',
	on: 'On for this device. Hal notifies when a turn ends while no screen shows that tab.',
	off: 'Off for this device.',
}

export function Notifications(props: { open: boolean; onClose: () => void }) {
	let dialog!: HTMLDialogElement
	createEffect(() => props.open, (o) => {
		if (o && !dialog.open) { dialog.showModal(); connection.send({ type: 'push', action: 'list' }) }
		if (!o && dialog.open) dialog.close()
	})
	let fail = (e: any) => alert(`Notifications: ${e?.message ?? e}`)
	return (
		<dialog ref={(e) => (dialog = e)} class="Notifications sheet" aria-label="Notifications" onClose={props.onClose} onClick={(e) => e.target === e.currentTarget && props.onClose()}>
			<h2>Notifications</h2>
			<p role="status">{said[push.status()]}</p>
			<Show when={push.status() === 'off'}>
				<button type="button" class="new" onClick={() => void push.enable().catch(fail)}>Turn on</button>
			</Show>
			<Show when={push.status() === 'on'}>
				<button type="button" onClick={push.test}>Send test notification</button>
				<button type="button" onClick={() => void push.disable().catch(fail)}>Turn off</button>
			</Show>
			<Show when={push.devices().result}>{(r) => <p role="status">{r()}</p>}</Show>
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
							<button type="button" class="close" aria-label={`Remove ${d.device ?? 'device'}`} onClick={() => push.remove(d.endpoint)}>Remove</button>
						</li>
					)}
				</For>
			</ul>
			<button type="button" onClick={props.onClose}>Close</button>
		</dialog>
	)
}

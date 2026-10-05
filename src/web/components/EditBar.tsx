/// <reference lib="dom" />
// Over the message box while a prompt card's Edit is in progress (task
// 26q, edit-prompt.ts): what sending will do, and Cancel, which brings
// the draft back. Pages with a keyboard also name Escape. Colored as
// the notice stack: a bar in the attention color on faint gray.

import { flush, Show } from 'solid-js'
import { queueEdit } from '../../common/queue-edit.ts'
import { amend } from '../../common/amend.ts'
import { editPrompt } from '../edit-prompt.ts'
import type { ViewState } from '../view.ts'
import { Icon } from './Icon.tsx'

export function EditBar(props: { view: ViewState }) {
	let editing = () => (props.view.editing?.aside ? props.view.editing : undefined)
	let cancel = () => {
		editPrompt.leave()
		flush()
		document.querySelector<HTMLTextAreaElement>('.Composer textarea')?.focus()
	}
	return (
		<Show when={editing()}>
			{(e) => (
				<div class="EditBar notice" role="status">
					<span class="text">{amend.bar(e())}<span class="keys"> · Escape cancels</span></span>
					<button type="button" disabled={!!props.view.transcript && !!queueEdit.current(props.view.transcript.meta.id)?.saving} onClick={cancel}><Icon name="close" />Cancel</button>
				</div>
			)}
		</Show>
	)
}

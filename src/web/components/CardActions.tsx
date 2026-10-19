/// <reference lib="dom" />
// A card's header buttons (Card.tsx): Edit for a prompt the user may
// edit and resend (task 26q, edit-prompt.ts), Send now and Discard for a
// queued message (task gr4), Undo on a history rewrite's divider (task
// z71) and Kill for a background job still running.

import { flush, Show } from 'solid-js'
import { app } from '../app.ts'
import { editPrompt } from '../edit-prompt.ts'
import type { Row } from '../transcript-rows.ts'
import { Icon } from './Icon.tsx'

export function CardActions(props: { row: Row; session: string; edit?: boolean; discard?: boolean; job?: string }) {
	// A history rewrite's divider (task z71) offers its undo.
	let undo = () => props.row.item.type === 'divider' && props.row.item.text.includes('`/rebase undo`')
	let undoButton = () => (
		<Show when={undo()}>
			<button
				type="button"
				class="undo"
				title="Go back (/rebase undo)"
				onClick={() => app.sendNow({ type: 'submit', sessionId: props.session, text: '/rebase undo' })}
			>
				<Icon name="undo" />
				Undo
			</button>
		</Show>
	)
	let edit = () => {
		if (!editPrompt.edit(props.row.waiting ? props.row.key : props.row.item.key)) return
		flush()
		let box = document.querySelector<HTMLTextAreaElement>('.Composer textarea')
		box?.focus()
		box?.setSelectionRange(box.value.length, box.value.length)
	}
	let editButton = () => (
		<Show when={props.edit}>
			<button
				type="button"
				class="edit"
				aria-label={props.row.waiting ? 'Edit queued message' : 'Edit prompt'}
				title={
					props.row.waiting
						? 'Edit in the queue without changing its position'
						: 'Edit this prompt and send it again from here'
				}
				onClick={edit}
			>
				<Icon name="edit" />
			</button>
		</Show>
	)
	// Drops this queued message by its inbox id (task gr4); the host refuses with a visible reason.
	let sendButton = () => (
		<Show when={props.discard}>
			<button
				type="button"
				class="send"
				aria-label="Send queued message now"
				title="Send now; it keeps its sender and arrival time"
				onClick={() => app.sendNow({ type: 'submit', sessionId: props.session, text: `/queue next ${props.row.key}` })}
			>
				<Icon name="send" />
			</button>
		</Show>
	)
	let discardButton = () => (
		<Show when={props.discard}>
			<button
				type="button"
				class="discard"
				aria-label="Discard queued message"
				title="Remove from the queue"
				onClick={() =>
					app.sendNow({ type: 'submit', sessionId: props.session, text: `/queue drop --id ${props.row.key}` })
				}
			>
				<Icon name="close" />
			</button>
		</Show>
	)
	return (
		<>
			{editButton()}
			{sendButton()}
			{discardButton()}
			{undoButton()}
			<Show when={props.job}>
				{(n) => (
					<button
						type="button"
						class="kill error"
						title={`Stop background job t${n()} (/kill t${n()})`}
						aria-label={`Kill background job t${n()}`}
						onClick={() => app.sendNow({ type: 'submit', sessionId: props.session, text: `/kill t${n()}` })}
					>
						<Icon name="skull" />
						kill
					</button>
				)}
			</Show>
		</>
	)
}

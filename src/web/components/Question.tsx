/// <reference lib="dom" />
// The open question as a form: its text, the quote (a command to
// approve) with marked parts highlighted, a text or password input per
// text field and a button per option. Values and focus follow the
// shared form state; keys go through keys.key (forms.step). ✕
// dismisses it as Escape does.

import { createEffect, For, Show } from 'solid-js'
import { forms, type FormState } from '../../common/forms.ts'
import type { Shown as Item } from '../../common/transcript.ts'
import { app } from '../app.ts'

export function Question(props: { item: Item & { type: 'question' }; form: FormState }) {
	let fields: HTMLElement[] = []
	let form = () => props.item.form
	// The focused field takes the focus (its chosen option, for a group).
	createEffect(
		() => [props.form.focus, props.form.values[props.form.focus]] as const,
		([focus, value]) => {
			let node = fields[focus]
			if (!node || node.contains(document.activeElement)) return
			let target = node instanceof HTMLInputElement ? node : [...node.querySelectorAll('button')].find((b) => b.value === value)
			target?.focus()
		},
	)
	let submit = (e: SubmitEvent) => {
		e.preventDefault()
		app.submitForm()
	}
	return (
		<form class="Question warning" onSubmit={submit}>
			<div class="text">? {form().text}</div>
			<button type="button" class="dismiss" aria-label="Dismiss" title="Dismiss (Esc)" onClick={() => app.sendForm({ type: 'cancel' })}>
				✕
			</button>
			<Show when={form().quote}>
				{(quote) => (
					<pre class="quote">
						<For each={forms.quoteParts(quote())}>{(part) => (part.marked ? <mark>{part.text}</mark> : part.text)}</For>
					</pre>
				)}
			</Show>
			<For each={form().fields}>
				{(field, i) =>
					field.type === 'choice' ? (
						<div role="group" aria-label={field.label ?? form().text} ref={(el) => (fields[i()] = el)}>
							{field.label ? `${field.label}: ` : ''}
							<For each={field.options}>
								{(option) => (
									<>
										<button type="button" value={option} aria-pressed={props.form.values[i()] === option ? 'true' : 'false'} onClick={() => app.pick(i(), option)}>
											{option}
										</button>
									</>
								)}
							</For>
						</div>
					) : (
						<label>
							{field.label ? `${field.label}: ` : ''}
							<input
								ref={(el) => (fields[i()] = el)}
								class="input"
								type={field.type === 'secret' ? 'password' : 'text'}
								aria-label={field.label ?? form().text}
								autocomplete="off"
								placeholder={field.type === 'text' ? field.placeholder : undefined}
								value={props.form.values[i()] ?? ''}
								onInput={(e) => app.formInput(i(), e.currentTarget.value)}
								onFocus={() => app.formFocus(i())}
							/>
						</label>
					)
				}
			</For>
			<Show when={form().fields.some((f) => f.type !== 'choice') || form().fields.length > 1}>
				<button>Answer</button>
			</Show>
		</form>
	)
}

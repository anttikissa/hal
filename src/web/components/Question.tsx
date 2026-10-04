/// <reference lib="dom" />
// The open question as a form: its text, the quote (a command to
// approve) with marked parts highlighted, a text or password input per
// text field and a button per option. Values and focus follow the
// shared form state; keys go through keys.key (forms.step). A choice
// is one Tab stop: focus sits on its chosen option and follows it, so
// focus and choice never part. ✕
// dismisses it as Escape does.

import { createEffect, createMemo, For, Show, untrack } from 'solid-js'
import { forms, type FormState } from '../../common/forms.ts'
import type { Shown as Item } from '../../common/transcript.ts'
import { external } from './Markdown.tsx'
import { app } from '../app.ts'
import { view } from '../view.ts'
import { Icon } from './Icon.tsx'
import { CardHeader } from './CardHeader.tsx'
import { titles } from '../../common/titles.ts'

export function Question(props: { item: Item & { type: 'question' }; form: FormState }) {
	let fields: HTMLElement[] = []
	let form = () => props.item.form
	let parts = createMemo(() => view.urlParts(form().text))
	// The focused field takes the focus (its chosen option, for a group).
	createEffect(
		() => [props.form.focus, props.form.values[props.form.focus]] as const,
		([focus, value]) => {
			let node = fields[focus]
			let target = node instanceof HTMLInputElement ? node : [...(node?.querySelectorAll('button') ?? [])].find((b) => b.value === value)
			// focus() runs the focus and blur handlers here, inside the
			// effect; they read the state as of the event.
			if (target && target !== document.activeElement) untrack(() => target.focus())
		},
	)
	let submit = (e: SubmitEvent) => {
		e.preventDefault()
		app.submitForm()
	}
	return (
		<form class="Question question" onSubmit={submit}>
			<Show when={titles.time(props.item.ts)}>{(time) => <CardHeader time={time()} />}</Show>
			<div class="text">? <For each={parts()}>{(part) => typeof part === 'string' ? part : <a href={external(part.href)} target="_blank" rel="noopener noreferrer">{part.text}</a>}</For></div>
			<button type="button" class="dismiss" aria-label="Dismiss" title="Dismiss (Esc)" onClick={() => app.sendForm({ type: 'cancel' })}>
				<Icon name="close" />
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
						<div role="group" aria-label={field.label ?? form().text} ref={(el) => (fields[untrack(i)] = el)}>
							{field.label ? `${field.label}: ` : ''}
							{field.help ? <div>{field.help}</div> : null}
							<For each={field.options}>
								{(option) => (
									<>
										<button
											type="button"
											value={option}
											aria-pressed={props.form.values[i()] === option ? 'true' : 'false'}
											tabindex={props.form.values[i()] === option ? 0 : -1}
											onFocus={() => app.formFocus(i())}
											onClick={() => app.pick(i(), option)}
										>
											{option}
										</button>
									</>
								)}
							</For>
						</div>
					) : (
						<label>
							{field.label ? `${field.label}: ` : ''}
							{field.help ? <span>{field.help}</span> : null}
							<input
								ref={(el) => (fields[untrack(i)] = el)}
								class="input"
								type={field.type === 'secret' ? 'password' : 'text'}
								inputmode={field.type === 'integer' ? 'numeric' : undefined}
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
				<button class="answer"><Icon name="check" />Answer</button>
			</Show>
		</form>
	)
}

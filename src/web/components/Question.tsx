/// <reference lib="dom" />
// The open question as a form: its text, the quote (a command to
// approve) with marked parts highlighted, a text or password input per
// text field and a button per option. Values and focus follow the
// shared form state; keys go through keys.key (forms.step). A choice
// is one Tab stop: focus sits on its chosen option and follows it, so
// focus and choice never part. ✕
// dismisses it as Escape does.

import { createEffect, createMemo, createSignal, For, onSettled, Show, untrack } from 'solid-js'
import { forms, type FormState } from '../../common/forms.ts'
import type { Shown as Item } from '../../common/transcript.ts'
import { external } from './Markdown.tsx'
import { app } from '../app.ts'
import { hrefs } from '../hrefs.ts'
import { Icon } from './Icon.tsx'
import { CardHeader } from './CardHeader.tsx'
import { titles } from '../../common/titles.ts'
import { target } from '../target.ts'

export function Question(props: { item: Item & { type: 'question' } & { key: string }; form: FormState; session: string }) {
	let fields: HTMLElement[] = []
	let form = () => props.item.form
	let parts = createMemo(() => hrefs.urlParts(form().text))
	// The focused field takes the focus (its chosen option, for a group).
	// The memo gates on equality: other updates re-run an effect's
	// callback, and a focus() then would clear a reader's selection.
	let at = createMemo(() => [props.form.focus, props.form.values[props.form.focus]] as const, { equals: (a, b) => a[0] === b[0] && a[1] === b[1] })
	createEffect(
		at,
		([focus, value]) => {
			let node = fields[focus]
			let target = node instanceof HTMLInputElement ? node : [...(node?.querySelectorAll('button') ?? [])].find((b) => b.value === value)
			// focus() runs the focus and blur handlers here, inside the
			// effect; they read the state as of the event.
			if (target && target !== document.activeElement) untrack(() => target.focus())
		},
	)
	// Rotating placeholders repaint when their text next changes; with
	// reduced motion the first stays.
	let [now, setNow] = createSignal(Date.now())
	onSettled(() => {
		if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
		let timer: ReturnType<typeof setTimeout> | undefined
		let tick = () => {
			let t = Date.now()
			setNow(t)
			let next = Math.min(...form().fields.map((_, i) => forms.example(props.form, i, t).next))
			if (next < Infinity) timer = setTimeout(tick, next)
		}
		tick()
		return () => clearTimeout(timer)
	})
	let submit = (e: SubmitEvent) => {
		e.preventDefault()
		app.submitForm()
	}
	return (
		<form class="Question question" onSubmit={submit}>
			<CardHeader flow time={titles.time(props.item.ts)} label={<For each={parts()}>{(part) => typeof part === 'string' ? part : <a href={external(part.href)} target="_blank" rel="noopener noreferrer">{part.text}</a>}</For>} reference={<Show when={target.href(props.session, titles.blockId(props.item))}>{(h) => <a class="link" href={h()} data-ref={`#${titles.blockId(props.item)}`} title="Link to this block" aria-label={`Link to block ${titles.blockId(props.item)}`} />}</Show>} />
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
								placeholder={field.type === 'text' ? forms.example(props.form, i(), now()).text || undefined : undefined}
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

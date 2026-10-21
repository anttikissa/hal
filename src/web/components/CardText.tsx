/// <reference lib="dom" />
// A card's literal text (Card.tsx): a past question keeps its quote's
// marks, as the open form showed them; a prompt's [image/<name>] markers
// are links (task qy), rebuilt only when its text changes.

import { createMemo, For } from 'solid-js'
import { forms } from '../../common/forms.ts'
import type { Item } from '../../common/transcript.ts'
import { hrefs } from '../hrefs.ts'
import { external } from './Markdown.tsx'

export function CardText(props: { item: Item; text: string }) {
	let linked = createMemo(() =>
		props.item.type === 'prompt' && props.text.includes('[image/') ? hrefs.links(props.text) : props.text,
	)
	let parts = () => {
		let item = props.item
		// A past question keeps its quote's marks, as the open form showed them.
		if (item.type === 'question' && item.form.quote?.marks?.length) {
			let q = item.form.quote
			let indent = (t: string, marked: boolean) =>
				t.split('\n').map((l, i) => (
					<>
						{i ? '\n    ' : ''}
						{marked && l ? <mark>{l}</mark> : l}
					</>
				))
			let details = forms.details(item.form)
			let head = details.length ? `${details.join('\n')}\n\n` : ''
			return (
				<>
					{head}
					{'    '}
					<For each={forms.quoteParts(q)}>{(p) => indent(p.text, p.marked)}</For>
					{props.text.slice(head.length + q.text.length + 4 * q.text.split('\n').length)}
				</>
			)
		}
		let l = linked()
		return typeof l === 'string'
			? l
			: l.map((p) =>
					typeof p === 'string' ? (
						p
					) : (
						<a href={external(p.href)} target="_blank" rel="noopener">
							{p.text}
						</a>
					),
				)
	}
	return <>{parts()}</>
}

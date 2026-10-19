/// <reference lib="dom" />
// Text with its addresses as links (hrefs.urlParts): the page's own
// paths open here, other addresses in a new tab.

import { For } from 'solid-js'
import type { hrefs } from '../hrefs.ts'
import { external } from './Markdown.tsx'

export function LinkedText(props: { parts: ReturnType<typeof hrefs.urlParts> }) {
	return (
		<For each={props.parts}>
			{(part) =>
				typeof part === 'string' ? (
					part
				) : part.href.startsWith('/') ? (
					<a href={part.href}>{part.text}</a>
				) : (
					<a href={external(part.href)} target="_blank" rel="noopener noreferrer">
						{part.text}
					</a>
				)
			}
		</For>
	)
}

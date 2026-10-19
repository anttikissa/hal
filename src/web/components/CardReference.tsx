/// <reference lib="dom" />
// One permalink presentation for transcript cards and active questions.
import { Show } from 'solid-js'
import type { JSX } from '@solidjs/web'

export function CardReference(props: { href?: string; id: string; children?: JSX.Element }) {
	return (
		<Show when={props.href} fallback={props.children}>
			{(href) => (
				<a
					class="link"
					href={href()}
					data-ref={props.id}
					title="Link to this card"
					aria-label={`Link to card ${props.id}`}
				>
					{props.children}
				</a>
			)}
		</Show>
	)
}

/// <reference lib="dom" />
// Links a transcript card or an active question to its address, so
// every permalink looks and works the same.
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

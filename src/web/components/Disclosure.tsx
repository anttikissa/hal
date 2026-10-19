/// <reference lib="dom" />
// The native triangle-free control for card and nested disclosures.
import type { JSX } from '@solidjs/web'

export function Disclosure(props: {
	class?: string
	name: string
	open: boolean
	onClick?: () => void
	children: JSX.Element
}) {
	return (
		<button
			type="button"
			class={props.class}
			aria-label={props.name}
			aria-expanded={props.open ? 'true' : 'false'}
			onClick={props.onClick}
		>
			{props.children}
		</button>
	)
}

/// <reference lib="dom" />
// The show/hide control for cards and nested disclosures: a native
// button, without a triangle.
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

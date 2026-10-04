/// <reference lib="dom" />
// The first row of every headed transcript card. Slots share one grid:
// time, readable label, block link. Controls grow their hit area, not
// an independently centred glyph; every slot starts on the first line.
import { Show } from 'solid-js'
import type { JSX } from '@solidjs/web'
import { Icon } from './Icon.tsx'
import type { IconName } from '../icons.ts'

export function CardHeader(props: { icon?: IconName; time?: string; label?: JSX.Element; reference?: JSX.Element; name?: string; open?: boolean; children?: JSX.Element }) {
	return (
		<header class={['CardHeader', props.name === undefined ? 'who' : 'head']}>
			<Show when={props.time || props.name}>
				<Show when={props.name !== undefined} fallback={<span class="stamp">{props.time}</span>}>
					<button type="button" class="stamp mark" aria-label={props.name} aria-expanded={props.open ? 'true' : 'false'}>{props.time}</button>
				</Show>
				<Show when={props.label}>{' '}</Show>
			</Show>
			<span class="title"><Show when={props.icon}>{(name) => <Icon name={name()} />}</Show><span class="label">{props.label}</span>{props.children}</span>
			{props.reference}
		</header>
	)
}

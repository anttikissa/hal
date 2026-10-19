/// <reference lib="dom" />
// A sent message's read receipt in its card's link (Card.tsx): one tick
// once delivered, two once Hal has read it.

import { Show } from 'solid-js'
import { titles } from '../../common/titles.ts'
import type { Row } from '../transcript-rows.ts'
import { Icon } from './Icon.tsx'

export function CardReceipt(props: { row: Row }) {
	let time = () => titles.time((props.row.item as { ts?: string }).ts)
	let receipt = () => (props.row.pending ? 0 : titles.receipt(props.row.item))
	let label = () => (receipt() === 1 ? 'Delivered, not read yet' : `Read by Hal${time() ? ` at ${time()}` : ''}`)
	return (
		<Show when={receipt()}>
			<span class="receipt" role="img" aria-label={label()} title={label()}>
				<Icon name={receipt() === 1 ? 'check' : 'checks'} />
			</span>
		</Show>
	)
}

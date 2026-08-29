import { Show } from 'solid-js'
import type { LiveToolBlock } from '../../common/live-event-blocks.ts'
import { toolCard } from '../utils/tool-card.ts'

type ToolCardProps = {
	tool: LiveToolBlock
}

export function ToolCard(props: ToolCardProps) {
	const card = () => toolCard.present(props.tool)
	return <article class={['ToolCard', `ToolCard-${props.tool.name}`, { running: !!props.tool.running }]} aria-label={card().title}>
		<header>
			<strong>{card().title}</strong>
			<span>{props.tool.running ? 'Running' : 'Done'}</span>
		</header>
		<Show when={card().detail}>{(detail) => <p>{detail()}</p>}</Show>
		<Show when={card().preview.length}>
			<pre>{card().preview.join('\n')}</pre>
		</Show>
		<Show when={card().hiddenLines}>{(count) => <small>… {count()} more {count() === 1 ? 'line' : 'lines'}</small>}</Show>
	</article>
}

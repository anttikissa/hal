import { Show } from 'solid-js'
import type { LiveToolBlock } from '../../common/live-event-blocks.ts'
import { router } from '../router.ts'
import { toolCard } from '../utils/tool-card.ts'
import { webTranscript } from '../utils/transcript.ts'

type ToolCardProps = {
	tool: LiveToolBlock
}

export function ToolCard(props: ToolCardProps) {
	const card = () => toolCard.present(props.tool)
	return <article class={['ToolCard', `ToolCard-${props.tool.name}`, { running: !!props.tool.running }]} aria-label={card().title}>
		<details id={props.tool.toolId ? `tool-${encodeURIComponent(props.tool.toolId)}` : undefined}>
			<summary>
				<header><strong>{card().title}</strong><span>{props.tool.running ? 'Running' : 'Done'}</span></header>
				<Show when={card().detail}>{(detail) => <p>{detail()}</p>}</Show>
				<Show when={card().preview.length}><pre>{card().preview.join('\n')}</pre></Show>
				<Show when={card().hiddenLines}>{(count) => <small>… {count()} more {count() === 1 ? 'line' : 'lines'}</small>}</Show>
			</summary>
			<Show when={props.tool.toolId}><a class="ToolCard-link" href={router.toolHash(props.tool.toolId!)}>Link to this tool</a></Show>
			<Show when={props.tool.input !== undefined}>
				<div class="ToolCard-section"><strong>Input</strong><button type="button" onClick={() => void navigator.clipboard.writeText(webTranscript.valueText(props.tool.input))}>Copy</button><pre>{webTranscript.valueText(props.tool.input)}</pre></div>
			</Show>
			<Show when={props.tool.output !== undefined}>
				<div class="ToolCard-section"><strong>Output</strong><button type="button" onClick={() => void navigator.clipboard.writeText(props.tool.output ?? '')}>Copy</button><pre>{props.tool.output}</pre></div>
			</Show>
		</details>
	</article>
}

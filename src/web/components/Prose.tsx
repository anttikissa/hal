// Literal human text with half-line paragraph gaps; code keeps its spacing.
import { createMemo, For } from 'solid-js'
import { hrefs } from '../hrefs.ts'
import { external } from './Markdown.tsx'

export function Prose(props: { text: string }) {
	let rows = createMemo(() => {
		let lines = props.text.match(/[^\n]*\n|[^\n]+$/g) ?? []
		let fence = '',
			width = 0
		return lines.map((text, i) => {
			let literal = !!fence
			let mark = text.match(/^ {0,3}(`{3,}|~{3,})(.*)/)
			if (mark) {
				if (!fence) {
					fence = mark[1]![0]!
					width = mark[1]!.length
				} else if (mark[1]![0] === fence && mark[1]!.length >= width && !mark[2]!.trim()) fence = ''
			}
			let indented = (line = '') => /^(?: {4}|\t)/.test(line)
			let blank = !text.trim() && !literal && !indented(lines[i - 1]) && !indented(lines[i + 1])
			return { text, blank }
		})
	})
	return (
		<span class="Prose">
			<For each={rows()}>
				{(row) => (
					<span class={row.blank ? 'row blank' : 'row'}>
						<For each={hrefs.links(row.text)}>
							{(part) =>
								typeof part === 'string' ? (
									part
								) : (
									<a href={external(part.href)} target="_blank" rel="noopener">
										{part.text}
									</a>
								)
							}
						</For>
					</span>
				)}
			</For>
		</span>
	)
}

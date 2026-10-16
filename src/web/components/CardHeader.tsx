/// <reference lib="dom" />
// The first row of every headed transcript card: time and label flow as
// one paragraph, so a wrapped label continues at the left edge, under
// the time, as in the terminal; actions and the block link stay right.
// `activity`: a live block's elapsed time and spinner, before the link
// (task hyt). Tasks: 4v, hp, 77f, kx0, hyt.
import { createMemo, Show } from 'solid-js'
import { bashResult } from '../../common/bash-result.ts'
import { diff } from '../../common/diff.ts'
import type { JSX } from '@solidjs/web'
import { Icon } from './Icon.tsx'
import type { IconName } from '../icons.ts'
import { Disclosure } from './Disclosure.tsx'

export function CardHeader(props: { inline?: boolean; icon?: IconName; prefix?: string; time?: string; label?: JSX.Element; reference?: JSX.Element; actions?: JSX.Element; activity?: JSX.Element; name?: string; open?: boolean; limit?: string; children?: JSX.Element; result?: { output: string; diff?: string; ms?: number; isError?: boolean; interrupted?: 'canceled' | 'stopped' }; bash?: boolean }) {
	let exit = () => props.result ? bashResult.failure(props.result, props.bash) : undefined
	let label = createMemo(() => props.label)
	let rest = () => props.result && (bashResult.interrupted(props.result) ?? (props.limit ? `${bashResult.duration(props.result.ms) ?? '0s'} / ${props.limit}` : bashResult.duration(props.result.ms)))
	// An EDIT's counts and changed lines, as in the terminal.
	let stats = () => props.result?.diff && !props.result.isError ? diff.stats(props.result.diff) : undefined
	return (
		<header class={['CardHeader', props.name === undefined ? 'who' : 'head', props.inline ? 'inline' : '']}>
			<span class="flow">
				<Show when={props.time || props.name}>
					<Show when={props.name !== undefined} fallback={<span class="stamp">{props.time}</span>}>
						<Disclosure class="stamp mark" name={props.name ?? ''} open={!!props.open}>{props.time}</Disclosure>
					</Show>
					<Show when={label()}>{' '}</Show>
				</Show>
				<span class="title"><Show when={props.icon}>{(name) => <Icon name={name()} />}</Show><span class="label">{props.prefix}{label()}</span>{props.children}</span>
			</span>
			{props.actions}
			<Show when={!stats() && (exit() || rest())}><span class="status">(<Show when={exit()}>{(s) => <span class="exit" style={s() === 'exit 1' ? { color: 'var(--neutral-fg)' } : undefined}>{s()}</span>}</Show>{exit() && rest() ? ', ' : ''}{rest()})</span></Show>
			<Show when={stats()}>{(s) => <span class="status diff">(<Show when={s().added}><span class="add">+{s().added}</span></Show>{s().added && s().removed ? ' ' : ''}<Show when={s().removed}><span class="del">−{s().removed}</span></Show>, {s().lines}{rest() ? `, ${rest()}` : ''})</span>}</Show>
			{props.activity}
			{props.reference}
		</header>
	)
}

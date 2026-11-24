/// <reference lib="dom" />
// The chip row over the composer: the session's directory, model and
// spawn budget as chips that open their panels, its activity and
// context, a quota gauge and the session menu. Session details keep
// every fact the host pushed. The cwd truncates from the start; wide
// rows add the session id and each usage window's own gauge.
import { createMemo, createSignal, flush, For, Show } from 'solid-js'
import { settings } from '../../common/settings.ts'
import { home } from '../../common/home.ts'
import { names } from '../../common/names.ts'
import { titles } from '../../common/titles.ts'
import { app } from '../app.ts'
import { find } from '../find.ts'
import { tabs } from '../tabs.ts'
import { view, type ViewState } from '../view.ts'
import { status, type StatusGroup, type UsageWindow } from '../status.ts'
import { Icon } from './Icon.tsx'
import { Notifications } from './Notifications.tsx'
import { Panel } from './Panel.tsx'

const heat = (n: number | undefined) => (n === undefined ? '' : `heat-${n}`)

function Parts(props: { group: StatusGroup }) {
	return (
		<span dir="ltr">
			<For each={props.group.parts} keyed={false}>
				{(part) => <span class={heat(part().heat)}>{part().text}</span>}
			</For>
		</span>
	)
}

// One ring per usage window, outermost first, filled to its use in its heat.
function Ring(props: { windows: (UsageWindow | undefined)[]; size: number }) {
	const stroke = 2.25,
		gap = 1.5
	let c = () => props.size / 2
	return (
		<svg
			class="ring"
			width={props.size}
			height={props.size}
			viewBox={`0 0 ${props.size} ${props.size}`}
			aria-hidden="true"
		>
			<For each={props.windows} keyed={false}>
				{(w, i) => {
					let r = () => c() - stroke / 2 - i * (stroke + gap)
					let len = () => 2 * Math.PI * r()
					return (
						<>
							<circle class="track" cx={c()} cy={c()} r={r()} fill="none" stroke-width={stroke} />
							<circle
								class={heat(w()?.used)}
								cx={c()}
								cy={c()}
								r={r()}
								fill="none"
								stroke="currentColor"
								stroke-width={stroke}
								stroke-dasharray={`${(len() * (w()?.used ?? 0)) / 100} ${len()}`}
								transform={`rotate(-90 ${c()} ${c()})`}
							/>
						</>
					)
				}}
			</For>
		</svg>
	)
}

type Open = 'cwd' | 'budget' | 'quota' | 'menu'

export function StatusRow(props: {
	view: ViewState
	connected: boolean
	fresh?: boolean
	color?: number
	hal?: boolean
	untrusted?: boolean
}) {
	let details!: HTMLDialogElement
	let chip: Partial<Record<Open, HTMLElement>> = {}
	let [open, setOpen] = createSignal<Open>()
	let [alerts, setAlerts] = createSignal(false)
	let meta = () => props.view.transcript?.meta
	let line = () => view.line(props.view, props.connected, props.fresh)
	let tone = () => ({ idle: '', busy: 'busy', warn: 'warning', error: 'error' })[line().tone]
	let context = () => status.context(props.view)
	let windows = () => status.windows(props.view)
	// Window names are strings, so their nodes survive every push.
	let names_ = createMemo(() => windows().map((w) => w.name), {
		equals: (a, b) => a.length === b.length && a.every((n, i) => n === b[i]),
	})
	let win = (name: string) => windows().find((w) => w.name === name)
	// Which subscription the windows belong to, as /status numbers its slots.
	let slot = () => {
		let p = props.view.transcript?.stats?.plan
		return p && p.accounts > 1 ? `${p.account} ` : ''
	}
	let cwd = () => home.short(meta()?.cwd.replace(/(.)\/+$/, '$1') ?? '')
	let slots = () => meta()?.slots ?? settings.subagentSlots()
	let model = (full?: boolean) => titles.modelLabel(meta()?.model ?? '', props.view.transcript?.stats?.effort, full)
	let run = (text: string) => {
		setOpen(undefined)
		if (meta()) app.sendNow({ type: 'submit', sessionId: meta()!.id, text })
	}
	let shut = () => setOpen(undefined)
	let expanded = (name: Open) => (open() === name ? 'true' : 'false')
	// Directories of the open tabs, each in its project color, read on opening.
	let [dirs, setDirs] = createSignal<{ cwd: string; color?: number }[]>([])
	let [query, setQuery] = createSignal('')
	let found = () => dirs().filter((d) => home.short(d.cwd).includes(query()))
	let openDirs = () => {
		let seen = new Map<string, number | undefined>()
		for (let t of app.state.tabs) if (!seen.has(t.cwd)) seen.set(t.cwd, t.hal ? undefined : t.color)
		setDirs([...seen].map(([cwd, color]) => ({ cwd, color })))
		setQuery('')
		setOpen('cwd')
	}
	// The budget applies when its panel closes; Escape keeps the old one.
	let [budget, setBudget] = createSignal(0)
	let step = (n: number) => setBudget(Math.max(0, budget() + n))
	return (
		<div class="StatusRow status" aria-label="Session status">
			<span class="id">{meta()?.id ?? ''}</span>
			<Show when={meta()}>
				<button
					type="button"
					ref={(e) => (chip.cwd = e)}
					class={['chip', 'box', 'cwd', props.hal && 'hal-home']}
					style={props.hal || props.color === undefined ? undefined : { '--project': `var(--p${props.color})` }}
					aria-label={`Directory ${cwd()}`}
					aria-haspopup="dialog"
					aria-expanded={expanded('cwd')}
					popovertarget="panel-cwd"
				>
					<span class="path">
						<bdi>{cwd()}</bdi>
					</span>
					<span class="caret" aria-hidden="true">
						▾
					</span>
				</button>
				{props.untrusted && <span class="untrusted">untrusted</span>}
				<button
					type="button"
					class="chip box model"
					aria-label={`Model ${model(true)}`}
					aria-haspopup="dialog"
					onClick={() => app.sendNow({ type: 'models', sessionId: meta()!.id })}
				>
					<span class="full">{model(true)}</span>
					<span class="short">{model()}</span>
					<span class="caret" aria-hidden="true">
						▾
					</span>
				</button>
				<button
					type="button"
					ref={(e) => (chip.budget = e)}
					class="chip box budget"
					aria-label={`Spawn budget: ${slots()} subagents`}
					aria-haspopup="dialog"
					aria-expanded={expanded('budget')}
					popovertarget="panel-budget"
				>
					{slots() >= 1 && slots() <= 8 ? (
						<span class="stack">
							{Array.from({ length: slots() }, () => (
								<i />
							))}
						</span>
					) : (
						slots()
					)}
				</button>
			</Show>
			<span class="spacer" />
			<span class={['activity', tone()]} aria-live="polite">
				<span class={['dot', tone()]} aria-hidden="true" />
				<span class="text">{line().text}</span>
			</span>
			<span class={['context', heat(context()?.heat)]}>{context()?.text}</span>
			<Show when={names_().length}>
				<button
					type="button"
					ref={(e) => (chip.quota = e)}
					class="chip quota gauge"
					aria-label={`Quota: ${windows()
						.map((w) => `${w.name} ${w.used}% used`)
						.join(', ')}`}
					aria-haspopup="dialog"
					aria-expanded={expanded('quota')}
					popovertarget="panel-quota"
				>
					<Ring windows={[...names_()].reverse().map(win)} size={18} />
				</button>
				<span class="windows">
					{slot()}
					<For each={names_()}>
						{(name) => (
							<span
								class="chip quota window"
								title={win(name)?.resets ? `Resets ${status.reset(win(name)!.resets!)}` : undefined}
							>
								{name}
								<Ring windows={[win(name)]} size={14} />
								<span class={heat(win(name)?.used)}>{win(name)?.used}%</span>
							</span>
						)}
					</For>
				</span>
			</Show>
			<Show when={!names_().length && slot()}>
				<span class="windows">{slot()}</span>
			</Show>
			<button
				type="button"
				ref={(e) => (chip.menu = e)}
				class="more"
				aria-label="Session menu"
				aria-haspopup="dialog"
				aria-expanded={expanded('menu')}
				popovertarget="panel-menu"
			>
				<Icon name="more" />
			</button>
			<Panel
				id="panel-cwd"
				open={open() === 'cwd'}
				anchor={chip.cwd}
				label="Directory"
				onOpen={openDirs}
				onClose={shut}
			>
				<div class="head">
					<strong class="title">Directory</strong>
				</div>
				<div class="group">Open tabs</div>
				<For each={found()}>
					{(d) => (
						<button
							type="button"
							class={['row', 'led', d.cwd === meta()?.cwd && 'current']}
							style={d.color === undefined ? undefined : { '--project': `var(--p${d.color})` }}
							onClick={() => run(`/cd ${d.cwd}`)}
						>
							{home.short(d.cwd)}
						</button>
					)}
				</For>
				<form
					class="field"
					onSubmit={(e) => {
						e.preventDefault()
						let to = found()[0]?.cwd ?? query().trim()
						if (to) run(`/cd ${to}`)
					}}
				>
					<label class="input">
						<Icon name="google" />
						<input
							type="text"
							placeholder="Search or type a path"
							aria-label="Search or type a path"
							autocomplete="off"
							value={query()}
							onInput={(e) => setQuery(e.currentTarget.value)}
						/>
					</label>
				</form>
			</Panel>
			<Panel
				id="panel-budget"
				open={open() === 'budget'}
				anchor={chip.budget}
				label="Spawn budget"
				onOpen={() => {
					setBudget(slots())
					setOpen('budget')
				}}
				onCancel={() => setBudget(slots())}
				onClose={() => {
					if (open() === 'budget' && budget() !== slots()) run(`/budget ${budget()}`)
					setOpen(undefined)
				}}
			>
				<div class="head">
					<strong class="title">Spawn budget</strong>
				</div>
				<p class="desc">How many subagents this session may spawn in total, theirs included.</p>
				<form
					class="field step"
					onSubmit={(e) => {
						e.preventDefault()
						e.currentTarget.closest<HTMLElement>('[popover]')!.hidePopover()
					}}
				>
					<label class="input">
						<input
							type="number"
							inputmode="numeric"
							min="0"
							aria-label="Spawn budget"
							value={budget()}
							onInput={(e) => setBudget(Math.max(0, Math.floor(e.currentTarget.valueAsNumber) || 0))}
						/>
					</label>
					<button type="button" aria-label="One less" onClick={() => step(-1)}>
						<Icon name="minus" />
					</button>
					<button type="button" aria-label="One more" onClick={() => step(1)}>
						<Icon name="plus" />
					</button>
				</form>
			</Panel>
			<Panel
				id="panel-quota"
				open={open() === 'quota'}
				anchor={chip.quota}
				label="Quota"
				onOpen={() => setOpen('quota')}
				onClose={shut}
			>
				<div class="head">
					<strong class="title">Quota</strong>
					<span class="sub">{slot()}</span>
				</div>
				<div class="quotas">
					<For each={names_()}>
						{(name) => (
							<>
								<span>{name}</span>
								<Ring windows={[win(name)]} size={16} />
								<span class={heat(win(name)?.used)}>{win(name)?.used}% used</span>
								<span class="resets">{win(name)?.resets ? `Resets ${status.reset(win(name)!.resets!)}` : ''}</span>
							</>
						)}
					</For>
				</div>
			</Panel>
			<Panel
				id="panel-menu"
				open={open() === 'menu'}
				anchor={chip.menu}
				label="Session menu"
				onOpen={() => setOpen('menu')}
				onClose={shut}
			>
				<div class="head">
					<strong class="title">{meta()?.name ?? (meta() ? names.fallback(meta()!.id) : 'Connecting')}</strong>
				</div>
				<div class="group">
					{[meta()?.id, cwd(), meta() && model(true), meta()?.autoclose && 'autoclose on'].filter(Boolean).join(' · ')}
				</div>
				<button
					type="button"
					class="row"
					onClick={() => {
						// iOS opens the keyboard only for focus inside the tap.
						setOpen(undefined)
						flush()
						find.open()
						flush()
					}}
				>
					<Icon name="google" />
					Find
				</button>
				<button type="button" class="row" onClick={() => run('/fork')}>
					<Icon name="fork" />
					Fork
				</button>
				<button
					type="button"
					class="row"
					onClick={() => {
						setOpen(undefined)
						setAlerts(true)
					}}
				>
					<Icon name="bell" />
					Notifications
				</button>
				<button
					type="button"
					class="row"
					onClick={() => {
						// Closing first returns focus to the menu button, where the
						// details dialog then returns it.
						setOpen(undefined)
						flush()
						details.showModal()
					}}
				>
					<Icon name="info" />
					Session details
				</button>
				<button
					type="button"
					class="row status-hot"
					onClick={() => {
						setOpen(undefined)
						if (meta()) tabs.closeTab(meta()!.id)
					}}
				>
					<Icon name="close" />
					Close tab
				</button>
			</Panel>
			<Notifications open={alerts()} onClose={() => setAlerts(false)} />
			<dialog
				ref={(e) => (details = e)}
				class="StatusDetails plain"
				aria-label="Session details"
				onClick={(e) => {
					let r = details.getBoundingClientRect()
					if (
						e.target === details &&
						(e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
					)
						details.close()
				}}
				onKeyDown={(e) => e.stopPropagation()}
			>
				<div class="top">
					<strong class="title">Session details</strong>
					<button type="button" class="close" aria-label="Close session details" onClick={() => details.close()}>
						<Icon name="close" />
					</button>
				</div>
				<div class="body">
					<p class={['fact', tone()]}>{line().text}</p>
					<For each={status.groups(props.view)} keyed={false}>
						{(group) => (
							<div class="fact">
								{group().href ? (
									<a href={group().href}>
										<Parts group={group()} />
									</a>
								) : (
									<Parts group={group()} />
								)}
							</div>
						)}
					</For>
				</div>
				<form method="post" action="/logout" class="footer">
					<button type="submit">
						<Icon name="logout" />
						Log out this browser
					</button>
				</form>
			</dialog>
		</div>
	)
}

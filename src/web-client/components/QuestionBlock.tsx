import { createSignal, For, Match, onSettled, Show, Switch } from 'solid-js'
import type { AnswerValue, QuestionInput } from '../../common/history.ts'
import type { ProjectedQuestion } from '../../common/history-projection.ts'
import { webQuestion } from '../utils/question.ts'
import { webTranscript } from '../utils/transcript.ts'

type QuestionBlockProps = {
	question: ProjectedQuestion
	onAnswer: (questionId: string, value: AnswerValue) => Promise<boolean>
}

export function QuestionBlock(props: QuestionBlockProps) {
	let editor: HTMLInputElement | HTMLTextAreaElement | undefined
	let firstControl: HTMLElement | undefined
	let sending = false
	const [submitting, setSubmitting] = createSignal(false)
	const [error, setError] = createSignal('')
	const [secretBytes, setSecretBytes] = createSignal(0)

	function choiceInput(): Extract<QuestionInput, { kind: 'choice' }> | undefined {
		const input = props.question.input
		return input.kind === 'choice' ? input : undefined
	}
	function textInput(): Extract<QuestionInput, { kind: 'text' }> | undefined {
		const input = props.question.input
		return input.kind === 'text' ? input : undefined
	}
	function secretInput(): Extract<QuestionInput, { kind: 'secret' }> | undefined {
		const input = props.question.input
		return input.kind === 'secret' ? input : undefined
	}
	function titleId(): string {
		return `question-${props.question.id}-title`
	}

	onSettled(() => firstControl?.focus())

	async function submit(value: string): Promise<void> {
		if (sending) return
		sending = true
		setSubmitting(true)
		setError('')
		let sent = false
		try {
			const answer = await webQuestion.prepareAnswer(props.question, value)
			// Once encrypted, do not retain secret plaintext while the ciphertext is sent.
			if (props.question.input.kind === 'secret' && editor) {
				editor.value = ''
				setSecretBytes(0)
			}
			sent = await props.onAnswer(props.question.id, answer)
			if (!sent) setError('Connection unavailable. Try again.')
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : 'Could not send the answer. Try again.')
		} finally {
			// A successful submission stays disabled until the authoritative snapshot
			// replaces this question. This prevents double-clicks from racing answers.
			if (!sent) {
				sending = false
				setSubmitting(false)
			}
		}
	}

	function submitEditor(event: SubmitEvent): void {
		event.preventDefault()
		void submit(editor?.value ?? '')
	}

	return <article
		class={['QuestionBlock', props.question.active ? 'active' : 'compact']}
		aria-labelledby={titleId()}
		aria-busy={submitting() ? 'true' : 'false'}
	>
		<header>
			<strong id={titleId()}>{props.question.text}</strong>
			<Show when={props.question.progress}>
				{(progress) => <span>Approval {progress().index} of {progress().total}</span>}
			</Show>
		</header>
		<Show when={props.question.tool}>
			{(tool) => <details open={props.question.active}>
				<summary>{tool().name}</summary>
				<Show when={tool().input !== undefined}><pre>{webTranscript.valueText(tool().input)}</pre></Show>
			</details>}
		</Show>
		<Show when={props.question.active} fallback={<p class="QuestionBlock-answer">{webQuestion.answerText(props.question)}</p>}>
			<Switch>
				<Match when={choiceInput()}>
					{(input) => <fieldset disabled={submitting()}>
						<legend>Choose an answer</legend>
						<For each={input().choices}>{(choice) => <button
							type="button"
							ref={(element) => { firstControl ??= element }}
							onClick={() => void submit(choice.id)}
						>
							<strong>{choice.label}</strong>
							<Show when={choice.description}><span>{choice.description}</span></Show>
						</button>}</For>
					</fieldset>}
				</Match>
				<Match when={textInput()}>
					{(input) => <form onSubmit={submitEditor}>
						<label for={`question-${props.question.id}-text`}>Your answer</label>
						<textarea
							id={`question-${props.question.id}-text`}
							ref={(element) => { editor = element; firstControl = element }}
							rows={3}
							placeholder={input().placeholder}
							disabled={submitting()}
							required={!input().allowEmpty}
						/>
						<button type="submit" disabled={submitting()}>{submitting() ? 'Sending…' : 'Answer'}</button>
					</form>}
				</Match>
				<Match when={secretInput()}>
					{(input) => <form onSubmit={submitEditor}>
						<label for={`question-${props.question.id}-secret`}>Secret answer</label>
						<input
							id={`question-${props.question.id}-secret`}
							ref={(element) => { editor = element; firstControl = element }}
							type="password"
							autocomplete="one-time-code"
							spellcheck={false}
							placeholder={input().placeholder}
							disabled={submitting()}
							required
							aria-describedby={`question-${props.question.id}-bytes`}
							onInput={(event) => setSecretBytes(webQuestion.byteLength(event.currentTarget.value))}
						/>
						<small id={`question-${props.question.id}-bytes`} class={{ exceeded: secretBytes() > input().maxBytes }}>
							{secretBytes()} / {input().maxBytes} bytes
						</small>
						<button type="submit" disabled={submitting() || secretBytes() > input().maxBytes}>{submitting() ? 'Encrypting…' : 'Send secret'}</button>
					</form>}
				</Match>
			</Switch>
			<Show when={error()}><p class="QuestionBlock-error" role="alert">{error()}</p></Show>
		</Show>
	</article>
}

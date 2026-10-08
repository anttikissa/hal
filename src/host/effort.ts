// One overridable provider AND model capability/wire hook (task w7).
import { effort as vocabulary, type EffortCapability, type EffortLevel } from '../common/effort.ts'
import { blocks } from '../common/blocks.ts'
import { provider as registry } from './provider.ts'

export type Capability = EffortCapability & { wire(level: EffortLevel, maxTokens?: number): Record<string, unknown> }
const adaptive = (levels: EffortLevel[], defaultLevel: EffortLevel): Capability => ({
	levels, default: defaultLevel,
	wire: (level) => ({ thinking: { type: 'adaptive' }, output_config: { effort: level } }),
})
const responses = (levels: EffortLevel[], defaultLevel: EffortLevel = 'medium'): Capability => ({ levels, default: defaultLevel, wire: (level) => ({ reasoning: { summary: 'auto', effort: level } }) })
const standard: EffortLevel[] = ['low', 'medium', 'high']
const frontier: EffortLevel[] = [...standard, 'xhigh', 'max']

function capability(provider: string, model: string): Capability | undefined {
	let supplied = registry.state.providers[provider]?.capability?.(model)
	if (supplied) return supplied
	if (provider === 'openai') {
		if (/^gpt-(6\.1-sol|6-astra)(?:-\d{4}-\d{2}-\d{2})?$/.test(model)) return responses(frontier)
		if (/^gpt-6-(sol|luna)(?:-\d{4}-\d{2}-\d{2})?$/.test(model)) return responses(['none', ...frontier])
		if (/^gpt-5(?:-mini|-nano)?(?:-\d{4}-\d{2}-\d{2})?$/.test(model)) return responses(['minimal', ...standard])
		if (/^gpt-5\.1$/.test(model)) return responses(['none', ...standard], 'none')
		if (/^gpt-5(?:\.1)?-codex(?:-mini)?$/.test(model)) return responses(standard)
		if (/^gpt-5\.1-codex-max$|^gpt-5\.[23]-codex$/.test(model)) return responses([...standard, 'xhigh'])
		if (/^gpt-5\.[24]$/.test(model)) return responses(['none', ...standard, 'xhigh'], 'none')
		if (/^gpt-5\.5$/.test(model)) return responses(['none', ...standard, 'xhigh'])
		if (/^gpt-5\.6(?:-(sol|terra|luna))?$/.test(model)) return responses(['none', ...frontier])
		if (/^(o1|o3|o3-mini|o4-mini)(?:-\d{4}-\d{2}-\d{2})?$/.test(model)) return responses(standard)
	}
	if (provider === 'anthropic') {
		if (/^claude-(opus|sonnet)-5-5(?:-\d{8})?$/.test(model)) return adaptive(frontier, model.includes('opus') ? 'medium' : 'high')
		if (/^claude-(opus-4-[78]|opus-5|sonnet-5|fable-5(?:-1)?)(?:-\d{8})?$/.test(model)) return adaptive(frontier, 'high')
		if (/^claude-(opus|sonnet)-4-6(?:-\d{8})?$/.test(model)) return adaptive([...standard, 'max'], 'high')
		if (/^claude-(opus-4(?:-[15])?|sonnet-4(?:-5)?|sonnet-3-7)(?:-\d{8})?$/.test(model)) return {
			levels: ['none', ...standard],
			wire(level, maxTokens = 64_000) {
				if (level === 'none') return { thinking: { type: 'disabled' } }
				let budget = { low: 1024, medium: 4096, high: 10_000 }[level as 'low' | 'medium' | 'high']
				if (budget >= maxTokens) throw new Error(`Thinking budget ${budget} must be below max_tokens ${maxTokens}`)
				return { thinking: { type: 'enabled', budget_tokens: budget }, ...(model.startsWith('claude-opus-4-5') && { output_config: { effort: level } }) }
			},
		}
	}
	if (provider === 'ollama' && /^gpt-oss(?::[^:]+)?$/.test(model)) return { levels: standard, wire: (level) => ({ reasoning_effort: level }) }
	if (provider === 'opencode-go' && model === 'glm-5.2') return { levels: ['high', 'max'], wire: (level) => ({ reasoning_effort: level }) }
	return undefined
}

function describe(id: string): EffortCapability | undefined {
	let parsed = blocks.parseModelId(id)
	let cap = parsed && effort.capability(parsed.provider, parsed.model)
	return cap ? { levels: cap.levels, ...(cap.default && { default: cap.default }), ...(cap.policy && { policy: cap.policy }) } : undefined
}
function validate(id: string, level: string): EffortLevel {
	let cap = effort.describe(id)
	if (!cap?.levels.includes(level as EffortLevel)) throw new Error(`${id}: unsupported effort '${level}'; allowed: ${cap?.levels.join(', ') || 'default only (no verified effort control)'}`)
	return level as EffortLevel
}
// The supported level nearest `asked` by rank (none 0 … max 6), ties
// rounding up. A chosen level is kept even when it matches the default
// Hal knows: the backend's real default may differ (Codex gives GPT-6.1
// Sol low). `note` says what changed (task 7vt).
function nearest(id: string, asked: string): { level?: EffortLevel; note?: string } {
	let ultra = asked === 'ultra'
	let want = (ultra ? 'max' : asked) as EffortLevel
	let rank = vocabulary.levels.indexOf(want)
	if (rank < 0) throw new Error(`${id}: unknown effort '${asked}'; use default or ${effort.describe(id)?.levels.join(', ') || 'no verified effort control'}`)
	let cap = effort.describe(id)
	if (!cap?.levels.length) return { note: `${id} has no effort control; effort ${asked} dropped` }
	let level = vocabulary.closest(cap.levels, want)!
	let notes = [
		ultra && 'ultra → max (Hal has no Ultra mode; ask for subagents in the prompt)',
		level !== want && `${want} → ${level} (closest supported by ${id})`,
	].filter(Boolean)
	return { level, ...(notes.length && { note: notes.join('; ') }) }
}
function wire(provider: string, model: string, selected?: string, maxTokens?: number): Record<string, unknown> {
	let cap = effort.capability(provider, model)
	let level = selected ?? cap?.policy
	if (level === undefined) return {}
	effort.validate(`${provider}/${model}`, level)
	return cap!.wire(level as EffortLevel, maxTokens)
}
export const effort = { capability, describe, validate, nearest, wire, vocabulary: vocabulary.levels }

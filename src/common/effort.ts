// Browser-safe descriptions sent by the host; clients never infer support.
export type EffortLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type EffortCapability = { levels: EffortLevel[]; default?: EffortLevel; policy?: EffortLevel }
export const effort = {
	levels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as EffortLevel[],
	// A picker row's choice: the level, or 'default (<level>)' for the
	// model's default, its level named only here (task r7r).
	label(cap?: EffortCapability, selected?: string): string {
		let fallback = cap?.policy ?? cap?.default
		return selected && selected !== fallback ? selected : fallback ? `default (${fallback})` : 'default'
	},
}

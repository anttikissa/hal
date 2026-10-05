// Browser-safe descriptions sent by the host; clients never infer support.
export type EffortLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type EffortCapability = { levels: EffortLevel[]; default?: EffortLevel; policy?: EffortLevel }
export const effort = {
	levels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as EffortLevel[],
	// The level of `levels` nearest `want` by rank, ties rounding up
	// (task 7vt); `want` itself when supported.
	closest(levels: EffortLevel[], want: EffortLevel): EffortLevel | undefined {
		let rank = (l: EffortLevel) => effort.levels.indexOf(l)
		return [...levels].sort((a, b) => Math.abs(rank(a) - rank(want)) - Math.abs(rank(b) - rank(want)) || rank(b) - rank(a))[0]
	},
	// A picker row's choice: the level, or 'default (<level>)' for the
	// model's default, its level named only here (task r7r).
	label(cap?: EffortCapability, selected?: string): string {
		let fallback = cap?.policy ?? cap?.default
		return selected && selected !== fallback ? selected : fallback ? `default (${fallback})` : 'default'
	},
}

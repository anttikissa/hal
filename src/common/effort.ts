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
	// A picker row's choice: always the actual level; the picker title
	// names the model's default (task r7r).
	label(cap?: EffortCapability, selected?: string): string {
		return selected || cap?.policy || cap?.default || 'default'
	},
}

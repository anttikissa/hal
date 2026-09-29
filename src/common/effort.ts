// Browser-safe descriptions sent by the host; clients never infer support.
export type EffortLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type EffortCapability = { levels: EffortLevel[]; default?: EffortLevel; policy?: EffortLevel }
export const effort = {
	levels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as EffortLevel[],
	label(cap?: EffortCapability, selected?: string): string {
		return selected ?? (cap?.policy ? cap.policy : cap?.default ? `default (${cap.default})` : 'default/unknown')
	},
}

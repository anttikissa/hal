// Ask tool — definition only; execution is handled by agent-loop.

import { defineTool, previewField } from './tool.ts'

export const ask = defineTool({
	definition: {
		name: 'ask',
		description: 'Ask the user a question and wait for their response. Use this to clarify ambiguous instructions, gather preferences, or get decisions on implementation choices.',
		input_schema: {
			type: 'object' as const,
			properties: {
				question: { type: 'string', description: 'The question to ask the user' },
			},
			required: ['question'],
		},
	},
	argsPreview: (input: unknown) => previewField('question')(input).slice(0, 80),
	execute: () => 'error: ask tool must be called through agent loop',
})

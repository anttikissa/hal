// help: exact call syntax, collected from the tool modules themselves
// (nativeTool.help), never from a separate list (task 3fv).

import { nativeTool } from '../native-tool.ts'
import { type Tool, tools } from '../tools.ts'

export const tool: Tool = {
	name: 'help',
	syntax: { summary: false, positional: ['name'], usage: ['HELP', 'HELP <NAME>'] },
	description: 'Explain a tool: its syntax, fields, defaults and units. Without a name, list every tool with its syntax.',
	parameters: { type: 'object', properties: { name: { type: 'string', description: 'A tool name, e.g. EDIT' } } },
	readOnly: true,
	async run(input) {
		if (input.name !== undefined && typeof input.name !== 'string') throw new Error('name must be a tool name, e.g. HELP EDIT')
		if (input.name?.toLowerCase() === 'subagents') return [
			'SUBAGENTS: independently running sessions, coordinated like background commands.',
			'SPAWN starts one; background BASH starts a command. HELP SPAWN and HELP BASH show exact syntax.',
			'SPAWN kind subagent reports and closes after a clean finish; subagent-leave-open reports and stays open; interactive opens a tab for the user.',
			'fresh (default) gets only the task; fork copies the caller history. Each subagent costs one slot from every owner ancestor; slots do not return. Interactive sessions are free. HELP SPAWN explains limit; COMMAND "/budget" shows remaining slots.',
			'The host returns a subagent’s final message to its owner automatically, including failures and questions. A <question> keeps it open. Answer through SEND; HELP SEND explains delivery and steering.',
			'WAIT [targets...] yields until a command or session completes, fails, stops or needs an answer. Without targets, wait for any owned background work. Streaming output does not wake you. HELP WAIT shows syntax.',
			'INSPECT <target> shows status, available output and pending questions. STOP <target> stops the execution and its owned work recursively, retaining sessions, tabs, history and output. Ownership is not created by sending messages. HELP INSPECT and HELP STOP explain details.',
			'Targets are session IDs (12-xyz) or local tool-call references (t123 or 123). Bare numbers mean tool calls, never tabs.',
			'STOP acts as pause/restart for agents: COMMAND "/resume <session-id>" reopens the selected session if needed, then SEND further instructions with { delivery: "steer" } to restart the paused agent with preserved history. Ordinary SEND stays queued while paused. Interrupted tool calls and stopped descendants do not restart automatically. Commands must be started again.',
			'Esc pauses the current turn and interrupts foreground tools; background commands and subagents survive and are listed. COMMAND "/kill t123" stops one background command; COMMAND "/kill all" stops all background commands here without stopping the agent. COMMAND "/stop <target>" exposes recursive STOP to users.',
			'Stopping is not rollback: external effects may remain. Explicit STOP, like /kill and Esc, interrupts unsafeToStop calls too and warns that broken state may remain.',
		].join('\n\n')
		if (input.name) return nativeTool.help(nativeTool.find(input.name.toLowerCase()))
		let lines = [...tools.all().values()].flatMap((t) => nativeTool.usage(t))
		return [
			'One tool per call; make independent calls in parallel. Names are case-insensitive.',
			'Arguments are JS string literals, { objects } or [ arrays ] (never evaluated), or bare words on the call line.',
			'HELP <NAME> explains one tool.',
			'',
			...lines,
		].join('\n')
	},
}

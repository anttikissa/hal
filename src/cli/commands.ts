import type { Client } from "./client.ts"
import { logSnapshot, getDebugLogPath } from "../debug-log.ts"

type Handler = (args: string, client: Client) => Promise<void> | void

async function help(_args: string, client: Client): Promise<void> {
	client.log("local.help", `Commands: ${COMMAND_NAMES.map(c => "/" + c).join(" ")}`)
}

async function model(args: string, client: Client): Promise<void> {
	if (!args) {
		await client.command("model", "")
		client.log("local.queue", "model status")
		return
	}
	await client.command("model", args)
	client.log("local.queue", `model: ${args}`)
}

async function system(_args: string, client: Client): Promise<void> {
	await client.command("system")
	client.log("local.queue", "system prompt")
}

async function pause(_args: string, client: Client): Promise<void> {
	await client.command("pause")
	client.log("local.queue", "pause")
}

async function handoff(args: string, client: Client): Promise<void> {
	await client.command("handoff", args || undefined)
	client.log("local.queue", "handoff")
}

async function cd(args: string, client: Client): Promise<void> {
	await client.command("cd", args)
	client.log("local.queue", args ? `cd: ${args}` : "cd")
}

async function reset(args: string, client: Client): Promise<void> {
	if (args) { client.log("local.usage", "usage: /reset"); return }
	await client.command("reset")
	client.log("local.queue", "reset")
}

async function close(_args: string, client: Client): Promise<void> {
	await client.closeTab()
}

async function clear(_args: string, client: Client): Promise<void> {
	client.clear()
}

async function todo(args: string, client: Client): Promise<void> {
	if (!args) { client.log("local.usage", "usage: /todo <task description>"); return }
	await client.command("prompt", `[todo] ${args}`)
}

async function restart(_args: string, client: Client): Promise<void> {
	await client.command("restart")
	client.log("local.queue", "restart")
}

async function snapshot(_args: string, client: Client): Promise<void> {
	const terminal = client.getTranscript()
	logSnapshot(terminal)
	const path = getDebugLogPath()
	client.log("local.status", `[snapshot] terminal captured → ${path}`)
}

function exit(_args: string, _client: Client): void {}

const COMMANDS: Record<string, Handler> = {
	help, model, system, pause, handoff, cd, close, reset, clear, todo, restart, snapshot, exit,
}

const ALIASES: Record<string, string> = {
	bye: "exit", quit: "exit", q: "exit",
}

export const COMMAND_NAMES = Object.keys(COMMANDS)

export function isExit(normalized: string): boolean {
	if (!normalized.startsWith("/")) return false
	const name = normalized.slice(1).split(" ")[0]
	return (ALIASES[name] ?? name) === "exit"
}

export async function handleCommand(input: string, client: Client): Promise<void> {
	const trimmed = input.trim()
	if (!trimmed.startsWith("/")) {
		await client.command("prompt", input)
		return
	}

	const spaceIndex = trimmed.indexOf(" ")
	const name = spaceIndex < 0 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex)
	const args = spaceIndex < 0 ? "" : trimmed.slice(spaceIndex + 1).trim()

	const resolved = ALIASES[name] ?? name
	const handler = COMMANDS[resolved]
	if (!handler) {
		client.log("local.warn", `unknown command: /${name}`)
		return
	}

	await handler(args, client)
}

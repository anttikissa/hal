import type { RuntimeCommand, RuntimeEvent } from "../protocol.ts"

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

export function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "")
}

const DIM = "\x1b[2m"
const BOLD = "\x1b[1m"
const RED = "\x1b[31m"
const YELLOW = "\x1b[33m"
const CYAN = "\x1b[36m"
const RESET = "\x1b[0m"

const KIND_STYLE: Record<string, string> = {
	"chunk.assistant": "",
	"chunk.thinking": DIM,
	"line.info": DIM,
	"line.warn": YELLOW,
	"line.error": RED,
	"line.tool": CYAN,
	"line.status": DIM,
	prompt: BOLD,
	"command.failed": RED,
	"local.info": DIM,
	"local.warn": YELLOW,
	"local.error": RED,
	"local.status": DIM,
	"local.queue": DIM,
	"local.help": "",
	"local.usage": DIM,
	"local.tab": DIM,
	"local.tabs": DIM,
}

// Track prevKind per session so interleaved events from different sessions
// don't inject spurious newlines into each other's output.
const prevKindBySession = new Map<string, string>()
const LOCAL_KEY = "__local__"

export function resetFormat(sessionId?: string): void {
	if (sessionId) {
		prevKindBySession.delete(sessionId)
	} else {
		prevKindBySession.clear()
	}
}

export function pushFragment(kind: string, text: string, sessionId?: string | null): string {
	const key = sessionId ?? LOCAL_KEY
	const prev = prevKindBySession.get(key) ?? ""
	const continuing = kind === prev
	prevKindBySession.set(key, kind)

	const style = KIND_STYLE[kind] ?? ""
	const reset = style ? RESET : ""

	if (kind === "chunk.assistant" || kind === "chunk.thinking") {
		const prefix = continuing ? "" : "\n"
		return `${prefix}${style}${text}${reset}`
	}

	return `${style}${text}${reset}\n`
}

export function pushEvent(
	event: RuntimeEvent,
	localSource: RuntimeCommand["source"],
): string {
	const sessionId = "sessionId" in event ? event.sessionId : null

	if (event.type === "chunk") {
		return pushFragment(`chunk.${event.channel}`, event.text, sessionId)
	}

	if (event.type === "line") {
		return pushFragment(`line.${event.level}`, event.text, sessionId)
	}

	if (event.type === "prompt") {
		const local =
			event.source.kind === localSource.kind &&
			event.source.clientId === localSource.clientId
		const text = local
			? event.text
			: `[prompt:${event.source.kind}:${event.source.clientId.slice(0, 6)}] ${event.text}`
		return pushFragment("prompt", text, sessionId)
	}

	if (event.type === "command" && event.phase === "failed") {
		return pushFragment(
			"command.failed",
			`[command:${event.commandId}] ${event.message ?? "unknown"}`,
			sessionId,
		)
	}

	return ""
}

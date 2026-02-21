import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from "fs/promises"
import { existsSync } from "fs"
import type { RuntimeCommand, RuntimeEvent, RuntimeState } from "./protocol.ts"
import { IPC_DIR } from "./state.ts"
import { stringify, parse, parseAll, parseStream } from "./utils/ason.ts"
import { isPidAlive } from "./utils/is-pid-alive.ts"
import { tailFile } from "./utils/tail-file.ts"

let rootDir: string
let commandsFile: string
let eventsFile: string
let stateFile: string
let ownerFile: string
let stateWriteLock: Promise<void> = Promise.resolve()

function assertInit(): void {
	if (!rootDir) throw new Error("ipc bus not initialized — call initBus() first")
}

export function initBus(dir = IPC_DIR): void {
	rootDir = dir
	commandsFile = `${dir}/commands.ason`
	eventsFile = `${dir}/events.ason`
	stateFile = `${dir}/state.ason`
	ownerFile = `${dir}/owner.lock`
	stateWriteLock = Promise.resolve()
}

function defaultState(): RuntimeState {
	return {
		ownerPid: null,
		ownerId: null,
		busy: false,
		queueLength: 0,
		busySessionIds: [],
		activeSessionId: null,
		sessions: [],
		commandsOffset: 0,
		updatedAt: new Date().toISOString(),
	}
}

async function touch(path: string): Promise<void> {
	if (!existsSync(path)) await writeFile(path, "")
}

export async function ensureBus(): Promise<void> {
	assertInit()
	await mkdir(rootDir, { recursive: true })
	await touch(commandsFile)
	await touch(eventsFile)
	if (!existsSync(stateFile)) await writeState(defaultState())
}

export async function resetBusEvents(): Promise<void> {
	assertInit()
	// Keep last 500 events so clients can hydrate scroll history after owner restart
	const raw = await readFile(eventsFile, "utf-8").catch(() => "")
	const all = parseAll(raw) as RuntimeEvent[]
	if (all.length > 500) {
		const kept = all.slice(-500).map(e => stringify(e)).join("\n") + "\n"
		await writeFile(eventsFile, kept)
	}
	// If ≤500, leave as-is
}

export async function readState(): Promise<RuntimeState> {
	assertInit()
	try {
		const raw = await readFile(stateFile, "utf-8")
		return { ...defaultState(), ...parse(raw) }
	} catch {
		const fallback = defaultState()
		await writeState(fallback)
		return fallback
	}
}

export async function writeState(runtimeState: RuntimeState): Promise<void> {
	assertInit()
	const doWrite = async () => {
		const tmp = `${stateFile}.tmp.${process.pid}`
		runtimeState.updatedAt = new Date().toISOString()
		await writeFile(tmp, stringify(runtimeState) + "\n")
		await rename(tmp, stateFile)
	}
	stateWriteLock = stateWriteLock.then(doWrite, doWrite)
	await stateWriteLock
}

export async function updateState(mutator: (state: RuntimeState) => void): Promise<RuntimeState> {
	const state = await readState()
	mutator(state)
	await writeState(state)
	return state
}

export async function claimOwner(
	ownerId: string,
): Promise<{ owner: boolean; currentOwnerPid: number | null }> {
	assertInit()
	const payload = stringify({ ownerId, pid: process.pid, createdAt: new Date().toISOString() })

	const tryClaim = async (): Promise<boolean> => {
		try {
			const fh = await open(ownerFile, "wx")
			await fh.writeFile(payload)
			await fh.close()
			return true
		} catch (e: any) {
			if (e?.code === "EEXIST") return false
			throw e
		}
	}

	if (await tryClaim()) {
		await updateState((s) => { s.ownerPid = process.pid; s.ownerId = ownerId })
		return { owner: true, currentOwnerPid: process.pid }
	}

	let ownerPid: number | null = null
	try {
		const lockRaw = await readFile(ownerFile, "utf-8")
		const lock = parse(lockRaw) as any
		ownerPid = Number.isInteger(lock?.pid) ? lock.pid : null
	} catch {
		ownerPid = null
	}

	if (ownerPid !== null && isPidAlive(ownerPid)) {
		return { owner: false, currentOwnerPid: ownerPid }
	}

	// Stale lock — remove and retry
	try { await rm(ownerFile) } catch {}

	if (await tryClaim()) {
		await updateState((s) => { s.ownerPid = process.pid; s.ownerId = ownerId })
		return { owner: true, currentOwnerPid: process.pid }
	}

	const currentState = await readState()
	return { owner: false, currentOwnerPid: currentState.ownerPid }
}

export async function releaseOwner(ownerId: string): Promise<void> {
	assertInit()
	try {
		const raw = await readFile(ownerFile, "utf-8")
		const lock = parse(raw) as any
		if (lock?.ownerId !== ownerId) return
		await rm(ownerFile)
		await updateState((s) => {
			if (s.ownerId === ownerId) {
				s.ownerId = null
				s.ownerPid = null
				s.busy = false
				s.queueLength = 0
				s.busySessionIds = []
			}
		})
		// Notify clients so they can claim ownership immediately
		await appendEvent({
			id: `${Date.now()}-${process.pid}-release`,
			type: "line",
			sessionId: null,
			text: "[owner-released]",
			level: "status",
			createdAt: new Date().toISOString(),
		})
	} catch {}
}


export async function appendCommand(command: RuntimeCommand): Promise<void> {
	assertInit()
	await appendFile(commandsFile, stringify(command) + "\n")
}

export async function appendEvent(event: RuntimeEvent): Promise<void> {
	assertInit()
	await appendFile(eventsFile, stringify(event) + "\n")
}

export async function readRecentEvents(limit: number): Promise<RuntimeEvent[]> {
	assertInit()
	const raw = await readFile(eventsFile, "utf-8")
	const all = parseAll(raw) as RuntimeEvent[]
	return all.slice(-limit)
}

export async function *tailCommands(): AsyncGenerator<RuntimeCommand> {
	assertInit()
	const offset = (await stat(commandsFile)).size
	yield* parseStream(tailFile(commandsFile, offset), { recover: true })
}

export async function *tailEvents(): AsyncGenerator<RuntimeEvent> {
	assertInit()
	const offset = (await stat(eventsFile)).size
	yield* parseStream(tailFile(eventsFile, offset, { dropOnTruncate: true }), { recover: true })
}

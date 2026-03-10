// Command handlers — extracted from runtime.ts. Each receives the Runtime instance.

import type { Runtime } from './runtime.ts'
import { timeAgo } from './runtime.ts'
import type { RuntimeCommand } from '../protocol.ts'
import { createSession, loadMeta, listSessionIds, rotateLog, forkSession } from '../session/session.ts'
import { appendMessages, loadApiMessages, readMessages, writeToolResultEntry, detectInterruptedTools, parseUserContent, buildCompactionContext, type UserMessage } from '../session/messages.ts'
import { resolveModel } from '../models.ts'

export async function handleCommand(rt: Runtime, cmd: RuntimeCommand): Promise<void> {
	const sid = cmd.sessionId ?? rt.activeSessionId
	const warn = (text: string) => rt.emit({ type: 'line', sessionId: sid, text, level: 'warn' })
	const error = (text: string) => rt.emit({ type: 'line', sessionId: sid, text, level: 'error' })
	if (!sid) { await error('No active session'); return }

	switch (cmd.type) {
		case 'pause': {
			const ac = rt.abortControllers.get(sid)
			if (ac) ac.abort()
			else await warn('Session is not busy')
			break
		}
		case 'prompt': {
			if (!cmd.text) { await warn('Empty prompt'); return }
			if (!rt.sessions.has(sid)) { await error(`Session ${sid} not found`); return }
			if (rt.busySessionIds.has(sid)) { await warn('Session is busy'); return }

			// Auto-resolve interrupted tools before building API messages
			const interrupted = rt.pendingInterruptedTools.get(sid) ?? detectInterruptedTools(await readMessages(sid))
			if (interrupted.length > 0) {
				const toolRefMap = new Map(interrupted.map(t => [t.id, t.ref]))
				for (const t of interrupted) {
					const entry = await writeToolResultEntry(sid, t.id, '[interrupted — skipped]', toolRefMap)
					await appendMessages(sid, [entry])
				}
				rt.pendingInterruptedTools.delete(sid)
			}

			await rt.emit({ type: 'prompt', sessionId: sid, text: cmd.text, source: cmd.source })

			const { apiContent, logContent } = await parseUserContent(sid, cmd.text)
			const userMsg: UserMessage = { role: 'user', content: logContent, ts: new Date().toISOString() }
			await appendMessages(sid, [userMsg])

			const info = rt.sessions.get(sid)!
			info.lastPrompt = cmd.text.split('\n')[0].slice(0, 120)

			let apiMessages = await loadApiMessages(sid)

			// Autocompact at 70% context usage (uses real API token counts)
			const ctx = rt.sessionContext.get(sid)
			if (ctx && !ctx.estimated && ctx.used / ctx.max >= 0.70) {
				const usedPct = ctx.used / ctx.max
				const msgs = await readMessages(sid)
				const userMsgs = msgs.filter(m => m.role === 'user')
				const context = buildCompactionContext(sid, msgs)
				await appendMessages(sid, [
					{ type: 'compact', ts: new Date().toISOString() },
					{ role: 'user', content: context, ts: new Date().toISOString() } as UserMessage,
					{ role: 'user', content: logContent, ts: new Date().toISOString() } as UserMessage,
				])
				apiMessages = await loadApiMessages(sid)
				await rt.emitInfo(sid, `[autocompact] ${Math.round(usedPct * 100)}% → compacted (${userMsgs.length} prompts summarized)`, 'meta')
				rt.sessionContext.delete(sid) // will get fresh count from next API response
			}

			// Replace the last user message's content with parsed apiContent (includes base64 images)
			if (apiMessages.length > 0 && apiMessages[apiMessages.length - 1].role === 'user') {
				apiMessages[apiMessages.length - 1].content = apiContent
			}
			await rt.startGeneration(sid, info, apiMessages)
			break
		}
		case 'open': {
			const resumeId = cmd.text?.trim()
			let info
			if (resumeId) {
				info = loadMeta(resumeId)
				if (!info) {
					rt.emitInfo(sid, `[resume] session ${resumeId} not found`)
					break
				}
			} else {
				info = await createSession()
				rt.setFreshContext(info)
			}
			rt.sessions.set(info.id, info)
			rt.activeSessionId = info.id
			await rt.publish()
			if (!resumeId) await rt.greetSession(info.id)
			break
		}
		case 'fork': {
			const childId = await forkSession(sid)
			const childMeta = loadMeta(childId)
			if (!childMeta) { await error('Failed to create forked session'); break }
			rt.sessions.set(childId, childMeta)
			rt.activeSessionId = childId
			await appendMessages(childId, [
				{ role: 'user', content: `[system] Forked from session ${sid}.`, ts: new Date().toISOString() } as UserMessage,
			])
			await rt.emitInfo(sid, `[fork] forked ${sid} -> ${childId}`, 'meta')
			await rt.emitInfo(childId, `[fork] forked ${sid} -> ${childId}`, 'meta')
			await rt.publish()
			break
		}
		case 'close': {
			if (!rt.sessions.has(sid)) { await warn(`Session ${sid} not open`); return }
			const closing = rt.sessions.get(sid)!
			closing.closedAt = new Date().toISOString()
			;(closing as any).save?.()
			rt.sessions.delete(sid)
			if (rt.activeSessionId === sid) {
				rt.activeSessionId = rt.sessions.keys().next().value ?? null
			}
			if (rt.sessions.size === 0) {
				await rt.publish()
				process.exit(0)
			}
			await rt.publish()
			break
		}
		case 'reset': {
			const resetMsgs = await readMessages(sid)
			const oldLog = rt.sessions.get(sid)?.log ?? 'messages.asonl'
			const newLog = await rotateLog(sid)
			const info = rt.sessions.get(sid)
			if (info) info.log = newLog
			const forkEntry = (resetMsgs[0] as any)?.type === 'forked_from' ? [resetMsgs[0]] : []
			await appendMessages(sid, [
				...forkEntry,
				{ role: 'user', content: `[system] Session was reset. Previous conversation: ${oldLog}`, ts: new Date().toISOString() } as UserMessage,
			])
			await rt.emitInfo(sid, '[reset] conversation cleared', 'meta')
			break
		}
		case 'compact': {
			if (rt.busySessionIds.has(sid)) { await warn('Session is busy'); break }
			const msgs = await readMessages(sid)
			const userMsgs = msgs.filter((m: any) => m.role === 'user')
			if (userMsgs.length === 0) { await warn('[compact] nothing to compact'); break }
			const context = buildCompactionContext(sid, msgs)
			const oldLog = rt.sessions.get(sid)?.log ?? 'messages.asonl'
			const newLog = await rotateLog(sid)
			const info = rt.sessions.get(sid)
			if (info) info.log = newLog
			const forkEntry = (msgs[0] as any)?.type === 'forked_from' ? [msgs[0]] : []
			await appendMessages(sid, [
				...forkEntry,
				{ role: 'user', content: `[system] Session was manually compacted. Previous conversation: ${oldLog}`, ts: new Date().toISOString() } as UserMessage,
				{ role: 'user', content: context, ts: new Date().toISOString() } as UserMessage,
			])
			await rt.emitInfo(sid, `[compact] context compacted (${userMsgs.length} user messages summarized)`, 'meta')
			break
		}
		case 'topic': {
			if (!cmd.text) { await warn('/topic <name>'); return }
			const info = rt.sessions.get(sid)
			if (!info) { await error(`Session ${sid} not found`); return }
			info.topic = cmd.text
			await rt.publish()
			break
		}
		case 'model': {
			if (!cmd.text) { await warn('/model <provider/model-id>'); return }
			const info = rt.sessions.get(sid)
			if (!info) { await error(`Session ${sid} not found`); return }
			info.model = resolveModel(cmd.text)
			await rt.emitInfo(sid, `[model] ${info.model}`, 'meta')
			await rt.publish()
			break
		}
		case 'continue': {
			if (rt.busySessionIds.has(sid)) { await warn('Session is busy'); break }
			const info = rt.sessions.get(sid)
			if (!info) { await error(`Session ${sid} not found`); break }
			const pendingTools = rt.pendingInterruptedTools.get(sid) ?? []
			if (pendingTools.length > 0) {
				await warn('Interrupted tools are present. Use /respond skip before /continue')
				break
			}
			const apiMessages = await loadApiMessages(sid)
			if (!rt.hasPendingUserTurn(apiMessages)) {
				await warn('No interrupted user turn to continue')
				break
			}
			await rt.emitInfo(sid, '[continuing] interrupted response', 'meta')
			await rt.startGeneration(sid, info, apiMessages, 'continuing...')
			break
		}
		case 'resume': {
			const id = cmd.text?.trim()
			if (!id) {
				const all = await listSessionIds()
				const closed = all.filter(s => !rt.sessions.has(s))
				if (closed.length === 0) {
					await rt.emit({ type: 'line', sessionId: sid, text: 'No closed sessions', level: 'info' })
					break
				}
				const items: { id: string; topic?: string; lastPrompt?: string; sortTs?: string; msgCount: number }[] = []
				for (const cid of closed) {
					const m = loadMeta(cid)
					const msgs = await readMessages(cid)
					const msgCount = msgs.filter((e: any) => e.role).length
					if (m) items.push({ id: cid, topic: m.topic, lastPrompt: m.lastPrompt, sortTs: m.closedAt ?? m.updatedAt, msgCount })
					else items.push({ id: cid, msgCount })
				}
				items.sort((a, b) => (b.sortTs ?? '').localeCompare(a.sortTs ?? ''))
				const lines = items.slice(0, 20).map(s => {
					const label = s.topic || s.lastPrompt || ''
					const age = s.sortTs ? timeAgo(s.sortTs) : ''
					const count = s.msgCount > 0 ? `${s.msgCount} msgs` : ''
					const parts = [s.id.padEnd(8)]
					if (label) parts.push(label.slice(0, 50))
					if (count) parts.push(count)
					if (age) parts.push(age)
					return parts.join('  ')
				})
				const text = ['[resume] /resume <id> to reopen', ...lines].join('\n')
				await rt.emit({ type: 'line', sessionId: sid, text, level: 'info' })
				break
			}
			if (rt.sessions.has(id)) { await warn(`Session ${id} is already open`); break }
			const meta = await loadMeta(id)
			if (!meta) { await error(`Session ${id} not found`); break }
			rt.sessions.set(id, meta)
			rt.activeSessionId = id
			await rt.publish()
			break
		}
		case 'respond': {
			const pending = rt.pendingQuestions.get(sid)
			if (pending) {
				rt.pendingQuestions.delete(sid)
				const answer = cmd.text ?? ''
				await rt.emit({ type: 'answer', sessionId: sid, question: pending.question, text: answer })
				pending.resolve(answer)
				break
			}
			const answer = (cmd.text ?? '').trim().toLowerCase()
			if (answer && answer !== 'skip') {
				await warn('Reply with "skip" or leave blank to continue without rerunning interrupted tools')
				break
			}
			const interruptedTools = rt.pendingInterruptedTools.get(sid) ?? []
			if (interruptedTools.length > 0) {
				const toolRefMap = new Map(interruptedTools.map(t => [t.id, t.ref]))
				for (const t of interruptedTools) {
					const entry = await writeToolResultEntry(sid, t.id, '[interrupted — skipped by user]', toolRefMap)
					await appendMessages(sid, [entry])
				}
				await rt.emitInfo(sid, `[interrupted] ${interruptedTools.length} tool(s) marked skipped`, 'warn')
			}
			rt.pendingInterruptedTools.delete(sid)
			break
		}
		default:
			await error(`Unknown command: /${cmd.type}`)
	}
}

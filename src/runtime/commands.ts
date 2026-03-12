// Command handlers — extracted from runtime.ts. Each receives the Runtime instance.

import type { Runtime } from './runtime.ts'
import { runtimeCore } from './runtime.ts'
import type { RuntimeCommand, SessionInfo } from '../protocol.ts'
import { session } from '../session/session.ts'
import { history } from '../session/history.ts'
import { attachments } from '../session/attachments.ts'
import { models } from '../models.ts'
import { auth } from './auth.ts'
import { config } from '../config.ts'
import { promptAnalysis } from './prompt-analysis.ts'
import { resolve } from 'path'
import { existsSync } from 'fs'
import { homedir } from 'os'

export async function handleCommand(rt: Runtime, cmd: RuntimeCommand): Promise<void> {
	const sid = cmd.sessionId ?? rt.activeSessionId
	if (!sid) return
	const warn = (text: string) => rt.emitInfo(sid, text, 'warn')
	const error = (text: string) => rt.emitInfo(sid, text, 'error')

	switch (cmd.type) {
		case 'pause': {
			const pending = rt.pendingQuestions.get(sid)
			if (pending) {
				rt.pendingQuestions.delete(sid)
				rt.syncState()
				pending.resolve('')
			}
			const ac = rt.abortControllers.get(sid)
			if (ac) ac.abort()
			else if (!pending) await warn('Session is not busy')
			break
		}
		case 'prompt': {
			const promptText = cmd.text ?? ''
			if (!promptText) { await warn('Empty prompt'); return }
			if (!rt.sessions.has(sid)) { await error(`Session ${sid} not found`); return }
			if (rt.busySessionIds.has(sid)) { await warn('Session is busy'); return }

			// Auto-resolve interrupted tools before building API messages
			const interrupted = rt.pendingInterruptedTools.get(sid) ?? history.detectInterruptedTools(await history.readHistory(sid))
			if (interrupted.length > 0) {
				const toolBlobMap = new Map(interrupted.map(t => [t.id, t.blobId]))
				for (const t of interrupted) {
					const entry = await history.writeToolResultEntry(sid, t.id, '[interrupted — skipped]', toolBlobMap)
					await history.appendHistory(sid, [entry])
				}
				rt.pendingInterruptedTools.delete(sid)
			}

			await rt.emit({ type: 'prompt', sessionId: sid, text: promptText, source: cmd.source })

			const { apiContent, logContent } = await attachments.resolve(sid, promptText)
			await history.writeUserEntry(sid, logContent)

			const info = rt.sessions.get(sid)!
			info.lastPrompt = promptText.split('\n')[0].slice(0, 120)
			const model = info.model ?? config.getConfig().defaultModel
			await history.ensureModelEvent(sid, model)

			let apiMessages = await history.loadApiMessages(sid)

			// Autocompact at 70% context usage (uses real API token counts)
			const ctx = rt.sessionContext.get(sid)
			if (ctx && !ctx.estimated && ctx.used / ctx.max >= 0.70) {
				const usedPct = ctx.used / ctx.max
				const msgs = await history.readHistory(sid)
				const userMsgs = msgs.filter((m: any) => m.role === 'user')
				const context = history.buildCompactionContext(sid, msgs)
				await history.appendHistory(sid, [
					{ type: 'compact', ts: new Date().toISOString() },
					{ role: 'user', content: context, ts: new Date().toISOString() },
					{ role: 'user', content: logContent, ts: new Date().toISOString() },
				])
				apiMessages = await history.loadApiMessages(sid)
				await rt.emitInfo(sid, `[autocompact] ${Math.round(usedPct * 100)}% → compacted (${userMsgs.length} prompts summarized)`, 'meta')
				rt.sessionContext.delete(sid) // will get fresh count from next API response
			}

			// Replace the last user message's content with parsed apiContent (includes base64 images)
			if (apiMessages.length > 0 && apiMessages[apiMessages.length - 1].role === 'user') {
				apiMessages[apiMessages.length - 1].content = apiContent
			}
			// Fire prompt analysis in parallel (non-blocking)
			if (config.getConfig().debug) {
				const sessionId = sid
				const info_ = session.loadSessionInfo(sid)
				promptAnalysis.analyzePrompt(promptText, sessionId, info_?.workingDir).then(result => {
					if (result) rt.emitInfo(sessionId, promptAnalysis.formatAnalysis(promptText, result), 'info')
				}).catch(() => {})
			}
			await rt.startGeneration(sid, info, apiMessages)
			break
		}
		case 'open': {
			const resumeId = cmd.text?.trim()
			let info
			if (resumeId) {
				info = session.loadSessionInfo(resumeId)
				if (!info) {
					rt.emitInfo(sid, `[resume] session ${resumeId} not found`)
					break
				}
			} else {
				info = await session.createSession()
				rt.setFreshContext(info)
			}
			rt.sessions.set(info.id, info)
			rt.activeSessionId = info.id
			if (!resumeId) await rt.greetSession(info.id)
			await rt.publish()
			break
		}
		case 'fork': {
			const childId = await session.forkSession(sid)
			const childMeta = session.loadSessionInfo(childId)
			if (!childMeta) { await error('Failed to create forked session'); break }
			// Insert child right after parent in session order
			const ordered = new Map<string, SessionInfo>()
			for (const [id, info] of rt.sessions) {
				ordered.set(id, info)
				if (id === sid) ordered.set(childId, childMeta)
			}
			rt.sessions = ordered
			rt.activeSessionId = childId
			await history.appendHistory(childId, [
				{ role: 'user', content: `[system] Forked from session ${sid}.`, ts: new Date().toISOString() },
			])
			await rt.emitInfo(sid, `[fork] forked ${sid} -> ${childId}`, 'meta')
			await rt.emitInfo(childId, `[fork] forked ${sid} -> ${childId}`, 'meta')
			await rt.publish()
			break
		}
		case 'close': {
			if (!rt.sessions.has(sid)) { await warn(`Session ${sid} not open`); return }
			const ac = rt.abortControllers.get(sid)
			if (ac) ac.abort()
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
			const resetMsgs = await history.readHistory(sid)
			const oldLog = rt.sessions.get(sid)?.log ?? 'history.asonl'
			const newLog = await session.rotateLog(sid)
			const info = rt.sessions.get(sid)
			if (info) info.log = newLog
			const forkEntry = (resetMsgs[0] as any)?.type === 'forked_from' ? [resetMsgs[0]] : []
			await history.appendHistory(sid, [
				...forkEntry,
				{ role: 'user', content: `[system] Session was reset. Previous conversation: ${oldLog}`, ts: new Date().toISOString() },
			])
			await rt.emitInfo(sid, '[reset] conversation cleared', 'meta')
			break
		}
		case 'compact': {
			if (rt.busySessionIds.has(sid)) { await warn('Session is busy'); break }
			const msgs = await history.readHistory(sid)
			const userMsgs = msgs.filter((m: any) => m.role === 'user')
			if (userMsgs.length === 0) { await warn('[compact] nothing to compact'); break }
			const context = history.buildCompactionContext(sid, msgs)
			const oldLog = rt.sessions.get(sid)?.log ?? 'history.asonl'
			const newLog = await session.rotateLog(sid)
			const info = rt.sessions.get(sid)
			if (info) info.log = newLog
			const forkEntry = (msgs[0] as any)?.type === 'forked_from' ? [msgs[0]] : []
			await history.appendHistory(sid, [
				...forkEntry,
				{ role: 'user', content: `[system] Session was manually compacted. Previous conversation: ${oldLog}`, ts: new Date().toISOString() },
				{ role: 'user', content: context, ts: new Date().toISOString() },
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
			if (!cmd.text) {
				const lines = models.listModels(p => !!auth.getAuth(p).accessToken)
				await rt.emitInfo(sid, lines.join('\n'), 'info')
				return
			}
			const info = rt.sessions.get(sid)
			if (!info) { await error(`Session ${sid} not found`); return }
			const oldModel = info.model ?? config.getConfig().defaultModel
			const newModel = models.resolveModel(cmd.text)
			info.model = newModel
			if (newModel !== oldModel) {
				await history.appendHistory(sid, [{ type: 'session', action: 'model-change', old: oldModel, new: newModel, ts: new Date().toISOString() }])
			}
			await rt.emitInfo(sid, `[model] ${info.model}`, 'meta')
			await rt.publish()
			break
		}
		case 'continue': {
			if (rt.busySessionIds.has(sid)) { await warn('Session is busy'); break }
			const info = rt.sessions.get(sid)
			if (!info) { await error(`Session ${sid} not found`); break }
			// Auto-resolve interrupted tools
			const pendingTools = rt.pendingInterruptedTools.get(sid) ?? history.detectInterruptedTools(await history.readHistory(sid))
			if (pendingTools.length > 0) {
				const toolBlobMap = new Map(pendingTools.map(t => [t.id, t.blobId]))
				for (const t of pendingTools) {
					const entry = await history.writeToolResultEntry(sid, t.id, '[interrupted — skipped]', toolBlobMap)
					await history.appendHistory(sid, [entry])
				}
				rt.pendingInterruptedTools.delete(sid)
				await rt.emitInfo(sid, `[interrupted] ${pendingTools.length} tool(s) skipped`, 'warn')
			}
			const model = info.model ?? config.getConfig().defaultModel
			await history.ensureModelEvent(sid, model)
			const apiMessages = await history.loadApiMessages(sid)
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
				const all = await session.listSessionIds()
				const closed = all.filter(s => !rt.sessions.has(s))
				if (closed.length === 0) {
					await rt.emit({ type: 'line', sessionId: sid, text: 'No closed sessions', level: 'info' })
					break
				}
				const items: { id: string; topic?: string; lastPrompt?: string; sortTs?: string; msgCount: number }[] = []
				for (const cid of closed) {
					const m = session.loadSessionInfo(cid)
					const msgs = await history.readHistory(cid)
					const msgCount = msgs.filter((e: any) => e.role).length
					if (m) items.push({ id: cid, topic: m.topic, lastPrompt: m.lastPrompt, sortTs: m.closedAt ?? m.updatedAt, msgCount })
					else items.push({ id: cid, msgCount })
				}
				items.sort((a, b) => (b.sortTs ?? '').localeCompare(a.sortTs ?? ''))
				const lines = items.slice(0, 20).map(s => {
					const label = s.topic || s.lastPrompt || ''
					const age = s.sortTs ? runtimeCore.timeAgo(s.sortTs) : ''
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
			const meta = await session.loadSessionInfo(id)
			if (!meta) { await error(`Session ${id} not found`); break }
			rt.sessions.set(id, meta)
			rt.activeSessionId = id
			await rt.publish()
			break
		}
		case 'respond': {
			const pending = rt.pendingQuestions.get(sid)
			if (!pending) {
				await warn('No pending question')
				break
			}
			rt.pendingQuestions.delete(sid)
			rt.syncState()
			const answer = cmd.text ?? ''
			await rt.emit({ type: 'answer', sessionId: sid, question: pending.question, text: answer })
			pending.resolve(answer)
			break
		}
		case 'cd': {
			const info = rt.sessions.get(sid)
			if (!info) { await error(`Session ${sid} not found`); break }
			if (!cmd.text?.trim()) {
				await rt.emitInfo(sid, `[cd] ${info.workingDir}`, 'info')
				break
			}
			const raw = cmd.text.trim().replace(/^~(?=$|\/)/, homedir())
			const target = resolve(info.workingDir, raw)
			if (!existsSync(target)) { await error(`[cd] ${target}: not found`); break }
			const old = info.workingDir
			info.workingDir = target
			await history.appendHistory(sid, [
				{ type: 'session', action: 'cd', old, new: target, ts: new Date().toISOString() },
			])
			if (!rt.busySessionIds.has(sid)) {
				await rt.emitInfo(sid, `[cd] ${old} → ${target}`, 'meta')
				const { systemPrompt } = await import('./system-prompt.ts')
				const agents = systemPrompt.collectAgentFiles(target)
				if (agents.length > 0) {
					const parts = agents.map(f => `${f.name} (${systemPrompt.formatBytes(f.bytes)})`)
					await rt.emitInfo(sid, `[agents] ${parts.join(', ')}`, 'meta')
				}
			}
			await rt.publish()
			break
		}
		default:
			await error(`Unknown command: /${cmd.type}`)
	}
}

export const commandHandlers = { handleCommand }

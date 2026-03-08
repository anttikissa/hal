import { appendCommand, readRecentEvents, readState, tailEvents } from './ipc.ts'
import { makeCommand, type RuntimeCommand } from './protocol.ts'
import { stringify } from './utils/ason.ts'

function sseEvent(value: any): string {
	const lines = stringify(value).split('\n')
	return lines.map((l) => `data: ${l}`).join('\n') + '\n\n'
}

function htmlPage() {
	return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>HAL</title>
  <style>
    :root {
      --bg: #f4f2eb; --panel: #fffdf7; --ink: #1b1e24; --muted: #6f7278;
      --line: #d7d1c0; --accent: #155eef; --danger: #b42318; --warn: #b54708;
      --thinking: #7a7f87; --mono: "Iosevka", "IBM Plex Mono", "SF Mono", "Menlo", monospace;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; font-family: var(--mono); color: var(--ink);
      background: radial-gradient(circle at 10% 10%, #fff 0, #f4f2eb 40%, #ece6d7 100%);
      min-height: 100vh; display: grid; place-items: center; padding: 20px;
    }
    .app { width: min(1100px, 100%); height: min(90vh, 900px); display: grid; grid-template-rows: auto 1fr auto; gap: 12px; }
    .topbar, .composer, .stream {
      background: var(--panel); border: 1px solid var(--line); border-radius: 14px;
      box-shadow: 0 14px 40px rgba(15,23,42,0.07);
    }
    .topbar { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; font-size: 13px; }
    .status { color: var(--muted); }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    button {
      border: 1px solid var(--line); background: #fff; padding: 8px 10px; border-radius: 10px;
      font-family: inherit; font-size: 12px; cursor: pointer; transition: transform 100ms ease;
    }
    button:hover { transform: translateY(-1px); border-color: #a8a08c; }
    button.warn { color: var(--warn); } button.danger { color: var(--danger); }
    .stream { padding: 14px; overflow: auto; white-space: pre-wrap; line-height: 1.45; font-size: 13px; }
    .line.warn { color: var(--warn); } .line.error { color: var(--danger); }
    .line.status { color: #0e53cc; } .line.tool { color: var(--muted); }
    .chunk.thinking { color: var(--thinking); } .line.prompt { color: var(--accent); font-weight: 600; }
    .composer { padding: 10px; display: grid; grid-template-columns: 1fr auto; gap: 10px; }
    textarea {
      width: 100%; resize: vertical; min-height: 84px; max-height: 240px;
      border: 1px solid var(--line); border-radius: 10px; padding: 10px;
      font-family: inherit; font-size: 13px; background: #fffcf2;
    }
    .send { background: var(--accent); color: white; border-color: var(--accent); align-self: end; height: 42px; min-width: 110px; }
  </style>
</head>
<body>
  <main class="app">
    <header class="topbar">
      <div class="status" id="status">connecting...</div>
      <div class="actions">
        <button id="pause" class="warn">Pause</button>
        <button id="handoff" class="warn">Handoff</button>
        <button id="restart" class="warn">Restart</button>
        <button id="reset" class="danger">Reset</button>
      </div>
    </header>
    <section id="stream" class="stream"></section>
    <form id="composer" class="composer">
      <textarea id="prompt" placeholder="Type a prompt..."></textarea>
      <button class="send" type="submit">Send</button>
    </form>
  </main>
  <script type="module">
    const streamEl = document.getElementById("stream")
    const statusEl = document.getElementById("status")
    const promptEl = document.getElementById("prompt")
    const clientId = localStorage.getItem("hal_client_id") || crypto.randomUUID()
    localStorage.setItem("hal_client_id", clientId)
    let activeSessionId = ""
    let runtimeBusy = false
    const escHtml = t => String(t??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")

    function appendEntry(e) {
      if (e.type==="chunk") streamEl.insertAdjacentHTML("beforeend",'<span class="chunk '+escHtml(e.channel||"assistant")+'">'+escHtml(e.text||"")+"</span>")
      else if (e.type==="line") streamEl.insertAdjacentHTML("beforeend",'<div class="line '+escHtml(e.level||"info")+'">'+escHtml(e.text||"")+"</div>")
      streamEl.scrollTop = streamEl.scrollHeight
    }

    async function send(type, text) {
      await fetch("/commands",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({type,text,clientId,sessionId:activeSessionId||null})})
    }

    document.getElementById("composer").addEventListener("submit",e=>{e.preventDefault();const t=promptEl.value;if(!t.trim())return;promptEl.value="";send("prompt",t)})
    document.getElementById("pause").addEventListener("click",()=>send("pause"))
    document.getElementById("handoff").addEventListener("click",()=>send("handoff"))
    document.getElementById("restart").addEventListener("click",()=>send("restart"))
    document.getElementById("reset").addEventListener("click",()=>send("reset"))

    const ev = new EventSource("/events")
    ev.onopen = () => { statusEl.textContent = "connected" }
    ev.onmessage = msg => {
      let event; try { event = JSON.parse(msg.data) } catch { return }
      if (event.type==="status") { runtimeBusy=!!event.busy; activeSessionId=event.activeSessionId||activeSessionId; statusEl.textContent=runtimeBusy?"busy":"idle"; return }
      if (event.type==="sessions") { if(event.activeSessionId) activeSessionId=event.activeSessionId; return }
      appendEntry(event)
    }
    ev.onerror = () => { statusEl.textContent = "reconnecting..." }

    ;(async()=>{try{const r=await fetch("/state");if(r.ok){const s=await r.json();runtimeBusy=!!s.busy;if(s.activeSessionId)activeSessionId=s.activeSessionId;statusEl.textContent=runtimeBusy?"busy":"idle"}}catch{}})()
  </script>
</body>
</html>`
}

export function startWebServer(port = 9001): ReturnType<typeof Bun.serve> {
	return Bun.serve({
		port,
		async fetch(req) {
			const url = new URL(req.url)

			if (url.pathname === '/') {
				return new Response(htmlPage(), {
					headers: { 'content-type': 'text/html; charset=utf-8' },
				})
			}

			if (url.pathname === '/state') {
				return Response.json(await readState())
			}

			if (url.pathname === '/commands' && req.method === 'POST') {
				let body: any
				try {
					body = await req.json()
				} catch {
					return new Response('invalid json', { status: 400 })
				}

				const type = String(body?.type || '') as RuntimeCommand['type']
				const text = typeof body?.text === 'string' ? body.text : undefined
				if (type === 'prompt' && !text?.trim())
					return new Response('prompt text required', { status: 400 })

				const clientId =
					typeof body?.clientId === 'string' && body.clientId.trim()
						? body.clientId.trim()
						: 'web'
				const sessionId =
					typeof body?.sessionId === 'string' && body.sessionId.trim()
						? body.sessionId.trim()
						: (await readState()).activeSessionId

				const command = makeCommand(type, { kind: 'web', clientId }, text, sessionId)
				await appendCommand(command)
				return Response.json({ ok: true, commandId: command.id })
			}

			if (url.pathname === '/events') {
				const stream = new ReadableStream({
					async start(controller) {
						let closed = false
						let heartbeat: ReturnType<typeof setInterval> | null = null

						const cleanup = () => {
							if (closed) return
							closed = true
							if (heartbeat) clearInterval(heartbeat)
							try {
								controller.close()
							} catch {}
						}

						const enqueue = (chunk: string): boolean => {
							if (closed) return false
							try {
								controller.enqueue(chunk)
								return true
							} catch {
								cleanup()
								return false
							}
						}

						enqueue('retry: 1000\n\n')

						const recent = await readRecentEvents(80)
						for (const event of recent) {
							if (!enqueue(sseEvent(event))) return
						}

						heartbeat = setInterval(() => {
							enqueue(': ping\n\n')
						}, 5000)
						req.signal.addEventListener('abort', cleanup, { once: true })

						void (async () => {
							try {
								for await (const event of tailEvents()) {
									if (closed) break
									if (!enqueue(sseEvent(event))) break
								}
							} catch {
							} finally {
								cleanup()
							}
						})()
					},
				})

				return new Response(stream, {
					headers: {
						'content-type': 'text/event-stream',
						'cache-control': 'no-cache',
						connection: 'keep-alive',
					},
				})
			}

			return new Response('not found', { status: 404 })
		},
	})
}

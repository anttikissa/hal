// Streams browser file attachments over HTTP POST /upload directly into
// staged files (blobs.stageStream), avoiding WebSocket base64 overhead.
// Cookie and same-origin checks are host/web.ts's job.

import { attachments } from '../common/attachments.ts'
import { blobs } from './blobs.ts'
import type { ClientInfo } from './clients.ts'
import { serverLog } from './server-log.ts'

async function receive(req: Request, url: URL, client: ClientInfo): Promise<Response> {
	let name = url.searchParams.get('name') ?? ''
	let sessionId = url.searchParams.get('session') ?? ''
	let mediaType = attachments.nameType(name)
	if (!mediaType) return Response.json({ error: `invalid file name ${JSON.stringify(name)}` }, { status: 400 })
	let max = attachments.limit(mediaType)
	let length = Number(req.headers.get('content-length'))
	if (Number.isFinite(length) && length > max)
		return Response.json({ error: `attachment larger than ${max / 1024 / 1024} MB` }, { status: 413 })
	if (!req.body) return Response.json({ error: 'attachment is empty' }, { status: 400 })
	try {
		let stored = await blobs.stageStream(name, req.body)
		serverLog.log(`${sessionId || '-'} upload ${stored.mediaType} ${Math.round(stored.bytes / 1024)} KB`, {
			...(client.address && { ip: client.address }),
			...(client.userAgent && { agent: client.userAgent }),
		})
		return Response.json({ blob: stored.blob, marker: stored.marker })
	} catch (e: any) {
		let error = String(e?.message ?? e)
		return Response.json({ error }, { status: error.includes('larger than') ? 413 : 400 })
	}
}

export const webUpload = { receive }

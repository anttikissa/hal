			}
			default:
				break
		}
	}

	flushAssistant()
	flushToolResults()
	repairToolPairing(out)
	return opts?.prune === false ? out : pruneMessages(out)
}

function buildUserContent(
	sessionId: string,
	entry: Extract<HistoryEntry, { type: 'user' }>,
	pendingInfos: string[],
): string | ContentBlock[] {
	const time = formatLocalTime(entry.ts)
	const prefix = [
		...(time ? [`[${time}]`] : []),
		...(entry.source ? [`[Inbox · ${entry.source}]`] : []),
		...pendingInfos,
	].join('\n')

	const onlyText = entry.parts.every((part) => part.type === 'text')
	if (onlyText) {
		const text = sessionEntry.userText(entry)
		return prefix ? `${prefix}\n${text}` : text
	}

	const blocks: ContentBlock[] = []
	if (prefix) blocks.push({ type: 'text', text: prefix })
	for (const part of entry.parts) {
		if (part.type === 'text') {
			blocks.push({ type: 'text', text: part.text })
			continue
		}
		const data = blob.readBlobFromChain(sessionId, part.blobId)
		if (data?.media_type && data?.data) {
			const image: ContentBlock = {
				type: 'image',
				source: { type: 'base64', media_type: data.media_type, data: data.data },
			}
			state.blockBlobs.set(image, part.blobId)
			blocks.push(image)
		} else {
			blocks.push({ type: 'text', text: `[image unavailable — blob ${part.blobId}]` })
		}
	}
	return blocks
}

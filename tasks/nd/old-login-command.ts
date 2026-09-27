		usageBars: true,
		handled: true,
	}
}

// /login <provider> — Claude returns its code through a durable secret question;
// ChatGPT uses OpenAI's device-code flow, which works on remote and headless hosts.
// Users subscribe to Claude and ChatGPT, not to "Anthropic" and "OpenAI", so the
// product names are what we ask for. The company names stay as hidden aliases:
// they name the provider prefixes in model IDs and the API key env vars, so
// people will reasonably try them.
handlers['login'] = async (args, _session, hooks) => {
	const parts = args.trim().split(/\s+/).filter(Boolean)
	const provider = parts[0]
	const codeArg = parts.slice(1).join(' ')

	if (provider === 'claude' || provider === 'anthropic') {
		if (codeArg) return { error: 'Usage: /login claude', handled: true }
		const { url } = await authLogin.startAnthropic()
		return {
			output: ['Open this URL to log in to Claude:', '', url].join('\n'),
			question: {
				text: 'Paste the code#state value from the Claude redirect page.',
				input: { kind: 'secret', publicKey: serverKeys.publicKey(), maxBytes: 190 },
				source: { type: 'login', provider: 'anthropic' },
			},
			handled: true,
		}
	}

	if (provider === 'chatgpt' || provider === 'openai') {
		hooks.info?.('Starting ChatGPT device-code login (15min timeout)...')
		try {
			await authLogin.loginOpenai((msg) => hooks.info?.(msg))
			return { output: 'Logged in to ChatGPT. Run /status to see usage.', loginProvider: 'openai', handled: true }
		} catch (err: any) {
			return { error: `Login failed: ${err?.message ?? err}`, handled: true }
		}
	}

	// OpenCode Go is a subscription that hands out an API key, so there is no OAuth
	// round trip: the key is the whole credential. It travels through the same
	// encrypted secret question as Claude's code, which keeps it out of history and
	// works on remote hosts.
	if (provider === 'opencode' || provider === 'opencode-go') {
		if (codeArg) return { error: 'Usage: /login opencode', handled: true }
		return {
			output: 'Paste an OpenCode API key. A Go subscription key gets subscription usage in the status bar; any other OpenCode key bills per token.',
			question: {
				text: 'Paste your OpenCode API key.',
				input: { kind: 'secret', publicKey: serverKeys.publicKey(), maxBytes: 190 },
				source: { type: 'login', provider: 'opencode-go' },
			},
			handled: true,
		}
	}

	return { error: 'Usage: /login <claude|chatgpt|opencode>', handled: true }
}



# Durable questions

Hal uses transcript questions when trusted runtime code needs human input before
it can continue. They are ordinary session blocks, not terminal popups. The
Ctrl-M model picker remains an unrelated local overlay.

## History is the source of truth

Questions and answers are append-only entries in `history.asonl`:

```ason
{ type: question, id: q1, text: "...", input: {...}, source: {...} }
{ type: answer, questionId: q1, value: {...} }
```

`historyProjection.questions()` pairs them by ID. Answered questions render as
compact blocks, the first unanswered local question is active, and subsequent
questions stay hidden until their turn. `history-updated` only tells connected
clients to reload; reconnect and restart always reconstruct from history.
Questions and answers are UI/control state and are excluded from provider
messages.

A question has one input kind:

- `choice`: ordered choices; the first is initially selected. Yes/no is a normal
  two-choice question.
- `text`: non-secret multiline input.
- `secret`: masked input encrypted before it leaves the client.

Sources are a small trusted union: risky tool, built-in intro, or Claude login.
Models do not have a question tool; they ask conversationally and end their turn.

## Risky tool batches

The assistant response and all tool calls are persisted first. Hal analyzes the
whole batch before dispatching anything. If calls need approval, it appends one
existing `pending_tools` marker and every required question in tool-call order.
No tool in that batch—including safe calls—runs until all questions are answered.

`No` rejects only its linked call. `Yes` gives only that exact call
`approvedRisk`. Escape aborts the batch before dispatch and records interrupted
results for every call. Once all answers exist, the existing pending-tool
continuation executes allowed calls and resumes the provider. Unanswered batches
stay parked without a Promise or process and survive restart or tab close.

## Clients

The active tab's normal composer remains visible but disabled while its question
owns input. Terminal choice/text/secret editors live inside the history block;
web uses accessible buttons, textarea, or password input. Background questions
set a tab warning but never steal focus. Any attached IPC, remote terminal, or
authenticated web client may answer; the first valid history append wins.

## Secret-answer security

`state/server-keys.ason` contains the web bearer-token registry and persistent
P-256 key pair. It is mode `0600` under the mode-`0700` state directory and is
protected by `sensitive.ts`. Clients receive only the public key.

For each answer, the client generates an ephemeral P-256 ECDH key, derives an
AES-256-GCM key, and encrypts with a random IV. Authenticated additional data
binds the packet to its session and question IDs. History and the IPC command bus
contain ciphertext only; resolved blocks say that a secret was provided.

This protects against accidental disclosure when IPC/history/logs are inspected
for debugging and their contents might be sent to an LLM provider. It does not
protect against malicious code running as the same OS user, a compromised
browser/host, keylogging, or theft of both the ciphertext and private-key file.
Remote web use still requires HTTPS so an attacker cannot replace the public key.

`/login claude` is the first production secret question. Anthropic returns
`code#state`; the state is the PKCE verifier, so login can finish after a restart
without storing a separate OAuth transaction.

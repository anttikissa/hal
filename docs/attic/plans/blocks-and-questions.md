# Plan: blocks/ persistence + user questions

Date: 2026-03-07

## Two changes

### 1. blocks/ persistence with split writes

**Why:** Fork sharing (child inherits parent blocks without copying), log readability (tool outputs can be 10KB), and interrupted-tool detection for resume.

**Current new/ behavior:** Everything inline in messages.asonl — assistant text, thinking, tool input+result all in one entry, written atomically after all tools finish. If process dies mid-tool, nothing is persisted.

**Target behavior (matching old code's write order):**

```
# When model responds with tool_use:
1. Write assistant entry immediately (before tool execution)
   Log:  { role: 'assistant', text?, thinking: { ref, words }, tools: [{ id, name, ref }] }
   Block files:  blocks/<ref>.ason = { call: { name, input } }
                 blocks/<ref>.ason = { thinking, signature }

# As each tool finishes:
2. Update block file: add { result: { content } }
3. Append tool_result log entry: { role: 'tool_result', tool_use_id, ref, ts }
```

**Detecting interrupted tools on restart:**
- Assistant entry has `tools: [{ id, name, ref }]`
- Scan forward for matching `tool_result` entries
- Missing tool_result → tool was interrupted (or never started)
- Block file without `result` field confirms it

**Files to change:**
- `new/session/messages.ts` — add writeBlock/readBlock, makeBlockRef, writeAssistantEntry, writeToolResultEntry
- `new/runtime/agent-loop.ts` — split the write: assistant entry before tools, tool results individually
- `new/session/replay.ts` — read block files when replaying (for tool output)
- `new/state.ts` — add blocksDir helper

### 2. User questions (system → user prompts)

**Why:** On restart, when interrupted tools are detected, Hal should be able to ask the user what to do — not via special commands, but as a natural question. This is also useful generally (confirmations, clarifications).

**Design:**

A new event type `question` in the protocol:

```ts
| {
    id: string; type: 'question'; sessionId: string
    text: string           // freeform question text
    questionId: string     // for matching the answer
    createdAt: string
  }
```

The runtime emits a `question` event. The client renders it as an assistant message and waits for user input. When the user responds, a `respond` command is sent back:

```ts
// New command type
| 'respond'

// RuntimeCommand with type 'respond':
// text = user's answer, sessionId = session, plus questionId in metadata
```

The runtime receives the response and acts on it. For restart resume:

```
[restart detected, session 05-abc has 1 unfinished tool]
Hal: "I was interrupted while running `bash: git status`. The tool didn't finish. Should I rerun it, or skip and continue?"
User: "rerun it"
→ runtime reruns the tool, appends results, continues generation
```

The question/respond flow is generic — not tied to resume. Any part of the runtime can ask.

**Implementation:**

Simple version first — question is just a line event with a callback:

```ts
// In runtime, a pendingQuestion map:
const pendingQuestions = new Map<string, (answer: string) => void>()

async function askUser(sessionId: string, text: string): Promise<string> {
    const qid = randomId()
    return new Promise(resolve => {
        pendingQuestions.set(qid, resolve)
        emit({ type: 'question', sessionId, text, questionId: qid })
    })
}

// When 'respond' command arrives:
case 'respond': {
    const callback = pendingQuestions.get(cmd.questionId)
    if (callback) {
        pendingQuestions.delete(cmd.questionId)
        callback(cmd.text)
    }
}
```

Client-side: question events render like assistant text. The prompt accepts input normally. On submit, if there's a pending question, send `respond` instead of `prompt`.

**Files to change:**
- `new/protocol.ts` — add question event type, respond command type
- `new/runtime/runtime.ts` — askUser helper, respond handler, resume logic using askUser
- `new/cli/client.ts` — track pending questions, route input to respond when appropriate

## Order of work

1. blocks/ persistence (messages.ts + agent-loop.ts + replay.ts)
2. Interrupted session detection on startup (runtime.ts)
3. Question/respond protocol (protocol.ts)
4. askUser in runtime + resume flow (runtime.ts)
5. Client question handling (client.ts)
6. Tests

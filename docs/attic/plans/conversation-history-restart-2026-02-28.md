# Conversation history after restart/restore (2026-02-28)

## Problem

Conversation history is inconsistent in CLI tabs after app restart and after `/restore`.

## Findings

- Runtime only replays `conversation.ason` for the initial active session on startup (`replayConversation()` in `src/runtime/sessions.ts`).
- CLI bootstrap currently hydrates tab output from IPC `events.ason` only (`readRecentEvents(500)`), not from full `conversation.ason`.
- Owner startup trims IPC events to last 500 records (`resetBusEvents()`), so older prompt/chunk events disappear from hydration.
- `/restore` opens a tab but does not replay conversation; it only sends bootstrap `/cd`, so users can see only `[cd]` / `[system]` lines.

## Plan

1. Add shared helper in `src/session.ts` to derive replayable conversation events (user/assistant after latest reset/handoff).
2. Use that helper in runtime replay to avoid duplicate logic.
3. In CLI (`src/cli/client.ts`), build tab transcript directly from `conversation.ason`:
	- during startup bootstrap for all tabs
	- when opening a restored session tab
4. Add tests for the replay-slice helper to lock down reset/handoff behavior.
5. Update `docs/session.md` to describe CLI restore behavior accurately.

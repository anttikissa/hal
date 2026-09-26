# Notes from implementing ya

- The live check never ran: the copied auth.ason's token had expired,
  and the refresh got HTTP 400 invalid_grant. Refresh tokens rotate
  and can be used only once, so a copy shared with the old Hal breaks
  as soon as either side refreshes. The OAuth contract (headers,
  identity block, ?beta=true) is still unverified against the real API.
  Copy fresh credentials right before the first real request.
- The Hal shell tool refuses any bash command that mentions auth.ason.
  Put real checks in a script that goes through src/host/auth.ts, and
  print only event types and lengths, never secrets.
- The artifact's thinking budget, min(10000, MAX_TOKENS - 1), only
  works with its fixed 64k max_tokens. With a caller-supplied
  maxTokens, the API needs 1024 <= budget_tokens < max_tokens, so
  thinking is skipped when maxTokens is too small for it.
- redacted_thinking has no text: it is stored as a thinking block with
  signature `{"redacted": data}` and turned back into redacted_thinking
  on replay. Unsigned thinking, or thinking signed by another provider,
  is dropped rather than sent, because the API rejects it.
- The artifact's web_search server tool, usage logging and 429
  credential rotation were deliberately left out.

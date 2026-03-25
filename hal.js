import { createRequire } from "node:module";
var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};
var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// src/state.ts
import { mkdirSync, existsSync } from "fs";
import { resolve } from "path";
function ensureDir(dir) {
  if (!existsSync(dir))
    mkdirSync(dir, { recursive: true });
}
function ensureStateDir() {
  ensureDir(STATE_DIR);
  ensureDir(IPC_DIR);
}
var HAL_DIR, STATE_DIR, IPC_DIR;
var init_state = __esm(() => {
  HAL_DIR = process.env.HAL_DIR ?? resolve(import.meta.dir, "..");
  STATE_DIR = process.env.HAL_STATE_DIR ?? `${HAL_DIR}/state`;
  IPC_DIR = `${STATE_DIR}/ipc`;
});

// src/utils/ason.ts
function quoteString(s, multiline = false) {
  if (multiline && s.includes(`
`)) {
    const escaped2 = s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
    return `\`${escaped2}\``;
  }
  const escaped = s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
  const hasSingle = s.includes("'");
  const hasDouble = s.includes('"');
  if (hasSingle && !hasDouble)
    return `"${escaped}"`;
  return `'${escaped.replace(/'/g, "\\'")}'`;
}
function quoteKey(key) {
  return IDENT_RE.test(key) ? key : quoteString(key);
}
function indentComment(comment, pad) {
  const lines = comment.replace(/\n$/, "").split(`
`);
  return lines.map((l) => l ? pad + l : "").join(`
`);
}
function stringifyValue(obj, col, depth, maxWidth) {
  if (obj === null)
    return "null";
  if (obj === undefined)
    return "undefined";
  if (typeof obj === "boolean")
    return obj ? "true" : "false";
  if (typeof obj === "number") {
    if (Number.isNaN(obj))
      return "NaN";
    if (obj === Infinity)
      return "Infinity";
    if (obj === -Infinity)
      return "-Infinity";
    return String(obj);
  }
  if (typeof obj === "string")
    return quoteString(obj, maxWidth < Infinity);
  if (Array.isArray(obj)) {
    if (obj.length === 0)
      return "[]";
    const comments = maxWidth < Infinity ? obj[COMMENTS] : undefined;
    const items = obj.map((v) => stringifyValue(v, 0, depth, maxWidth));
    const inline = `[${items.join(", ")}]`;
    if (!comments && col + inline.length <= maxWidth && !inline.includes(`
`))
      return inline;
    const childDepth = depth + 1;
    const pad = "  ".repeat(childDepth);
    const lines = obj.map((v, i) => {
      const comment = comments?.[i];
      const prefix = comment ? indentComment(comment, pad) + `
` : "";
      return `${prefix}${pad}${stringifyValue(v, pad.length, childDepth, maxWidth)}${i < obj.length - 1 ? "," : ""}`;
    });
    return `[
${lines.join(`
`)}
${"  ".repeat(depth)}]`;
  }
  if (typeof obj === "object") {
    const rec = obj;
    const keys = Object.keys(rec);
    if (keys.length === 0)
      return "{}";
    const comments = maxWidth < Infinity ? rec[COMMENTS] : undefined;
    const pairs = keys.map((k) => `${quoteKey(k)}: ${stringifyValue(rec[k], 0, depth, maxWidth)}`);
    const inline = `{ ${pairs.join(", ")} }`;
    if (!comments && col + inline.length <= maxWidth && !inline.includes(`
`))
      return inline;
    const childDepth = depth + 1;
    const pad = "  ".repeat(childDepth);
    const lines = keys.map((k, i) => {
      const comment = comments?.[k];
      const prefix = comment ? indentComment(comment, pad) + `
` : "";
      const keyPrefix = `${pad}${quoteKey(k)}: `;
      const val = stringifyValue(rec[k], keyPrefix.length, childDepth, maxWidth);
      return `${prefix}${keyPrefix}${val}${i < keys.length - 1 ? "," : ""}`;
    });
    return `{
${lines.join(`
`)}
${"  ".repeat(depth)}}`;
  }
  throw new Error(`TODO: unsupported type ${typeof obj}`);
}
function stringify(obj, mode = "smart") {
  const maxWidth = mode === "short" ? Infinity : mode === "long" ? 0 : 80;
  return stringifyValue(obj, 0, 0, maxWidth);
}
function fail(ctx, msg) {
  let line = 1, col = 1;
  for (const c of ctx.buf.slice(0, ctx.pos)) {
    if (c === `
`) {
      line++;
      col = 1;
    } else
      col++;
  }
  const lineText = ctx.buf.split(`
`)[line - 1] ?? "";
  const pad = lineText.slice(0, col - 1).replace(/[^\t]/g, " ");
  throw new ParseError(`${msg} at ${line}:${col}:
    ${lineText}
    ${pad}^`, ctx.pos);
}
function isIdent(ch) {
  return /[a-zA-Z0-9_$]/.test(ch);
}
function skipWhite(ctx) {
  let collected = "";
  let newlines = 0;
  while (ctx.pos < ctx.buf.length) {
    const ch = peek(ctx);
    if (ch === `
`) {
      ctx.pos++;
      newlines++;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      ctx.pos++;
      continue;
    }
    if (ch === "/" && peek2(ctx) === "/") {
      const start = ctx.pos;
      ctx.pos += 2;
      while (ctx.pos < ctx.buf.length && peek(ctx) !== `
`)
        ctx.pos++;
      if (ctx.pos < ctx.buf.length)
        ctx.pos++;
      if (ctx.comments) {
        if (newlines >= 2)
          collected += `
`;
        collected += ctx.buf.slice(start, ctx.pos);
      }
      newlines = 0;
      continue;
    }
    if (ch === "/" && peek2(ctx) === "*") {
      const start = ctx.pos;
      ctx.pos += 2;
      while (ctx.pos < ctx.buf.length) {
        if (peek(ctx) === "*" && peek2(ctx) === "/") {
          ctx.pos += 2;
          break;
        }
        ctx.pos++;
      }
      if (ctx.comments) {
        if (newlines >= 2)
          collected += `
`;
        collected += ctx.buf.slice(start, ctx.pos);
      }
      newlines = 0;
      continue;
    }
    break;
  }
  return collected;
}
function peek(ctx) {
  return ctx.buf[ctx.pos] ?? "";
}
function peek2(ctx) {
  return ctx.buf[ctx.pos + 1] ?? "";
}
function eat(ctx, ch) {
  if (peek(ctx) !== ch)
    fail(ctx, `Expected '${ch}', got '${peek(ctx) || "EOF"}'`);
  ctx.pos++;
}
function eatWord(ctx, word) {
  for (const c of word)
    eat(ctx, c);
  if (isIdent(peek(ctx)))
    fail(ctx, `Unexpected character after '${word}'`);
}
function parseString(ctx, quote) {
  ctx.pos++;
  const start = ctx.pos;
  const buf = ctx.buf;
  const qc = quote.charCodeAt(0);
  const checkTemplateDollar = quote === "`";
  let pos = ctx.pos;
  while (pos < buf.length) {
    const cc = buf.charCodeAt(pos);
    if (cc === 92)
      break;
    if (cc === qc) {
      ctx.pos = pos + 1;
      return buf.slice(start, pos);
    }
    if (checkTemplateDollar && cc === 36 && buf.charCodeAt(pos + 1) === 123) {
      ctx.pos = pos;
      fail(ctx, "Template interpolation is not supported");
    }
    pos++;
  }
  const segments = [];
  let segStart = start;
  ctx.pos = pos;
  while (ctx.pos < buf.length) {
    const cc = buf.charCodeAt(ctx.pos);
    if (cc === 92) {
      segments.push(buf.slice(segStart, ctx.pos));
      ctx.pos++;
      const esc = buf.charCodeAt(ctx.pos);
      if (esc === 110)
        segments.push(`
`);
      else if (esc === 116)
        segments.push("\t");
      else if (esc === 114)
        segments.push("\r");
      else if (esc === 98)
        segments.push("\b");
      else if (esc === 102)
        segments.push("\f");
      else if (esc === 117) {
        const hex = buf.slice(ctx.pos + 1, ctx.pos + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex))
          fail(ctx, "Invalid unicode escape");
        segments.push(String.fromCharCode(parseInt(hex, 16)));
        ctx.pos += 4;
      } else
        segments.push(buf[ctx.pos]);
      ctx.pos++;
      segStart = ctx.pos;
      continue;
    }
    if (cc === qc) {
      segments.push(buf.slice(segStart, ctx.pos));
      ctx.pos++;
      return segments.join("");
    }
    if (checkTemplateDollar && cc === 36 && buf.charCodeAt(ctx.pos + 1) === 123) {
      fail(ctx, "Template interpolation is not supported");
    }
    ctx.pos++;
  }
  fail(ctx, "Unterminated string");
}
function parseNumber(ctx) {
  NUM_RE.lastIndex = ctx.pos;
  const m = NUM_RE.exec(ctx.buf);
  if (!m)
    fail(ctx, "Invalid number");
  ctx.pos = NUM_RE.lastIndex;
  return Number(m[0]);
}
function parseKey(ctx) {
  skipWhite(ctx);
  const ch = peek(ctx);
  if (ch === "'" || ch === '"')
    return parseString(ctx, ch);
  const start = ctx.pos;
  while (isIdent(peek(ctx)))
    ctx.pos++;
  if (ctx.pos === start)
    fail(ctx, "Expected object key");
  return ctx.buf.slice(start, ctx.pos);
}
function parseObject(ctx) {
  ctx.pos++;
  const obj = {};
  let commentMap;
  while (true) {
    const comment = skipWhite(ctx);
    if (peek(ctx) === "}") {
      ctx.pos++;
      break;
    }
    const key = parseKey(ctx);
    if (comment) {
      commentMap ??= {};
      commentMap[key] = comment;
    }
    skipWhite(ctx);
    eat(ctx, ":");
    obj[key] = parseAny(ctx);
    skipWhite(ctx);
    if (peek(ctx) === ",")
      ctx.pos++;
  }
  if (commentMap)
    obj[COMMENTS] = commentMap;
  return obj;
}
function parseArray(ctx) {
  ctx.pos++;
  const arr = [];
  let commentArr;
  while (true) {
    const comment = skipWhite(ctx);
    if (peek(ctx) === "]") {
      ctx.pos++;
      break;
    }
    if (comment) {
      commentArr ??= [];
      commentArr[arr.length] = comment;
    }
    arr.push(parseAny(ctx));
    skipWhite(ctx);
    if (peek(ctx) === ",")
      ctx.pos++;
  }
  if (commentArr)
    arr[COMMENTS] = commentArr;
  return arr;
}
function parseAny(ctx) {
  skipWhite(ctx);
  const ch = peek(ctx);
  if (ch === "{")
    return parseObject(ctx);
  if (ch === "[")
    return parseArray(ctx);
  if (ch === "'" || ch === '"' || ch === "`")
    return parseString(ctx, ch);
  if (ch === "-") {
    if (peek2(ctx) === "I") {
      eatWord(ctx, "-Infinity");
      return -Infinity;
    }
    return parseNumber(ctx);
  }
  if (/[0-9]/.test(ch))
    return parseNumber(ctx);
  if (ch === "t") {
    eatWord(ctx, "true");
    return true;
  }
  if (ch === "f") {
    eatWord(ctx, "false");
    return false;
  }
  if (ch === "n") {
    eatWord(ctx, "null");
    return null;
  }
  if (ch === "u") {
    eatWord(ctx, "undefined");
    return;
  }
  if (ch === "N") {
    eatWord(ctx, "NaN");
    return NaN;
  }
  if (ch === "I") {
    eatWord(ctx, "Infinity");
    return Infinity;
  }
  fail(ctx, "Unexpected token");
}
function parse(str, opts) {
  const ctx = { buf: str, pos: 0, comments: opts?.comments };
  const value = parseAny(ctx);
  skipWhite(ctx);
  if (ctx.pos < ctx.buf.length)
    fail(ctx, "Unexpected content after value");
  return value;
}
function parseAll(str) {
  const ctx = { buf: str, pos: 0 };
  const results = [];
  skipWhite(ctx);
  while (ctx.pos < ctx.buf.length) {
    results.push(parseAny(ctx));
    skipWhite(ctx);
  }
  return results;
}
async function* streamLines(stream) {
  const decoder = new TextDecoder;
  let buf = "";
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split(`
`);
    buf = lines.pop();
    for (const line of lines)
      yield line;
  }
  if (buf)
    yield buf;
}
async function* parseStream(stream) {
  let first = true;
  for await (const line of streamLines(stream)) {
    if (!line.trim())
      continue;
    if (first) {
      first = false;
      try {
        yield parse(line);
      } catch {}
    } else {
      yield parse(line);
    }
  }
}
var COMMENTS, IDENT_RE, ParseError, NUM_RE, ason;
var init_ason = __esm(() => {
  COMMENTS = Symbol("comments");
  IDENT_RE = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;
  ParseError = class ParseError extends Error {
    pos;
    constructor(msg, pos) {
      super(msg);
      this.pos = pos;
    }
  };
  NUM_RE = /-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/y;
  ason = { stringify, parse, parseAll, parseStream, COMMENTS };
});

// src/utils/live-file.ts
import { readFileSync as readFileSync4, writeFileSync as writeFileSync2, renameSync, existsSync as existsSync6, watch } from "fs";
import { dirname as dirname2, basename } from "path";
function liveFile(path, defaults, opts) {
  const data = { ...defaults };
  if (existsSync6(path)) {
    try {
      Object.assign(data, ason.parse(readFileSync4(path, "utf-8")));
    } catch {}
  }
  const state = {
    path,
    data,
    dirty: false,
    flushScheduled: false,
    callbacks: [],
    doFlush() {
      if (!state.dirty)
        return;
      state.dirty = false;
      const tmp = `${path}.tmp.${process.pid}`;
      writeFileSync2(tmp, ason.stringify(data) + `
`);
      renameSync(tmp, path);
    }
  };
  function scheduleFlush() {
    if (state.flushScheduled)
      return;
    state.flushScheduled = true;
    queueMicrotask(() => {
      state.flushScheduled = false;
      state.doFlush();
    });
  }
  if (opts?.watch !== false) {
    let debounce = null;
    let ownWrite = false;
    const origFlush = state.doFlush;
    state.doFlush = () => {
      ownWrite = true;
      origFlush();
      setTimeout(() => {
        ownWrite = false;
      }, 100);
    };
    try {
      watch(dirname2(path), { persistent: false }, (_, filename) => {
        if (filename && filename !== basename(path))
          return;
        if (ownWrite)
          return;
        if (debounce)
          clearTimeout(debounce);
        debounce = setTimeout(() => {
          try {
            Object.assign(data, ason.parse(readFileSync4(path, "utf-8")));
            for (const cb of state.callbacks)
              cb();
          } catch {}
        }, 50);
      });
    } catch {}
  }
  const handler = {
    set(target, prop, value) {
      target[prop] = value;
      state.dirty = true;
      scheduleFlush();
      return true;
    },
    get(target, prop) {
      const val = target[prop];
      if (val && typeof val === "object" && !Array.isArray(val)) {
        return new Proxy(val, handler);
      }
      return val;
    }
  };
  const proxy = new Proxy(data, handler);
  registry.set(proxy, state);
  return proxy;
}
function save(proxy) {
  registry.get(proxy)?.doFlush();
}
function onChange(proxy, cb) {
  registry.get(proxy)?.callbacks.push(cb);
}
var registry, liveFiles;
var init_live_file = __esm(() => {
  init_ason();
  registry = new WeakMap;
  liveFiles = { liveFile, save, onChange };
});

// src/auth.ts
function store() {
  if (!_store)
    _store = liveFiles.liveFile(AUTH_PATH, {});
  return _store;
}
function getCredential(providerName) {
  const entry = store()[providerName];
  if (entry) {
    if (entry.accessToken)
      return { value: entry.accessToken, type: "token" };
    if (entry.apiKey)
      return { value: entry.apiKey, type: "api-key" };
  }
  const envVar = ENV_KEYS[providerName] ?? `${providerName.toUpperCase()}_API_KEY`;
  const envVal = process.env[envVar];
  if (envVal)
    return { value: envVal, type: "api-key" };
  return;
}
function getEntry(providerName) {
  return store()[providerName] ?? {};
}
async function refreshAnthropic() {
  const entry = store().anthropic;
  if (!entry?.refreshToken)
    return;
  if (entry.expires && Date.now() < entry.expires - 60000)
    return;
  const res = await fetch("https://console.anthropic.com/v1/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: entry.refreshToken,
      client_id: ANTHROPIC_CLIENT_ID
    })
  });
  const data = await res.json();
  if (!data.access_token)
    throw new Error(`Anthropic token refresh failed: ${JSON.stringify(data)}`);
  store().anthropic = {
    ...entry,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000
  };
}
async function refreshOpenAI() {
  const entry = store().openai;
  if (!entry?.refreshToken)
    return;
  if (entry.accessToken && isApiKey(entry.accessToken))
    return;
  if (entry.expires && Date.now() < entry.expires - 60000)
    return;
  const res = await fetch(OPENAI_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: entry.refreshToken,
      client_id: OPENAI_CLIENT_ID
    })
  });
  if (!res.ok) {
    const text2 = await res.text().catch(() => "");
    throw new Error(`OpenAI token refresh failed: ${res.status} ${text2}`);
  }
  const data = await res.json();
  if (!data.access_token)
    throw new Error("OpenAI refresh: missing access_token");
  store().openai = {
    ...entry,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expires: Date.now() + (data.expires_in ?? 3600) * 1000
  };
}
async function ensureFresh(providerName) {
  try {
    if (providerName === "anthropic")
      await refreshAnthropic();
    else if (providerName === "openai")
      await refreshOpenAI();
  } catch (e) {
    console.error(`Auth refresh (${providerName}):`, e.message);
  }
}
var AUTH_PATH, ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e", OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann", OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token", _store = null, ENV_KEYS, auth;
var init_auth = __esm(() => {
  init_live_file();
  init_state();
  AUTH_PATH = `${HAL_DIR}/auth.ason`;
  ENV_KEYS = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    google: "GOOGLE_API_KEY",
    grok: "GROK_API_KEY"
  };
  auth = { getCredential, getEntry, ensureFresh };
});

// src/providers/anthropic.ts
var exports_anthropic = {};
__export(exports_anthropic, {
  anthropicProvider: () => anthropicProvider
});
function errorTypeToStatus(type) {
  return typeof type === "string" ? ERROR_TYPE_STATUS[type] : undefined;
}
function isOpenAIReasoningSignature(signature) {
  if (typeof signature !== "string" || !signature.trim().startsWith("{"))
    return false;
  try {
    const parsed = JSON.parse(signature);
    return parsed?.type === "reasoning" && typeof parsed.encrypted_content === "string";
  } catch {
    return false;
  }
}
function formatForeignThinking(thinking, sourceModel) {
  if (typeof thinking !== "string")
    return null;
  const text2 = thinking.trim();
  if (!text2)
    return null;
  const model = sourceModel ?? "unknown";
  return `[model ${model} thinking]
${text2}`;
}
function sanitizeMessages(msgs) {
  if (!msgs.length)
    return msgs;
  const out = [];
  for (const msg of msgs) {
    if (!Array.isArray(msg.content)) {
      out.push(msg);
      continue;
    }
    const content = [];
    for (const block of msg.content) {
      if (block.type === "thinking") {
        if (isOpenAIReasoningSignature(block.signature)) {
          const replayed = formatForeignThinking(block.thinking, block._model);
          if (replayed)
            content.push({ type: "text", text: replayed });
          continue;
        }
        content.push({ type: "thinking", thinking: block.thinking, signature: block.signature });
        continue;
      }
      content.push(block);
    }
    if (content.length > 0)
      out.push({ ...msg, content });
  }
  return out;
}
function applyCacheBreakpoints(msgs) {
  if (!msgs.length)
    return msgs;
  const out = structuredClone(msgs);
  const markLast = (m) => {
    if (typeof m.content === "string") {
      m.content = [{ type: "text", text: m.content, cache_control: { type: "ephemeral" } }];
    } else if (Array.isArray(m.content) && m.content.length) {
      m.content[m.content.length - 1].cache_control = { type: "ephemeral" };
    }
  };
  markLast(out[out.length - 1]);
  if (out.length >= 3) {
    for (let i = out.length - 2;i >= 0; i--) {
      if (out[i].role === "user") {
        markLast(out[i]);
        break;
      }
    }
  }
  return out;
}
async function* parseStream2(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder;
  let buf = "";
  const tools = new Map;
  const usage = { input: 0, output: 0 };
  while (true) {
    const { done, value } = await provider.readWithTimeout(reader);
    if (done)
      break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf(`
`)) !== -1) {
      const line = buf.slice(0, nl).trimEnd();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data: "))
        continue;
      let ev;
      try {
        ev = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      if (ev.type === "content_block_start") {
        const b = ev.content_block;
        if (b.type === "tool_use") {
          tools.set(ev.index, { id: b.id, name: b.name, json: "" });
        }
      } else if (ev.type === "content_block_delta") {
        const d = ev.delta;
        if (d.type === "thinking_delta") {
          yield { type: "thinking", text: d.thinking };
        } else if (d.type === "signature_delta") {
          yield { type: "thinking_signature", signature: d.signature };
        } else if (d.type === "text_delta") {
          yield { type: "text", text: d.text };
        } else if (d.type === "input_json_delta") {
          const t = tools.get(ev.index);
          if (t)
            t.json += d.partial_json;
        }
      } else if (ev.type === "content_block_stop") {
        const t = tools.get(ev.index);
        if (t) {
          let input;
          try {
            input = JSON.parse(t.json || "{}");
          } catch {
            yield {
              type: "tool_call",
              id: t.id,
              name: t.name,
              input: {},
              rawJson: t.json,
              parseError: `Failed to parse tool input JSON (${t.json.length} chars): ${t.json.slice(0, 200)}`
            };
            tools.delete(ev.index);
            continue;
          }
          yield { type: "tool_call", id: t.id, name: t.name, input, rawJson: t.json };
          tools.delete(ev.index);
        }
      } else if (ev.type === "message_start" && ev.message?.usage) {
        const u = ev.message.usage;
        usage.input += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      } else if (ev.type === "message_delta" && ev.usage) {
        usage.output += ev.usage.output_tokens ?? 0;
      } else if (ev.type === "error") {
        const msg = ev.error?.message ?? "Stream error";
        const body2 = JSON.stringify(ev.error ?? ev);
        const status = errorTypeToStatus(ev.error?.type);
        try {
          const prev = await Bun.file("/tmp/compare/hal.txt").exists() ? await Bun.file("/tmp/compare/hal.txt").text() : "";
          await Bun.write("/tmp/compare/hal.txt", prev + `STREAM ERROR: status=${status} type=${ev.error?.type} body=${body2}

`);
        } catch {}
        yield { type: "error", message: msg, status, body: body2 };
      }
    }
  }
  yield { type: "done", usage };
}
async function* generate(req) {
  await auth.ensureFresh("anthropic");
  const cred = auth.getCredential("anthropic");
  if (!cred) {
    yield { type: "error", message: "No Anthropic credentials. Run: bun scripts/login-anthropic.ts" };
    yield { type: "done" };
    return;
  }
  const isAdaptive = /^claude-(opus|sonnet)-4-6/.test(req.model);
  const supportsThinking = /^claude-(opus|sonnet)/.test(req.model);
  const isOAuth = cred.type === "token";
  const system = [];
  if (isOAuth) {
    system.push({ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." });
  }
  system.push({ type: "text", text: req.systemPrompt, cache_control: { type: "ephemeral" } });
  const messages = applyCacheBreakpoints(sanitizeMessages(req.messages));
  const body = {
    model: req.model,
    max_tokens: MAX_TOKENS,
    stream: true,
    system,
    messages
  };
  if (supportsThinking) {
    body.thinking = isAdaptive ? { type: "adaptive" } : { type: "enabled", budget_tokens: Math.min(1e4, MAX_TOKENS - 1) };
  }
  if (req.tools?.length) {
    body.tools = req.tools;
  }
  const authHeader = isOAuth ? { Authorization: `Bearer ${cred.value}` } : { "x-api-key": cred.value };
  const url = API_URL;
  const headers = {
    "Content-Type": "application/json",
    ...authHeader,
    "anthropic-version": API_VERSION,
    "anthropic-beta": isOAuth ? "claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14" : "fine-grained-tool-streaming-2025-05-14",
    ...isOAuth ? { "user-agent": "claude-cli/2.1.75", "x-app": "cli" } : {}
  };
  try {
    const debugBody = JSON.parse(JSON.stringify(body));
    if (debugBody.messages)
      for (const m of debugBody.messages) {
        if (typeof m.content === "string" && m.content.length > 200)
          m.content = m.content.slice(0, 200) + "...";
        if (Array.isArray(m.content))
          for (const b of m.content) {
            if (b.type === "text" && b.text?.length > 200)
              b.text = b.text.slice(0, 200) + "...";
          }
      }
    const dump = `=== HAL REQUEST ${new Date().toISOString()} ===
URL: ${url}
HEADERS: ${JSON.stringify(headers, null, 2)}
BODY: ${JSON.stringify(debugBody, null, 2)}

`;
    const prev = await Bun.file("/tmp/compare/hal.txt").exists() ? await Bun.file("/tmp/compare/hal.txt").text() : "";
    await Bun.write("/tmp/compare/hal.txt", prev + dump);
  } catch {}
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: req.signal
  });
  try {
    const rd = `RESPONSE: ${res.status} ${res.statusText}

`;
    const prev = await Bun.file("/tmp/compare/hal.txt").text();
    await Bun.write("/tmp/compare/hal.txt", prev + rd);
  } catch {}
  if (!res.ok) {
    const text2 = (await res.text()).slice(0, 2000);
    try {
      const prev = await Bun.file("/tmp/compare/hal.txt").text();
      await Bun.write("/tmp/compare/hal.txt", prev + `ERROR BODY: ${text2}

`);
    } catch {}
    const retryAfterMs = provider.parseRetryDelay(res, text2);
    yield { type: "error", message: `Anthropic API ${res.status}`, status: res.status, body: text2, retryAfterMs };
    yield { type: "done" };
    return;
  }
  yield* parseStream2(res.body);
}
var API_URL = "https://api.anthropic.com/v1/messages?beta=true", API_VERSION = "2023-06-01", MAX_TOKENS = 16384, ERROR_TYPE_STATUS, anthropicProvider;
var init_anthropic = __esm(() => {
  init_provider();
  init_auth();
  ERROR_TYPE_STATUS = {
    overloaded_error: 529,
    rate_limit_error: 429,
    api_error: 500,
    invalid_request_error: 400,
    authentication_error: 401,
    permission_error: 403,
    not_found_error: 404
  };
  anthropicProvider = { generate };
});

// src/providers/openai.ts
var exports_openai = {};
__export(exports_openai, {
  openaiProvider: () => openaiProvider,
  openai: () => openai,
  createCompatProvider: () => createCompatProvider
});
function getApiKey(providerName) {
  return auth.getCredential(providerName)?.value;
}
function convertMessages(msgs) {
  const out = [];
  for (const msg of msgs) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        out.push({ role: "user", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const toolResults = msg.content.filter((b) => b.type === "tool_result");
        const others = msg.content.filter((b) => b.type !== "tool_result");
        for (const tr of toolResults) {
          out.push({
            role: "tool",
            tool_call_id: tr.tool_use_id,
            content: typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content)
          });
        }
        if (others.length > 0) {
          const parts = [];
          for (const b of others) {
            if (b.type === "text") {
              parts.push({ type: "text", text: b.text });
            } else if (b.type === "image") {
              const src = b.source;
              if (src?.type === "base64") {
                parts.push({
                  type: "image_url",
                  image_url: { url: `data:${src.media_type};base64,${src.data}` }
                });
              }
            }
          }
          if (parts.length === 1 && parts[0].type === "text") {
            out.push({ role: "user", content: parts[0].text });
          } else if (parts.length > 0) {
            out.push({ role: "user", content: parts });
          }
        }
      }
    } else if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        out.push({ role: "assistant", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        let text2 = "";
        const toolCalls = [];
        for (const b of msg.content) {
          if (b.type === "text")
            text2 += b.text;
          else if (b.type === "tool_use") {
            toolCalls.push({
              id: b.id,
              type: "function",
              function: { name: b.name, arguments: JSON.stringify(b.input) }
            });
          }
        }
        const m = { role: "assistant" };
        if (text2)
          m.content = text2;
        if (toolCalls.length)
          m.tool_calls = toolCalls;
        if (!text2 && !toolCalls.length)
          m.content = "";
        out.push(m);
      }
    }
  }
  return out;
}
function convertTools(tools) {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema ?? t.parameters
    }
  }));
}
async function* parseChatCompletionsStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder;
  let buf = "";
  let inputTokens = 0;
  let outputTokens = 0;
  const toolCalls = new Map;
  try {
    while (true) {
      const { done, value } = await provider.readWithTimeout(reader);
      if (done)
        break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf(`
`)) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data: "))
          continue;
        const data = line.slice(6);
        if (data === "[DONE]")
          continue;
        let chunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        const choice = chunk.choices?.[0];
        if (!choice) {
          if (chunk.usage) {
            inputTokens = chunk.usage.prompt_tokens ?? 0;
            outputTokens = chunk.usage.completion_tokens ?? 0;
          }
          continue;
        }
        const delta = choice.delta;
        if (delta?.content)
          yield { type: "text", text: delta.content };
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (tc.id) {
              toolCalls.set(idx, { id: tc.id, name: tc.function?.name ?? "", args: "" });
            }
            const entry = toolCalls.get(idx);
            if (entry) {
              if (tc.function?.name)
                entry.name = tc.function.name;
              if (tc.function?.arguments)
                entry.args += tc.function.arguments;
            }
          }
        }
        if (choice.finish_reason === "stop" || choice.finish_reason === "tool_calls") {
          if (chunk.usage) {
            inputTokens = chunk.usage.prompt_tokens ?? 0;
            outputTokens = chunk.usage.completion_tokens ?? 0;
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  for (const [, tc] of toolCalls) {
    try {
      const input = JSON.parse(tc.args);
      yield { type: "tool_call", id: tc.id, name: tc.name, input };
    } catch {
      yield {
        type: "tool_call",
        id: tc.id,
        name: tc.name,
        input: {},
        parseError: `Failed to parse tool input JSON (${tc.args.length} chars): ${tc.args.slice(0, 200)}`
      };
    }
  }
  yield {
    type: "done",
    usage: inputTokens || outputTokens ? { input: inputTokens, output: outputTokens } : undefined
  };
}
async function* generateCompat(providerName, baseUrl, req) {
  await auth.ensureFresh(providerName);
  const apiKey = getApiKey(providerName);
  if (!apiKey) {
    yield { type: "error", message: `No credentials for '${providerName}'. Run: bun scripts/login-openai.ts (or set ${providerName.toUpperCase()}_API_KEY)` };
    yield { type: "done" };
    return;
  }
  const messages = convertMessages(req.messages);
  const body = {
    model: req.model,
    messages: [{ role: "system", content: req.systemPrompt }, ...messages],
    stream: true
  };
  if (req.tools?.length) {
    body.tools = convertTools(req.tools);
  }
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body),
    signal: req.signal
  });
  if (!res.ok) {
    const text2 = (await res.text()).slice(0, 2000);
    const retryAfterMs = provider.parseRetryDelay(res, text2);
    yield { type: "error", message: `${providerName} ${res.status}: ${res.statusText}`, status: res.status, body: text2, retryAfterMs };
    yield { type: "done" };
    return;
  }
  yield* parseChatCompletionsStream(res.body);
}
async function* generateOpenAI(req) {
  yield* generateCompat("openai", "https://api.openai.com/v1", req);
}
function createCompatProvider(providerName, baseUrl) {
  const url = baseUrl ?? COMPAT_ENDPOINTS[providerName];
  if (!url) {
    throw new Error(`Unknown compat provider '${providerName}'. ` + `Known endpoints: ${Object.keys(COMPAT_ENDPOINTS).join(", ")}. ` + `Or pass a custom baseUrl.`);
  }
  return {
    generate: (req) => generateCompat(providerName, url, req)
  };
}
var COMPAT_ENDPOINTS, openaiProvider, openai;
var init_openai = __esm(() => {
  init_provider();
  init_auth();
  COMPAT_ENDPOINTS = {
    openrouter: "https://openrouter.ai/api/v1",
    google: "https://generativelanguage.googleapis.com/v1beta/openai",
    grok: "https://api.x.ai/v1"
  };
  openaiProvider = { generate: generateOpenAI };
  openai = {
    openaiProvider,
    createCompatProvider,
    convertMessages,
    convertTools,
    COMPAT_ENDPOINTS
  };
});

// src/providers/provider.ts
async function getProvider(providerName) {
  const cached = cache.get(providerName);
  if (cached)
    return cached;
  let p;
  if (providerName === "anthropic") {
    const { anthropicProvider: anthropicProvider2 } = await Promise.resolve().then(() => (init_anthropic(), exports_anthropic));
    p = anthropicProvider2;
  } else if (providerName === "openai") {
    const { openaiProvider: openaiProvider2 } = await Promise.resolve().then(() => (init_openai(), exports_openai));
    p = openaiProvider2;
  } else if (COMPAT_PROVIDERS.has(providerName)) {
    const { createCompatProvider: createCompatProvider2 } = await Promise.resolve().then(() => (init_openai(), exports_openai));
    p = createCompatProvider2(providerName);
  } else {
    const envKey = `${providerName.toUpperCase()}_BASE_URL`;
    const baseUrl = process.env[envKey];
    if (baseUrl) {
      const { createCompatProvider: createCompatProvider2 } = await Promise.resolve().then(() => (init_openai(), exports_openai));
      p = createCompatProvider2(providerName, baseUrl);
    } else {
      throw new Error(`Unknown provider '${providerName}'. Set ${envKey} for custom endpoints, or use: anthropic, openai, openrouter, google, grok`);
    }
  }
  cache.set(providerName, p);
  return p;
}
function parseRetryDelay(res, body) {
  const header = res.headers.get("retry-after");
  if (header) {
    const sec = Number(header);
    if (!isNaN(sec) && sec > 0)
      return Math.ceil(sec * 1000);
    const date = Date.parse(header);
    if (!isNaN(date))
      return Math.max(1000, date - Date.now());
  }
  if (body) {
    try {
      let json = JSON.parse(body);
      if (Array.isArray(json))
        json = json[0];
      const details = json?.error?.details ?? json?.details;
      if (Array.isArray(details)) {
        for (const d of details) {
          const delay = d?.retryDelay;
          if (typeof delay === "string") {
            const m = delay.match(/^(\d+(?:\.\d+)?)s$/);
            if (m)
              return Math.ceil(Number(m[1]) * 1000);
          }
        }
      }
    } catch {}
  }
  return;
}
async function readWithTimeout(reader) {
  let timer;
  const timeout = new Promise((_, reject) => {
    const ms = config.streamTimeoutMs;
    timer = setTimeout(() => reject(new Error(`Stream read timed out (no data for ${ms}ms)`)), ms);
  });
  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
var config, cache, COMPAT_PROVIDERS, provider;
var init_provider = __esm(() => {
  config = {
    streamTimeoutMs: 120000
  };
  cache = new Map;
  COMPAT_PROVIDERS = new Set(["openrouter", "google", "grok"]);
  provider = { config, getProvider, parseRetryDelay, readWithTimeout };
});

// src/tools/tool.ts
function registerTool(tool) {
  registry2.set(tool.name, tool);
}
function getTool(name) {
  return registry2.get(name) ?? null;
}
function allTools() {
  return [...registry2.values()];
}
function toToolDefs() {
  return allTools().map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: {
      type: "object",
      properties: t.parameters,
      required: t.required ?? []
    }
  }));
}
async function dispatch(name, input, context2) {
  const tool = getTool(name);
  if (!tool)
    return `error: unknown tool "${name}"`;
  try {
    return await tool.execute(input, context2);
  } catch (err) {
    return `error: ${err?.message ?? String(err)}`;
  }
}
var registry2, toolRegistry;
var init_tool = __esm(() => {
  registry2 = new Map;
  toolRegistry = { registerTool, getTool, allTools, toToolDefs, dispatch };
});

// src/runtime/inbox.ts
var exports_inbox = {};
__export(exports_inbox, {
  inbox: () => inbox
});
import { readdirSync as readdirSync2, readFileSync as readFileSync8, unlinkSync as unlinkSync2 } from "fs";
import { watch as watch2 } from "fs";
function processInbox(sessionDir2, sessionId, onMessage) {
  try {
    const files = readdirSync2(sessionDir2).filter((f) => f.endsWith(".ason")).sort();
    for (const file of files) {
      const path = `${sessionDir2}/${file}`;
      try {
        const content = readFileSync8(path, "utf-8");
        const msg = ason.parse(content);
        if (msg.text) {
          onMessage(sessionId, msg.text);
        }
        unlinkSync2(path);
      } catch {
        try {
          unlinkSync2(path);
        } catch {}
      }
    }
  } catch {}
}
function startWatching(signal, onMessage) {
  ensureDir(INBOX_DIR);
  try {
    const sessionDirs = readdirSync2(INBOX_DIR);
    for (const sessionId of sessionDirs) {
      const sessionDir2 = `${INBOX_DIR}/${sessionId}`;
      processInbox(sessionDir2, sessionId, onMessage);
    }
  } catch {}
  try {
    const watcher = watch2(INBOX_DIR, { recursive: true, persistent: false }, (event, filename) => {
      if (signal.aborted)
        return;
      if (!filename || !filename.endsWith(".ason"))
        return;
      const slashIdx = filename.indexOf("/");
      if (slashIdx === -1)
        return;
      const sessionId = filename.slice(0, slashIdx);
      const sessionDir2 = `${INBOX_DIR}/${sessionId}`;
      processInbox(sessionDir2, sessionId, onMessage);
    });
    signal.addEventListener("abort", () => watcher.close(), { once: true });
  } catch {
    const interval = setInterval(() => {
      if (signal.aborted) {
        clearInterval(interval);
        return;
      }
      try {
        const sessionDirs = readdirSync2(INBOX_DIR);
        for (const sessionId of sessionDirs) {
          processInbox(`${INBOX_DIR}/${sessionId}`, sessionId, onMessage);
        }
      } catch {}
    }, 2000);
    signal.addEventListener("abort", () => clearInterval(interval), { once: true });
  }
}
function queueMessage(sessionId, text2, from) {
  const dir = `${INBOX_DIR}/${sessionId}`;
  ensureDir(dir);
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.ason`;
  const msg = {
    sessionId,
    text: text2,
    from: from ?? "external",
    ts: new Date().toISOString()
  };
  const path = `${dir}/${filename}`;
  Bun.write(path, ason.stringify(msg) + `
`);
}
var INBOX_DIR, inbox;
var init_inbox = __esm(() => {
  init_state();
  init_ason();
  INBOX_DIR = `${STATE_DIR}/inbox`;
  inbox = { startWatching, queueMessage };
});

// src/mcp/client.ts
var exports_client = {};
__export(exports_client, {
  mcp: () => mcp
});
import { readFile } from "fs/promises";
async function loadConfig() {
  try {
    const text2 = await readFile(CONFIG_PATH, "utf-8");
    return JSON.parse(text2);
  } catch {
    return null;
  }
}
function send(server, method, params, id) {
  const msg = { jsonrpc: "2.0", method };
  if (params !== undefined)
    msg.params = params;
  if (id !== undefined)
    msg.id = id;
  const line = JSON.stringify(msg) + `
`;
  const stdin = server.proc.stdin;
  stdin.write(line);
  stdin.flush();
}
function request(server, method, params, timeoutMs = config5.requestTimeoutMs) {
  if (server.dead)
    return Promise.reject(new Error(`MCP server "${server.name}" is dead`));
  const id = server.nextId++;
  return new Promise((resolve4, reject) => {
    const timer = setTimeout(() => {
      server.pending.delete(id);
      reject(new Error(`MCP "${server.name}" request "${method}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    server.pending.set(id, { resolve: resolve4, reject, timer });
    send(server, method, params, id);
  });
}
function handleLine(server, line) {
  if (!line.trim())
    return;
  try {
    const msg = JSON.parse(line);
    if ("id" in msg && msg.id != null) {
      const pending2 = server.pending.get(msg.id);
      if (pending2) {
        clearTimeout(pending2.timer);
        server.pending.delete(msg.id);
        if (msg.error) {
          pending2.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        } else {
          pending2.resolve(msg.result);
        }
      }
    }
  } catch {}
}
function rejectAll(server, reason) {
  server.dead = true;
  for (const [, pending2] of server.pending) {
    clearTimeout(pending2.timer);
    pending2.reject(new Error(reason));
  }
  server.pending.clear();
}
async function readStdout(server) {
  const reader = server.proc.stdout.getReader();
  const decoder = new TextDecoder;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done)
        break;
      server.buffer += decoder.decode(value, { stream: true });
      const lines = server.buffer.split(`
`);
      server.buffer = lines.pop();
      for (const line of lines)
        handleLine(server, line);
    }
  } finally {
    rejectAll(server, `MCP server "${server.name}" stdout closed`);
  }
}
function prefixName(serverName, toolName) {
  return `mcp__${serverName}__${toolName}`;
}
async function startServer(name, cfg) {
  const proc = Bun.spawn([cfg.command, ...cfg.args ?? []], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, ...cfg.env }
  });
  const server = {
    name,
    proc,
    nextId: 1,
    pending: new Map,
    buffer: "",
    dead: false
  };
  readStdout(server);
  await request(server, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "hal", version: "1.0.0" }
  }, config5.initTimeoutMs);
  send(server, "notifications/initialized");
  const result2 = await request(server, "tools/list", {});
  const tools = result2.tools ?? [];
  for (const t of tools) {
    const prefixed = prefixName(name, t.name);
    state2.toolMap.set(prefixed, { server, originalName: t.name });
    const tool = {
      name: prefixed,
      description: `[MCP: ${name}] ${t.description ?? ""}`.trim(),
      parameters: t.inputSchema?.properties ?? {},
      required: t.inputSchema?.required,
      execute: async (input, _ctx) => {
        return await callTool(prefixed, input);
      }
    };
    toolRegistry.registerTool(tool);
  }
  return server;
}
async function initServers() {
  const cfg = await loadConfig();
  if (!cfg?.servers)
    return;
  const entries = Object.entries(cfg.servers);
  const results = await Promise.allSettled(entries.map(async ([name, serverCfg]) => {
    if (state2.servers.has(name))
      return;
    const server = await startServer(name, serverCfg);
    state2.servers.set(name, server);
  }));
  for (let i = 0;i < results.length; i++) {
    const r = results[i];
    if (r.status === "rejected") {
      console.error(`[mcp] failed to start "${entries[i][0]}": ${r.reason?.message ?? r.reason}`);
    }
  }
}
async function callTool(prefixedName, args2) {
  const entry = state2.toolMap.get(prefixedName);
  if (!entry)
    return `error: unknown MCP tool "${prefixedName}"`;
  try {
    const result2 = await request(entry.server, "tools/call", {
      name: entry.originalName,
      arguments: args2
    });
    if (result2.content) {
      return result2.content.map((c) => c.type === "text" ? c.text : JSON.stringify(c)).join(`
`);
    }
    return JSON.stringify(result2);
  } catch (err) {
    return `error: ${err.message}`;
  }
}
function isMcpTool(name) {
  return state2.toolMap.has(name);
}
async function shutdown() {
  for (const server of state2.servers.values()) {
    rejectAll(server, "shutting down");
    try {
      server.proc.kill();
    } catch {}
  }
  state2.servers.clear();
  state2.toolMap.clear();
}
var CONFIG_PATH, config5, state2, mcp;
var init_client = __esm(() => {
  init_state();
  init_tool();
  CONFIG_PATH = `${HAL_DIR}/mcp.json`;
  config5 = {
    requestTimeoutMs: 60000,
    initTimeoutMs: 15000
  };
  state2 = {
    servers: new Map,
    toolMap: new Map
  };
  mcp = { initServers, callTool, isMcpTool, shutdown, config: config5, state: state2 };
});

// src/perf.ts
var allMarks = [];
var pending = [];
var epoch = Number(process.env.HAL_STARTUP_TIMESTAMP) || Date.now();
var enabled = !!process.env.HAL_PERF;
var sink = null;
var flushTimer = null;
function absMs(ts) {
  return ts + performance.timeOrigin - epoch;
}
function mark(name, detail) {
  const m = { name, ts: performance.now(), detail };
  allMarks.push(m);
  pending.push(m);
}
function setSink(fn, intervalMs = 100) {
  sink = fn;
  if (flushTimer)
    clearInterval(flushTimer);
  flushTimer = setInterval(flush, intervalMs);
}
function flush() {
  if (!sink || pending.length === 0)
    return;
  const lines = pending.splice(0).map((m) => {
    const sinceStart = absMs(m.ts).toFixed(1);
    const detail = m.detail ? ` (${m.detail})` : "";
    return `${sinceStart}ms  ${m.name}${detail}`;
  });
  sink(lines);
}
function stop() {
  flush();
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}
function elapsed() {
  return Date.now() - epoch;
}
function trace() {
  if (allMarks.length === 0)
    return "(no perf marks)";
  const lines = [];
  let prevMs = 0;
  const maxMs = allMarks.length > 0 ? absMs(allMarks[allMarks.length - 1].ts) : 1;
  const barWidth = 20;
  for (const m of allMarks) {
    const ms = absMs(m.ts);
    const delta = ms - prevMs;
    const barLen = maxMs > 0 ? Math.round(delta / maxMs * barWidth) : 0;
    const bar = "█".repeat(Math.max(barLen, 0));
    const detail = m.detail ? ` (${m.detail})` : "";
    const msStr = ms.toFixed(0).padStart(6);
    const deltaStr = delta > 0 ? ` +${delta.toFixed(0)}ms` : "";
    lines.push(`${msStr}ms ${bar.padEnd(barWidth)} ${m.name}${deltaStr}${detail}`);
    prevMs = ms;
  }
  return lines.join(`
`);
}
function summary() {
  if (allMarks.length === 0)
    return "No perf data";
  const totalMs = absMs(allMarks[allMarks.length - 1].ts);
  return `Started in ${totalMs.toFixed(0)}ms (${allMarks.length} marks)`;
}
var perf = { mark, setSink, flush, stop, elapsed, trace, summary, enabled };

// src/main.ts
init_state();

// src/ipc.ts
init_state();
init_ason();
import { appendFileSync, readFileSync, existsSync as existsSync2, writeFileSync, unlinkSync } from "fs";
import { open } from "fs/promises";

// src/utils/tail-file.ts
import { statSync } from "fs";
var alive = new Set;
process.on("exit", () => {
  for (const p of alive)
    p.kill();
});
function tailFile(path) {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {}
  const proc = Bun.spawn(["sh", "-c", `touch "$1" && exec tail -f -c +${size + 1} "$1"`, "sh", path], {
    stdout: "pipe",
    stderr: "ignore"
  });
  alive.add(proc);
  proc.exited.then(() => alive.delete(proc));
  const reader = proc.stdout.getReader();
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      done ? controller.close() : controller.enqueue(value);
    },
    cancel() {
      proc.kill();
      alive.delete(proc);
    }
  });
}

// src/ipc.ts
var HOST_LOCK = `${IPC_DIR}/host.lock`;
var EVENTS_FILE = `${IPC_DIR}/events.asonl`;
var COMMANDS_FILE = `${IPC_DIR}/commands.asonl`;
function ensureFile(file) {
  if (!existsSync2(file))
    writeFileSync(file, "");
}
function append(file, item) {
  appendFileSync(file, ason.stringify(item, "short") + `
`);
}
function appendEvent(event) {
  append(EVENTS_FILE, { ...event, createdAt: event.createdAt ?? new Date().toISOString() });
}
function appendCommand(command) {
  append(COMMANDS_FILE, { ...command, createdAt: command.createdAt ?? new Date().toISOString() });
}
async function* tail(file, signal) {
  ensureFile(file);
  const stream = tailFile(file);
  for await (const value of ason.parseStream(stream)) {
    if (signal?.aborted)
      break;
    yield value;
  }
}
function tailEvents(signal) {
  return tail(EVENTS_FILE, signal);
}
function tailCommands(signal) {
  return tail(COMMANDS_FILE, signal);
}
async function claimHost() {
  ensureDir(IPC_DIR);
  ensureFile(EVENTS_FILE);
  ensureFile(COMMANDS_FILE);
  try {
    const fh = await open(HOST_LOCK, "wx");
    await fh.writeFile(ason.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    await fh.close();
    return true;
  } catch (e) {
    if (e?.code === "EEXIST")
      return false;
    throw e;
  }
}
async function promote() {
  appendEvent({ type: "promote", pid: process.pid });
  await Bun.sleep(50);
  const events = readAllEvents();
  let i = events.length - 1;
  while (i >= 0 && events[i]?.type !== "host-released")
    i--;
  const first = events.slice(i + 1).find((e) => e.type === "promote");
  if (!first || first.pid !== process.pid)
    return false;
  try {
    unlinkSync(HOST_LOCK);
  } catch {}
  writeFileSync(HOST_LOCK, ason.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
  return true;
}
function readHostLock() {
  try {
    return ason.parse(readFileSync(HOST_LOCK, "utf-8"));
  } catch {
    return null;
  }
}
function readAllEvents() {
  ensureFile(EVENTS_FILE);
  const content = readFileSync(EVENTS_FILE, "utf-8");
  if (!content.trim())
    return [];
  return ason.parseAll(content);
}
function releaseHost() {
  try {
    unlinkSync(HOST_LOCK);
  } catch {}
}
var ipc = {
  appendEvent,
  appendCommand,
  tailEvents,
  tailCommands,
  claimHost,
  promote,
  readHostLock,
  readAllEvents,
  releaseHost
};

// src/protocol.ts
var _counter = 0;
function eventId() {
  return `${Date.now().toString(36)}-${(++_counter).toString(36)}`;
}
var protocol = { eventId };

// src/models.ts
var ALIASES = {
  anthropic: "anthropic/claude-opus-4-6",
  claude: "anthropic/claude-opus-4-6",
  opus: "anthropic/claude-opus-4-6",
  sonnet: "anthropic/claude-sonnet-4-20250514",
  haiku: "anthropic/claude-haiku-4-5-20251001",
  openai: "openai/gpt-5.3-codex",
  gpt: "openai/gpt-5.4",
  codex: "openai/gpt-5.3-codex",
  gemini: "google/gemini-2.5-flash",
  "gemini-pro": "google/gemini-2.5-pro",
  grok: "openrouter/x-ai/grok-4",
  deepseek: "openrouter/deepseek/deepseek-chat",
  llama: "openrouter/meta-llama/llama-4-maverick"
};
var PATTERNS = [
  [/^opus-(.+)$/, "anthropic/claude-opus-$1"],
  [/^sonnet-(.+)$/, "anthropic/claude-sonnet-$1"],
  [/^haiku-(.+)$/, "anthropic/claude-haiku-$1"],
  [/^gpt-?(\d+\.\d+)$/, "openai/gpt-$1"],
  [/^gemini-(.+)$/, "google/gemini-$1"],
  [/^grok-(.+)$/, "openrouter/x-ai/grok-$1"]
];
function resolveModel(input) {
  if (input.includes("/"))
    return input;
  if (ALIASES[input])
    return ALIASES[input];
  for (const [re, replacement] of PATTERNS) {
    if (re.test(input))
      return input.replace(re, replacement);
  }
  return input;
}
var DISPLAY_PATTERNS = [
  [/^claude-(opus|sonnet|haiku)-(\d+)-(\d+)-\d{8,}$/, (m) => {
    const tier = m[1][0].toUpperCase() + m[1].slice(1);
    return `${tier} ${m[2]}.${m[3]}`;
  }],
  [/^claude-(opus|sonnet|haiku)-(\d+)-(\d{1,2})$/, (m) => {
    const tier = m[1][0].toUpperCase() + m[1].slice(1);
    return `${tier} ${m[2]}.${m[3]}`;
  }],
  [/^claude-(opus|sonnet|haiku)-(\d+)-\d{8,}$/, (m) => {
    const tier = m[1][0].toUpperCase() + m[1].slice(1);
    return `${tier} ${m[2]}`;
  }],
  [/^gpt-(\d+\.\d+)-codex$/, (m) => `Codex ${m[1]}`],
  [/^gpt-(\d+\.\d+)$/, (m) => `GPT ${m[1]}`]
];
function displayModel(fullId) {
  if (!fullId)
    return "";
  const modelId = fullId.includes("/") ? fullId.slice(fullId.indexOf("/") + 1) : fullId;
  for (const [re, fmt] of DISPLAY_PATTERNS) {
    const m = modelId.match(re);
    if (m)
      return fmt(m);
  }
  return modelId;
}
var CONTEXT_WINDOWS = {
  "anthropic/claude-opus-4-6": 200000,
  "anthropic/claude-sonnet-4-20250514": 200000,
  "anthropic/claude-haiku-4-5-20251001": 200000,
  "openai/gpt-5.4": 128000,
  "openai/gpt-5.3": 128000,
  "openai/gpt-5.3-codex": 128000,
  "google/gemini-2.5-flash": 1e6,
  "google/gemini-2.5-pro": 1e6
};
function contextWindow(fullId) {
  return CONTEXT_WINDOWS[fullId] ?? 200000;
}
var PRICING = {
  "anthropic/claude-opus-4-6": { input: 5, output: 25 },
  "anthropic/claude-sonnet-4-20250514": { input: 3, output: 15 },
  "anthropic/claude-haiku-4-5-20251001": { input: 1, output: 5 }
};
function computeCost(fullId, usage) {
  const p = PRICING[fullId];
  if (!p)
    return 0;
  return (usage.input * p.input + usage.output * p.output) / 1e6;
}
function formatCost(fullId, usage) {
  const cost = computeCost(fullId, usage);
  if (cost === 0)
    return "";
  return `$${cost.toFixed(4)}`;
}
function defaultModel() {
  return process.env.HAL_MODEL ? resolveModel(process.env.HAL_MODEL) : "anthropic/claude-opus-4-6";
}
var MODEL_GROUPS = [
  {
    label: "Anthropic",
    models: [
      { alias: "opus", fullId: "anthropic/claude-opus-4-6" },
      { alias: "sonnet", fullId: "anthropic/claude-sonnet-4-20250514" },
      { alias: "haiku", fullId: "anthropic/claude-haiku-4-5-20251001" }
    ]
  },
  {
    label: "OpenAI",
    models: [
      { alias: "gpt", fullId: "openai/gpt-5.4" },
      { alias: "codex", fullId: "openai/gpt-5.3-codex" }
    ]
  },
  {
    label: "Google",
    models: [
      { alias: "gemini", fullId: "google/gemini-2.5-flash" },
      { alias: "gemini-pro", fullId: "google/gemini-2.5-pro" }
    ]
  },
  {
    label: "OpenRouter",
    models: [
      { alias: "grok", fullId: "openrouter/x-ai/grok-4" },
      { alias: "deepseek", fullId: "openrouter/deepseek/deepseek-chat" },
      { alias: "llama", fullId: "openrouter/meta-llama/llama-4-maverick" }
    ]
  }
];
function listModels() {
  const lines = [];
  for (const group of MODEL_GROUPS) {
    lines.push(group.label);
    for (const m of group.models) {
      lines.push(`  ${m.alias.padEnd(14)} ${m.fullId}`);
    }
    lines.push("");
  }
  lines.push("Patterns: opus-X, sonnet-X, haiku-X, gpt-X.Y, gemini-X, grok-X");
  return lines;
}
function estimateTokens(text2) {
  return Math.ceil(text2.length / 4);
}
var models = {
  resolveModel,
  displayModel,
  contextWindow,
  computeCost,
  formatCost,
  defaultModel,
  listModels,
  estimateTokens
};

// src/server/sessions.ts
init_state();
init_ason();
import { readFileSync as readFileSync2, existsSync as existsSync3, mkdirSync as mkdirSync2, rmSync, appendFileSync as appendFileSync2 } from "fs";
import { writeFile, appendFile } from "fs/promises";
var SESSIONS_DIR = `${STATE_DIR}/sessions`;
function sessionDir(sessionId) {
  return `${SESSIONS_DIR}/${sessionId}`;
}
function ensureSessionDir(sessionId) {
  const dir = sessionDir(sessionId);
  if (!existsSync3(dir))
    mkdirSync2(dir, { recursive: true });
}
function loadSessionMeta(sessionId) {
  const path = `${sessionDir(sessionId)}/session.ason`;
  if (!existsSync3(path))
    return null;
  try {
    return ason.parse(readFileSync2(path, "utf-8"));
  } catch {
    return null;
  }
}
function loadHistory(sessionId) {
  const path = `${sessionDir(sessionId)}/history.asonl`;
  if (!existsSync3(path))
    return [];
  try {
    const content = readFileSync2(path, "utf-8");
    if (!content.trim())
      return [];
    return ason.parseAll(content);
  } catch {
    return [];
  }
}
function loadSessionList() {
  const path = `${STATE_DIR}/ipc/state.ason`;
  if (!existsSync3(path))
    return [];
  try {
    const state = ason.parse(readFileSync2(path, "utf-8"));
    return state?.sessions ?? [];
  } catch {
    return [];
  }
}
function loadAllSessions() {
  perf.mark("Loading sessions");
  const ids = loadSessionList();
  if (ids.length === 0)
    return [];
  const result2 = [];
  for (const id of ids) {
    const meta = loadSessionMeta(id);
    if (!meta)
      continue;
    result2.push({ meta, history: loadHistory(id) });
  }
  perf.mark(`Loaded ${result2.length} sessions (${ids.length} listed)`);
  return result2;
}
function loadSessionMetas() {
  const ids = loadSessionList();
  const result2 = [];
  for (const id of ids) {
    const meta = loadSessionMeta(id);
    if (meta)
      result2.push(meta);
  }
  return result2;
}
function loadAllHistory(sessionId) {
  const entries = loadHistory(sessionId);
  if (entries.length === 0)
    return entries;
  const first = entries[0];
  if (first?.type === "forked_from" && first.parent) {
    const parentEntries = loadAllHistory(first.parent);
    const forkTs = first.ts;
    const before = forkTs ? parentEntries.filter((e) => !e.ts || e.ts < forkTs) : parentEntries;
    return [...before, ...entries.slice(1)];
  }
  return entries;
}
async function createSession(id, meta) {
  ensureSessionDir(id);
  const path = `${sessionDir(id)}/session.ason`;
  await writeFile(path, ason.stringify(meta) + `
`);
}
async function appendHistory(sessionId, entries) {
  if (entries.length === 0)
    return;
  ensureSessionDir(sessionId);
  const path = `${sessionDir(sessionId)}/history.asonl`;
  const lines = entries.map((e) => ason.stringify(e, "short")).join(`
`) + `
`;
  await appendFile(path, lines);
}
function appendHistorySync(sessionId, entries) {
  if (entries.length === 0)
    return;
  ensureSessionDir(sessionId);
  const path = `${sessionDir(sessionId)}/history.asonl`;
  const lines = entries.map((e) => ason.stringify(e, "short")).join(`
`) + `
`;
  appendFileSync2(path, lines);
}
async function updateMeta(sessionId, updates) {
  const existing = loadSessionMeta(sessionId);
  if (!existing)
    return;
  const merged = { ...existing, ...updates };
  const path = `${sessionDir(sessionId)}/session.ason`;
  await writeFile(path, ason.stringify(merged) + `
`);
}
async function forkSession(sourceId, newId, atIndex) {
  const sourceMeta = loadSessionMeta(sourceId);
  if (!sourceMeta)
    throw new Error(`Source session ${sourceId} not found`);
  let forkTs = new Date().toISOString();
  if (atIndex !== undefined) {
    const history = loadHistory(sourceId);
    if (atIndex >= 0 && atIndex < history.length && history[atIndex].ts) {
      forkTs = history[atIndex].ts;
    }
  }
  const newMeta = {
    id: newId,
    workingDir: sourceMeta.workingDir,
    createdAt: forkTs,
    topic: sourceMeta.topic ? `Fork of ${sourceMeta.topic}` : undefined,
    model: sourceMeta.model
  };
  await createSession(newId, newMeta);
  await appendHistory(newId, [{ type: "forked_from", parent: sourceId, ts: forkTs }]);
}
function deleteSession(sessionId) {
  const dir = sessionDir(sessionId);
  if (existsSync3(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
async function saveSessionList(ids) {
  const path = `${STATE_DIR}/ipc/state.ason`;
  ensureDir(`${STATE_DIR}/ipc`);
  let existing = {};
  if (existsSync3(path)) {
    try {
      existing = ason.parse(readFileSync2(path, "utf-8"));
    } catch {}
  }
  existing.sessions = ids;
  await writeFile(path, ason.stringify(existing) + `
`);
}
var pruneConfig = {
  maxAgeDays: 90,
  maxCount: 200
};
function pruneSessions() {
  const ids = loadSessionList();
  if (ids.length === 0)
    return { deleted: 0 };
  const now = Date.now();
  const maxAge = pruneConfig.maxAgeDays * 24 * 60 * 60 * 1000;
  const keep = [];
  let deleted = 0;
  for (const id of ids) {
    const meta = loadSessionMeta(id);
    if (!meta) {
      deleted++;
      continue;
    }
    const age = now - new Date(meta.createdAt).getTime();
    if (age > maxAge) {
      deleteSession(id);
      deleted++;
    } else {
      keep.push(id);
    }
  }
  if (keep.length > pruneConfig.maxCount) {
    const excess = keep.splice(0, keep.length - pruneConfig.maxCount);
    for (const id of excess) {
      deleteSession(id);
      deleted++;
    }
  }
  if (deleted > 0) {
    ensureDir(`${STATE_DIR}/ipc`);
    const path = `${STATE_DIR}/ipc/state.ason`;
    let existing = {};
    if (existsSync3(path)) {
      try {
        existing = ason.parse(readFileSync2(path, "utf-8"));
      } catch {}
    }
    existing.sessions = keep;
    const { writeFileSync: writeFileSync2 } = __require("fs");
    writeFileSync2(path, ason.stringify(existing) + `
`);
  }
  return { deleted };
}
function detectInterruptedTools(entries) {
  const completedToolIds = new Set;
  for (const m of entries) {
    if (m.role === "tool_result" && m.tool_use_id)
      completedToolIds.add(m.tool_use_id);
  }
  for (let i = entries.length - 1;i >= 0; i--) {
    const m = entries[i];
    if (m.role === "assistant" && Array.isArray(m.tools)) {
      const interrupted = [];
      for (const t of m.tools) {
        if (!completedToolIds.has(t.id)) {
          interrupted.push({ name: t.name, id: t.id });
        }
      }
      return interrupted;
    }
  }
  return [];
}
var sessions = {
  loadAllSessions,
  loadSessionMetas,
  loadSessionList,
  loadSessionMeta,
  loadHistory,
  loadAllHistory,
  createSession,
  appendHistory,
  appendHistorySync,
  updateMeta,
  forkSession,
  deleteSession,
  saveSessionList,
  pruneSessions,
  pruneConfig,
  detectInterruptedTools,
  sessionDir
};

// src/runtime/commands.ts
import { existsSync as existsSync5 } from "fs";
import { resolve as resolve2 } from "path";
import { homedir } from "os";

// src/runtime/context.ts
init_state();
import { existsSync as existsSync4, readFileSync as readFileSync3 } from "fs";
import { dirname } from "path";
function findGitRoot(from) {
  if (existsSync4(`${from}/.git`))
    return from;
  const parent = dirname(from);
  if (parent === from)
    return null;
  return findGitRoot(parent);
}
function directoryChain(cwd, root) {
  const dirs = [cwd];
  let dir = cwd;
  while (dir !== root) {
    dir = dirname(dir);
    dirs.unshift(dir);
  }
  return dirs;
}
function readAgentFile(dir) {
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const path = `${dir}/${name}`;
    try {
      const content = readFileSync3(path, "utf-8");
      return { path, name, content, bytes: Buffer.byteLength(content) };
    } catch {}
  }
  return null;
}
function collectAgentFiles(cwd) {
  const root = findGitRoot(cwd) ?? cwd;
  return directoryChain(cwd, root).map(readAgentFile).filter((f) => f !== null);
}
function agentWatchDirs(cwd) {
  const root = findGitRoot(cwd) ?? cwd;
  return directoryChain(cwd, root);
}
function processDirectives(text2, vars) {
  const lines = text2.split(`
`);
  const out = [];
  let skip = false;
  for (const line of lines) {
    const open2 = line.match(/^:{3,}\s+if\s+(\w+)="([^"]+)"\s*$/);
    if (open2) {
      const val = vars[open2[1]] ?? "";
      const re = new RegExp("^" + open2[2].replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
      skip = !re.test(val);
      continue;
    }
    if (/^:{3,}\s*$/.test(line)) {
      skip = false;
      continue;
    }
    if (!skip)
      out.push(line);
  }
  return out.join(`
`);
}
function buildSystemPrompt(opts) {
  const model = opts.model ?? "";
  const cwd = opts.cwd ?? process.cwd();
  const d = new Date;
  const date = `${d.toISOString().slice(0, 10)}, ${d.toLocaleDateString("en-US", { weekday: "long" })}`;
  const vars = {
    model,
    date,
    cwd,
    hal_dir: HAL_DIR,
    state_dir: STATE_DIR,
    session_dir: opts.sessionDir ?? ""
  };
  const sub = (s) => s.replace(/\$\{model\}/g, model).replace(/\$\{cwd\}/g, cwd).replace(/\$\{date\}/g, date).replace(/\$\{hal_dir\}/g, HAL_DIR).replace(/\$\{state_dir\}/g, STATE_DIR).replace(/\$\{session_dir\}/g, opts.sessionDir ?? "");
  const parts = [];
  const loaded = [];
  try {
    let text3 = readFileSync3(`${HAL_DIR}/SYSTEM.md`, "utf-8");
    const bytes = Buffer.byteLength(text3);
    text3 = text3.replace(/<!--[\s\S]*?-->/g, "");
    parts.push(text3);
    loaded.push({ name: "SYSTEM.md", path: `${HAL_DIR}/SYSTEM.md`, bytes });
  } catch {
    parts.push("You are a helpful coding assistant.");
  }
  for (const agent of collectAgentFiles(cwd)) {
    parts.push(agent.content);
    loaded.push({ name: agent.name, path: agent.path, bytes: agent.bytes });
  }
  const text2 = parts.map((p) => processDirectives(p, vars)).map(sub).join(`

`).replace(/\n{3,}/g, `

`);
  return { text: text2, loaded, bytes: Buffer.byteLength(text2) };
}
function messageBytes(msg) {
  if (typeof msg.content === "string")
    return msg.content.length;
  if (Array.isArray(msg.content)) {
    let bytes = 0;
    for (const block of msg.content) {
      if (block.type === "text")
        bytes += block.text?.length ?? 0;
      else if (block.type === "thinking")
        bytes += block.thinking?.length ?? 0;
      else if (block.type === "tool_use")
        bytes += JSON.stringify(block.input ?? {}).length;
      else if (block.type === "tool_result") {
        bytes += typeof block.content === "string" ? block.content.length : JSON.stringify(block.content ?? "").length;
      }
    }
    return bytes;
  }
  return 0;
}
function estimateContext(messages, modelId, overheadBytes = 0) {
  let totalBytes = Math.max(0, overheadBytes);
  for (const msg of messages)
    totalBytes += messageBytes(msg);
  const max = models.contextWindow(modelId);
  return { used: Math.ceil(totalBytes / 4), max, estimated: true };
}
function formatBytes(n) {
  if (n < 1024)
    return `${n}B`;
  return `${(n / 1024).toFixed(1)}KB`;
}
var context = {
  buildSystemPrompt,
  collectAgentFiles,
  agentWatchDirs,
  findGitRoot,
  messageBytes,
  estimateContext,
  formatBytes
};

// src/runtime/commands.ts
function parseCommand(text2) {
  const trimmed = text2.trim();
  if (!trimmed.startsWith("/"))
    return null;
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) {
    return { name: trimmed.slice(1), args: "" };
  }
  return {
    name: trimmed.slice(1, spaceIdx),
    args: trimmed.slice(spaceIdx + 1).trim()
  };
}
var handlers = {};
handlers["help"] = () => {
  const lines = [
    "Available commands:",
    "  /model [name]   Switch model or list available models",
    "  /clear          Clear session history",
    "  /fork           Fork current session to new tab",
    "  /compact        Summarize conversation to reduce context",
    "  /cd [path]      Change working directory",
    "  /system         Show full preprocessed system prompt",
    "  /show [what]    Show system prompt, context, model",
    "  /help           Show this help",
    "  /exit           Quit Hal",
    "  /eval [code]    Run JavaScript in the runtime"
  ];
  return { output: lines.join(`
`), handled: true };
};
handlers["model"] = (args2, session2, emitInfo) => {
  if (!args2) {
    const current = session2.model ?? models.defaultModel();
    const display2 = models.displayModel(current);
    const lines = [
      `Current: ${display2} (${current})`,
      "",
      ...models.listModels()
    ];
    return { output: lines.join(`
`), handled: true };
  }
  const oldModel = session2.model ?? models.defaultModel();
  const newModel = models.resolveModel(args2);
  session2.model = newModel;
  const display = models.displayModel(newModel);
  return { output: `Model set to ${display} (${newModel})`, handled: true };
};
handlers["clear"] = (_args, session2) => {
  return { output: "Conversation cleared.", handled: true };
};
handlers["fork"] = (_args, session2) => {
  ipc.appendCommand({
    type: "open",
    text: `fork:${session2.id}`,
    sessionId: session2.id
  });
  return { output: `Forking session ${session2.id}...`, handled: true };
};
handlers["compact"] = (_args, session2) => {
  ipc.appendCommand({
    type: "compact",
    sessionId: session2.id
  });
  return { output: "Compacting conversation...", handled: true };
};
handlers["cd"] = (args2, session2) => {
  if (!args2) {
    return { output: `cwd: ${session2.cwd}`, handled: true };
  }
  const raw = args2.replace(/^~(?=$|\/)/, homedir());
  const target = resolve2(session2.cwd, raw);
  if (!existsSync5(target)) {
    return { error: `cd failed: ${target}: not found`, handled: true };
  }
  const old = session2.cwd;
  session2.cwd = target;
  const agents = context.collectAgentFiles(target);
  const parts = [
    `cwd: ${old} -> ${target}`
  ];
  if (agents.length > 0) {
    const files = agents.map((f) => `${f.name} (${context.formatBytes(f.bytes)})`);
    parts.push(`Loaded ${files.join(", ")}`);
  }
  return { output: parts.join(`
`), handled: true };
};
handlers["system"] = (_args, session2) => {
  const model = session2.model ?? models.defaultModel();
  const result2 = context.buildSystemPrompt({ model, cwd: session2.cwd });
  const header = result2.loaded.map((f) => `  ${f.name} (${context.formatBytes(f.bytes)}) — ${f.path}`).join(`
`);
  return {
    output: `${header}
  Total: ${context.formatBytes(result2.bytes)}

${result2.text}`,
    handled: true
  };
};
handlers["show"] = (args2, session2) => {
  const what = args2 || "prompt";
  if (what === "prompt" || what === "system") {
    const model = session2.model ?? models.defaultModel();
    const result2 = context.buildSystemPrompt({
      model,
      cwd: session2.cwd
    });
    const lines = [
      `System prompt (${context.formatBytes(result2.bytes)}):`,
      ""
    ];
    for (const f of result2.loaded) {
      lines.push(`  ${f.name} (${context.formatBytes(f.bytes)}) — ${f.path}`);
    }
    lines.push("");
    const maxLen = 2000;
    if (result2.text.length > maxLen) {
      lines.push(result2.text.slice(0, maxLen));
      lines.push(`
... (${result2.text.length - maxLen} more chars)`);
    } else {
      lines.push(result2.text);
    }
    return { output: lines.join(`
`), handled: true };
  }
  if (what === "model") {
    const model = session2.model ?? models.defaultModel();
    const display = models.displayModel(model);
    const ctxWindow = models.contextWindow(model);
    return {
      output: [
        `Model: ${display} (${model})`,
        `Context window: ${(ctxWindow / 1000).toFixed(0)}k tokens`
      ].join(`
`),
      handled: true
    };
  }
  if (what === "context") {
    const model = session2.model ?? models.defaultModel();
    const ctxWindow = models.contextWindow(model);
    return {
      output: [
        `Model: ${models.displayModel(model)}`,
        `Context window: ${(ctxWindow / 1000).toFixed(0)}k tokens`,
        `Working dir: ${session2.cwd}`
      ].join(`
`),
      handled: true
    };
  }
  return { error: `/show: unknown topic "${what}". Try: prompt, model, context`, handled: true };
};
handlers["exit"] = () => {
  setTimeout(() => process.exit(0), 100);
  return { output: "Goodbye.", handled: true };
};
handlers["eval"] = async (args, session) => {
  if (!args) {
    return { error: "/eval <code>", handled: true };
  }
  try {
    const result = await eval(args);
    const text = result === undefined ? "(undefined)" : String(result);
    return { output: text.slice(0, 5000), handled: true };
  } catch (err) {
    return { error: `eval error: ${err?.message ?? String(err)}`, handled: true };
  }
};
async function executeCommand(text2, session2, emitInfo) {
  const parsed = parseCommand(text2);
  if (!parsed)
    return { handled: false };
  const handler = handlers[parsed.name];
  if (!handler) {
    return { error: `Unknown command: /${parsed.name}. Type /help for help.`, handled: true };
  }
  return await handler(parsed.args, session2, emitInfo);
}
function commandNames() {
  return Object.keys(handlers);
}
var commands = {
  parseCommand,
  executeCommand,
  commandNames
};

// src/runtime/agent-loop.ts
init_provider();
init_tool();

// src/session/blob.ts
import { writeFile as writeFile2 } from "fs/promises";
import { existsSync as existsSync7, mkdirSync as mkdirSync3, readFileSync as readFileSync5 } from "fs";
import { randomBytes } from "crypto";
init_ason();
var ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
var startCache = new Map;
function sessionStart(sessionId) {
  let ts = startCache.get(sessionId);
  if (ts !== undefined)
    return ts;
  const meta = sessions.loadSessionMeta(sessionId);
  ts = meta ? new Date(meta.createdAt).getTime() : Date.now();
  startCache.set(sessionId, ts);
  return ts;
}
function makeBlobId(sessionId) {
  const offset = Math.max(0, Date.now() - sessionStart(sessionId)).toString(36).padStart(6, "0");
  const bytes = randomBytes(3);
  let suffix = "";
  for (let i = 0;i < 3; i++)
    suffix += ID_CHARS[bytes[i] % ID_CHARS.length];
  return `${offset}-${suffix}`;
}
function blobsDir(sessionId) {
  return `${sessions.sessionDir(sessionId)}/blobs`;
}
async function writeBlob(sessionId, blobId, data) {
  const dir = blobsDir(sessionId);
  if (!existsSync7(dir))
    mkdirSync3(dir, { recursive: true });
  await writeFile2(`${dir}/${blobId}.ason`, ason.stringify(data) + `
`);
}
function readBlob(sessionId, blobId) {
  const path = `${blobsDir(sessionId)}/${blobId}.ason`;
  if (!existsSync7(path))
    return null;
  try {
    return ason.parse(readFileSync5(path, "utf-8"));
  } catch {
    return null;
  }
}
function readBlobFromChain(sessionId, blobId) {
  const local = readBlob(sessionId, blobId);
  if (local)
    return local;
  const history = sessions.loadHistory(sessionId);
  if (history.length > 0 && history[0]?.type === "forked_from" && history[0].parent) {
    return readBlobFromChain(history[0].parent, blobId);
  }
  return null;
}
var blob = {
  makeBlobId,
  writeBlob,
  readBlob,
  readBlobFromChain,
  blobsDir
};

// src/tools/bash.ts
init_tool();
var config2 = {
  defaultTimeout: 120000,
  maxOutputBytes: 1e6
};
function childPids(parentPid) {
  const result2 = Bun.spawnSync(["pgrep", "-P", String(parentPid)], {
    stdout: "pipe",
    stderr: "ignore"
  });
  if (result2.exitCode !== 0)
    return [];
  const text2 = new TextDecoder().decode(result2.stdout).trim();
  if (!text2)
    return [];
  return text2.split(/\s+/).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0);
}
function killProcessTree(rootPid, signal) {
  for (const pid of childPids(rootPid))
    killProcessTree(pid, signal);
  try {
    process.kill(rootPid, signal);
  } catch {}
}
function truncateOutput(text2) {
  if (text2.length <= config2.maxOutputBytes)
    return text2;
  const half = Math.floor(config2.maxOutputBytes / 2);
  const truncated = text2.length - config2.maxOutputBytes;
  return text2.slice(0, half) + `

[… truncated ${truncated} bytes …]

` + text2.slice(-half);
}
async function execute(input, ctx) {
  const command = String(input?.command ?? "");
  if (!command.trim())
    return "error: empty command";
  const timeout = input?.timeout ?? config2.defaultTimeout;
  const proc = Bun.spawn(["bash", "-lc", command], {
    cwd: ctx.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, TERM: "dumb" }
  });
  let abortCleanup;
  if (ctx.signal) {
    const onAbort = () => {
      killProcessTree(proc.pid, "SIGTERM");
      const timer2 = setTimeout(() => killProcessTree(proc.pid, "SIGKILL"), 2000);
      timer2.unref?.();
    };
    if (ctx.signal.aborted) {
      onAbort();
    } else {
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      abortCleanup = () => ctx.signal.removeEventListener("abort", onAbort);
    }
  }
  const timer = setTimeout(() => {
    killProcessTree(proc.pid, "SIGTERM");
    setTimeout(() => killProcessTree(proc.pid, "SIGKILL"), 2000);
  }, timeout);
  let out = "";
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder;
  while (true) {
    const { done, value } = await reader.read();
    if (done)
      break;
    out += decoder.decode(value, { stream: true });
  }
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  clearTimeout(timer);
  abortCleanup?.();
  if (ctx.signal?.aborted) {
    return truncateOutput(out + (stderr ? `
` + stderr : "") + `
[interrupted]`);
  }
  if (stderr)
    out += (out ? `
` : "") + stderr;
  if (code !== 0)
    out += `
[exit ${code}]`;
  return truncateOutput(out || "(no output)");
}
toolRegistry.registerTool({
  name: "bash",
  description: "Run a bash command. Output is captured and returned.",
  parameters: {
    command: { type: "string", description: "The bash command to execute" },
    timeout: { type: "integer", description: "Timeout in ms (default: 120000)" }
  },
  required: ["command"],
  execute
});

// src/tools/read.ts
init_tool();
import { readFileSync as readFileSync6, statSync as statSync2 } from "fs";
import { isAbsolute, resolve as resolve3 } from "path";
import { homedir as homedir2 } from "os";
var HOME = homedir2();
var MAX_OUTPUT = 1e6;
function resolvePath(path, cwd) {
  if (!path?.trim())
    return cwd;
  if (path.startsWith("~/"))
    path = HOME + path.slice(1);
  return isAbsolute(path) ? path : resolve3(cwd, path);
}
function formatLines(content, start, end) {
  const lines = content.split(`
`);
  if (lines.length > 0 && lines[lines.length - 1] === "")
    lines.pop();
  const s = Math.max(1, start);
  const e = Math.min(lines.length, end ?? lines.length);
  const width = String(e).length;
  return lines.slice(s - 1, e).map((line, i) => `${String(s + i).padStart(width)} ${line}`).join(`
`);
}
async function execute2(input, ctx) {
  const path = resolvePath(input?.path, ctx.cwd);
  try {
    const stat = statSync2(path);
    if (stat.isDirectory())
      return `error: ${path} is a directory, not a file`;
    if (stat.size > 5000000)
      return `error: file too large (${stat.size} bytes)`;
  } catch (e) {
    return `error: ${e.message}`;
  }
  let content;
  try {
    content = readFileSync6(path, "utf-8");
  } catch (e) {
    return `error: ${e.message}`;
  }
  if (content.slice(0, 8192).includes("\x00")) {
    return `error: ${path} appears to be a binary file`;
  }
  const result2 = formatLines(content, input?.start ?? 1, input?.end);
  if (result2.length > MAX_OUTPUT) {
    return result2.slice(0, MAX_OUTPUT) + `
[… truncated]`;
  }
  return result2;
}
toolRegistry.registerTool({
  name: "read",
  description: "Read a file with line numbers. Use optional start/end for a line range.",
  parameters: {
    path: { type: "string", description: "File path (absolute or relative to cwd)" },
    start: { type: "integer", description: "First line number (1-based, inclusive)" },
    end: { type: "integer", description: "Last line number (inclusive)" }
  },
  required: ["path"],
  execute: execute2
});
var read = { resolvePath, formatLines, execute: execute2 };

// src/tools/read_blob.ts
init_tool();
var MAX_OUTPUT2 = 1e6;
async function execute3(input, ctx) {
  const id = input?.id;
  if (!id || typeof id !== "string")
    return "error: id parameter is required";
  const data = blob.readBlobFromChain(ctx.sessionId, id);
  if (data === null)
    return `error: blob "${id}" not found`;
  const text2 = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  if (text2.length > MAX_OUTPUT2) {
    return text2.slice(0, MAX_OUTPUT2) + `
[… truncated — ${text2.length - MAX_OUTPUT2} more chars]`;
  }
  return text2;
}
toolRegistry.registerTool({
  name: "read_blob",
  description: "Read a stored blob by ID. Blobs are immutable snapshots of tool outputs, images, and thinking blocks from conversation history.",
  parameters: {
    id: { type: "string", description: 'Blob ID (found in history entries like "blob <id>")' }
  },
  required: ["id"],
  execute: execute3
});

// src/tools/grep.ts
init_tool();
async function execute4(input, ctx) {
  const pattern = String(input?.pattern ?? "");
  if (!pattern)
    return "error: pattern is required";
  const searchPath = read.resolvePath(input?.path, ctx.cwd);
  const maxResults = input?.maxResults ?? 100;
  const args2 = [
    "rg",
    "-nH",
    "--no-heading",
    "--color=never",
    "--hidden",
    "--no-ignore",
    `--max-count=${maxResults}`,
    "--sort=modified"
  ];
  if (input?.include)
    args2.push("--glob", String(input.include));
  args2.push("--", pattern, searchPath);
  const proc = Bun.spawn(args2, {
    stdout: "pipe",
    stderr: "pipe",
    cwd: ctx.cwd
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  const result2 = stdout.trim();
  if (!result2) {
    if (stderr.trim() && proc.exitCode !== 1)
      return `error: ${stderr.trim()}`;
    return "No matches found.";
  }
  if (result2.length > 1e6) {
    return result2.slice(0, 1e6) + `
[… truncated]`;
  }
  return result2;
}
toolRegistry.registerTool({
  name: "grep",
  description: "Search file contents using ripgrep. Returns matching lines with file paths and line numbers.",
  parameters: {
    pattern: { type: "string", description: "Search pattern (regex)" },
    path: { type: "string", description: "Directory or file to search (default: cwd)" },
    include: { type: "string", description: "Glob pattern to filter files, e.g. '*.ts'" },
    maxResults: { type: "integer", description: "Max matches per file (default: 100)" }
  },
  required: ["pattern"],
  execute: execute4
});

// src/tools/glob.ts
init_tool();
async function execute5(input, ctx) {
  const pattern = String(input?.pattern ?? "");
  if (!pattern)
    return "error: pattern is required";
  const searchPath = read.resolvePath(input?.path, ctx.cwd);
  const args2 = [
    "rg",
    "--files",
    "--hidden",
    "--no-ignore",
    "--sort=modified",
    "--glob",
    pattern,
    searchPath
  ];
  const proc = Bun.spawn(args2, {
    stdout: "pipe",
    stderr: "pipe",
    cwd: ctx.cwd
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  const result2 = stdout.trim();
  if (!result2)
    return "No files found.";
  if (result2.length > 1e6) {
    return result2.slice(0, 1e6) + `
[… truncated]`;
  }
  return result2;
}
toolRegistry.registerTool({
  name: "glob",
  description: "Find files by glob pattern. Returns matching file paths sorted by modification time.",
  parameters: {
    pattern: { type: "string", description: "Glob pattern, e.g. '*.ts', 'src/**/*.tsx'" },
    path: { type: "string", description: "Directory to search in (default: cwd)" }
  },
  required: ["pattern"],
  execute: execute5
});

// src/tools/write.ts
init_tool();
import { readFileSync as readFileSync7, existsSync as existsSync8, mkdirSync as mkdirSync4 } from "fs";
import { dirname as dirname3 } from "path";
function ensureParent(path) {
  const dir = dirname3(path);
  if (!existsSync8(dir))
    mkdirSync4(dir, { recursive: true });
}
var locks = new Map;
async function withLock(path, fn) {
  const prev = locks.get(path) ?? Promise.resolve();
  const result2 = prev.then(fn, fn);
  const done = result2.then(() => {}, () => {});
  locks.set(path, done);
  done.then(() => {
    if (locks.get(path) === done)
      locks.delete(path);
  });
  return result2;
}
async function executeWrite(input, ctx) {
  const path = read.resolvePath(input?.path, ctx.cwd);
  const content = String(input?.content ?? "");
  return withLock(path, async () => {
    ensureParent(path);
    await Bun.write(path, content);
    const lines = content.split(`
`);
    const preview = lines.slice(0, 5).join(`
`);
    if (lines.length <= 5)
      return `Wrote ${path} (${lines.length} lines)
${preview}`;
    return `Wrote ${path} (${lines.length} lines)
${preview}
[+ ${lines.length - 5} more lines]`;
  });
}
toolRegistry.registerTool({
  name: "write",
  description: "Create or overwrite a file with the given content.",
  parameters: {
    path: { type: "string", description: "File path (absolute or relative to cwd)" },
    content: { type: "string", description: "Full file content" }
  },
  required: ["path", "content"],
  execute: executeWrite
});
async function executeEdit(input, ctx) {
  const path = read.resolvePath(input?.path, ctx.cwd);
  const oldString = String(input?.old_string ?? "");
  const newString = String(input?.new_string ?? "");
  if (!oldString)
    return "error: old_string is required";
  if (oldString === newString)
    return "error: old_string and new_string are identical";
  return withLock(path, async () => {
    let content;
    try {
      content = readFileSync7(path, "utf-8");
    } catch {
      return `error: file not found: ${path}`;
    }
    const count = content.split(oldString).length - 1;
    if (count === 0)
      return `error: old_string not found in ${path}`;
    if (count > 1)
      return `error: old_string found ${count} times in ${path} (must be unique)`;
    const updated = content.replace(oldString, newString);
    ensureParent(path);
    await Bun.write(path, updated);
    const idx = content.indexOf(oldString);
    const before = content.slice(0, idx);
    const lineNum = before.split(`
`).length;
    const oldLines = oldString.split(`
`);
    const newLines = newString.split(`
`);
    let diff = `Edited ${path} at line ${lineNum}
`;
    for (const line of oldLines)
      diff += `- ${line}
`;
    for (const line of newLines)
      diff += `+ ${line}
`;
    return diff.trimEnd();
  });
}
toolRegistry.registerTool({
  name: "edit",
  description: "Surgical string replacement in a file. Finds the exact old_string and replaces it with new_string. old_string must appear exactly once in the file.",
  parameters: {
    path: { type: "string", description: "File path (absolute or relative to cwd)" },
    old_string: { type: "string", description: "Exact text to find (must be unique in file)" },
    new_string: { type: "string", description: "Replacement text" }
  },
  required: ["path", "old_string", "new_string"],
  execute: executeEdit
});

// src/tools/eval.ts
init_tool();
init_state();
import { mkdirSync as mkdirSync5 } from "fs";
import { join } from "path";
var counter = 0;
var config3 = {
  timeout: 1e4
};
async function execute6(input, ctx) {
  const code = String(input?.code ?? "");
  if (!code.trim())
    return "error: empty code";
  const evalDir = join(STATE_DIR, "sessions", ctx.sessionId, "eval");
  mkdirSync5(evalDir, { recursive: true });
  const file = join(evalDir, `${Date.now()}-${counter++}.ts`);
  const lines = code.split(`
`);
  const imports = [];
  const body = [];
  for (const line of lines) {
    if (/^\s*import\s/.test(line))
      imports.push(line);
    else
      body.push(line);
  }
  const wrapped = [
    ...imports,
    imports.length ? "" : undefined,
    "export default async (ctx: any) => {",
    ...body,
    "}",
    ""
  ].filter((l) => l !== undefined).join(`
`);
  await Bun.write(file, wrapped);
  try {
    const mod = await import(file);
    const evalCtx = {
      sessionId: ctx.sessionId,
      cwd: ctx.cwd,
      halDir: join(STATE_DIR, ".."),
      stateDir: STATE_DIR,
      signal: ctx.signal
    };
    const run = mod.default(evalCtx);
    const promises = [run];
    if (ctx.signal) {
      promises.push(new Promise((_, reject) => {
        if (ctx.signal.aborted)
          reject(new DOMException("Aborted", "AbortError"));
        else
          ctx.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      }));
    }
    promises.push(new Promise((_, reject) => setTimeout(() => reject(new Error(`eval timed out after ${config3.timeout}ms`)), config3.timeout)));
    const result2 = await Promise.race(promises);
    if (result2 === undefined)
      return "undefined";
    return typeof result2 === "string" ? result2 : JSON.stringify(result2);
  } catch (err) {
    if (ctx.signal?.aborted)
      return "[interrupted]";
    return `${err.stack ?? err.message}`;
  }
}
toolRegistry.registerTool({
  name: "eval",
  description: "Execute TypeScript in the Hal process. Has access to runtime internals via ctx (sessionId, cwd, halDir, stateDir). Use `return` to return a value. Use standard `import` for module access.",
  parameters: {
    code: { type: "string", description: "TypeScript code. Imports go at top, body is wrapped in async function with ctx in scope." }
  },
  required: ["code"],
  execute: execute6
});

// src/tools/send.ts
init_tool();
init_inbox();
async function execute7(input, ctx) {
  const targetId = String(input?.sessionId ?? "");
  const text2 = String(input?.text ?? "");
  if (!targetId)
    return "error: sessionId is required";
  if (!text2)
    return "error: text is required";
  if (targetId === ctx.sessionId)
    return "error: cannot send to own session";
  try {
    inbox.queueMessage(targetId, text2, ctx.sessionId);
    return `Sent message to session ${targetId}`;
  } catch (err) {
    return `error: ${err?.message ?? String(err)}`;
  }
}
toolRegistry.registerTool({
  name: "send",
  description: "Send a message to another session's inbox. The message will be processed as a prompt (if idle) or queued (if busy).",
  parameters: {
    sessionId: { type: "string", description: 'Target session ID (or "all" for broadcast)' },
    text: { type: "string", description: "Message text" }
  },
  required: ["sessionId", "text"],
  execute: execute7
});

// src/runtime/agent-loop.ts
var config4 = {
  maxIterations: 50,
  maxToolConcurrency: 5,
  retryBaseDelayMs: 5000,
  retryMaxTotalMs: 2 * 60 * 60 * 1000,
  retryableStatuses: new Set([429, 500, 503, 529])
};
var state = {
  activeRequests: new Map
};
async function getProvider2(name) {
  return provider.getProvider(name);
}
function emitEvent(sessionId, event) {
  ipc.appendEvent({
    id: protocol.eventId(),
    sessionId,
    createdAt: new Date().toISOString(),
    ...event
  });
}
function emitInfo(sessionId, text2, level = "info") {
  emitEvent(sessionId, { type: "info", text: text2, level });
}
function computeRetryDelay(retryAfterMs, attempt) {
  const base = retryAfterMs ?? config4.retryBaseDelayMs * Math.pow(2, attempt);
  const jitterRange = attempt === 0 ? 1000 : attempt === 1 ? 2000 : 5000;
  const jitter = (Math.random() * 2 - 1) * jitterRange;
  return Math.max(1000, Math.round(base + jitter));
}
function isRetryableStatus(status) {
  return status != null && config4.retryableStatuses.has(status);
}
function parseResetsInSeconds(body) {
  if (!body)
    return;
  try {
    const json = JSON.parse(body);
    const secs = json?.error?.resets_in_seconds ?? json?.resets_in_seconds;
    if (typeof secs === "number" && secs > 0)
      return secs * 1000;
  } catch {}
  return;
}
function formatErrorBody(body) {
  try {
    const parsed = JSON.parse(body);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return body;
  }
}
async function executeTool(call, signal, cwd, sessionId) {
  const context2 = {
    sessionId: sessionId ?? "unknown",
    cwd: cwd ?? process.cwd(),
    signal
  };
  return toolRegistry.dispatch(call.name, call.input, context2);
}
async function runAgentLoop(ctx) {
  const { sessionId, model, systemPrompt, messages, signal } = ctx;
  const slashIdx = model.indexOf("/");
  const providerName = slashIdx >= 0 ? model.slice(0, slashIdx) : "stub";
  const modelId = slashIdx >= 0 ? model.slice(slashIdx + 1) : model;
  const provider2 = await getProvider2(providerName);
  const ac = new AbortController;
  state.activeRequests.set(sessionId, ac);
  if (signal) {
    if (signal.aborted) {
      ac.abort();
      return;
    }
    signal.addEventListener("abort", () => ac.abort(), { once: true });
  }
  const loopSignal = ac.signal;
  const tools = toolRegistry.toToolDefs();
  const overheadBytes = systemPrompt.length + JSON.stringify(tools).length;
  await ctx.onStatus?.(true, "generating...");
  try {
    const totalUsage = { input: 0, output: 0 };
    let retryAttempt = 0;
    let retryStartedAt = 0;
    for (let iteration = 0;iteration < config4.maxIterations; iteration++) {
      if (loopSignal.aborted)
        break;
      const gen = provider2.generate({
        messages,
        model: modelId,
        systemPrompt,
        tools,
        signal: loopSignal,
        sessionId
      });
      let assistantText = "";
      let thinkingText = "";
      let thinkingSignature = "";
      const toolCalls = [];
      let aborted = false;
      let shouldRetry = false;
      try {
        for await (const event of gen) {
          if (loopSignal.aborted) {
            aborted = true;
            break;
          }
          switch (event.type) {
            case "thinking":
              thinkingText += event.text ?? "";
              emitEvent(sessionId, {
                type: "stream-delta",
                text: event.text,
                channel: "thinking"
              });
              break;
            case "thinking_signature":
              thinkingSignature = event.signature ?? "";
              break;
            case "text":
              assistantText += event.text ?? "";
              emitEvent(sessionId, {
                type: "stream-delta",
                text: event.text,
                channel: "assistant"
              });
              break;
            case "tool_call":
              toolCalls.push({
                id: event.id,
                name: event.name,
                input: event.input
              });
              emitEvent(sessionId, {
                type: "tool-call",
                toolId: event.id,
                name: event.name,
                phase: "running"
              });
              break;
            case "error": {
              const status = event.status;
              const header = status ? `${status}:` : "Error:";
              const body = event.body ?? event.message ?? "Unknown error";
              emitEvent(sessionId, {
                type: "response",
                text: `${header}
${formatErrorBody(body)}`,
                isError: true
              });
              if (isRetryableStatus(status)) {
                if (!retryStartedAt)
                  retryStartedAt = Date.now();
                const elapsed2 = Date.now() - retryStartedAt;
                if (elapsed2 < config4.retryMaxTotalMs) {
                  const bodyDelay = parseResetsInSeconds(event.body);
                  const delay = bodyDelay ?? computeRetryDelay(event.retryAfterMs, retryAttempt);
                  retryAttempt++;
                  const delaySec = Math.ceil(delay / 1000);
                  emitInfo(sessionId, `Rate limited — retrying in ${delaySec}s`);
                  await ctx.onStatus?.(true, `rate limited — retrying in ${delaySec}s...`);
                  await Bun.sleep(delay);
                  shouldRetry = true;
                }
              }
              break;
            }
            case "done": {
              if (!shouldRetry) {
                retryAttempt = 0;
                retryStartedAt = 0;
              }
              if (event.usage) {
                totalUsage.input += event.usage.input;
                totalUsage.output += event.usage.output;
              }
              break;
            }
          }
        }
      } catch (err) {
        if (loopSignal.aborted) {
          aborted = true;
        } else {
          const message = err?.message ? String(err.message) : String(err);
          emitInfo(sessionId, message, "error");
          emitEvent(sessionId, { type: "stream-end", phase: "failed", message });
          return;
        }
      }
      if (aborted) {
        emitInfo(sessionId, "[paused]");
        emitEvent(sessionId, { type: "stream-end", phase: "done" });
        return;
      }
      if (shouldRetry)
        continue;
      if (toolCalls.length === 0) {
        if (assistantText || thinkingText) {
          const historyEntry2 = {
            role: "assistant",
            ts: new Date().toISOString()
          };
          if (assistantText)
            historyEntry2.text = assistantText;
          if (thinkingText && thinkingSignature) {
            const blobId = blob.makeBlobId(sessionId);
            await blob.writeBlob(sessionId, blobId, { thinking: thinkingText, signature: thinkingSignature });
            historyEntry2.thinkingBlobId = blobId;
          }
          if (totalUsage.input > 0)
            historyEntry2.usage = totalUsage;
          await sessions.appendHistory(sessionId, [historyEntry2]);
        }
        if (assistantText) {
          emitEvent(sessionId, { type: "response", text: assistantText });
        }
        emitEvent(sessionId, {
          type: "stream-end",
          phase: "done",
          usage: totalUsage.input > 0 ? totalUsage : undefined
        });
        return;
      }
      const assistantContent = [];
      if (thinkingText && thinkingSignature) {
        assistantContent.push({ type: "thinking", thinking: thinkingText, signature: thinkingSignature });
      }
      if (assistantText) {
        assistantContent.push({ type: "text", text: assistantText });
      }
      for (const tc of toolCalls) {
        assistantContent.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
      }
      messages.push({ role: "assistant", content: assistantContent });
      const toolBlobMap = new Map;
      const historyEntry = {
        role: "assistant",
        ts: new Date().toISOString()
      };
      if (assistantText)
        historyEntry.text = assistantText;
      if (thinkingText && thinkingSignature) {
        const blobId = blob.makeBlobId(sessionId);
        await blob.writeBlob(sessionId, blobId, { thinking: thinkingText, signature: thinkingSignature });
        historyEntry.thinkingBlobId = blobId;
      }
      historyEntry.tools = [];
      for (const tc of toolCalls) {
        const blobId = blob.makeBlobId(sessionId);
        toolBlobMap.set(tc.id, blobId);
        await blob.writeBlob(sessionId, blobId, { call: { name: tc.name, input: tc.input } });
        historyEntry.tools.push({ id: tc.id, name: tc.name, blobId });
      }
      await sessions.appendHistory(sessionId, [historyEntry]);
      await ctx.onStatus?.(true, `running ${toolCalls.length} tool(s)...`);
      const results = await executeToolsConcurrently(toolCalls, loopSignal, ctx.cwd, sessionId);
      for (const { call, result: result2 } of results) {
        messages.push({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: call.id, content: result2 }]
        });
        const blobId = toolBlobMap.get(call.id);
        const existing = blob.readBlob(sessionId, blobId);
        if (existing) {
          existing.result = { content: result2, status: "done" };
          await blob.writeBlob(sessionId, blobId, existing);
        }
        await sessions.appendHistory(sessionId, [{
          role: "tool_result",
          tool_use_id: call.id,
          blobId,
          ts: new Date().toISOString()
        }]);
        emitEvent(sessionId, {
          type: "tool-result",
          toolId: call.id,
          name: call.name,
          output: result2.slice(0, 500),
          phase: "done"
        });
      }
      const est = context.estimateContext(messages, model, overheadBytes);
      await ctx.onStatus?.(true, "generating...");
    }
    emitInfo(sessionId, `Hit max iterations (${config4.maxIterations}). Stopping.`, "error");
    emitEvent(sessionId, { type: "stream-end", phase: "done", usage: totalUsage });
  } finally {
    state.activeRequests.delete(sessionId);
    await ctx.onStatus?.(false);
  }
}
async function executeToolsConcurrently(toolCalls, signal, cwd, sessionId) {
  const results = [];
  for (let i = 0;i < toolCalls.length; i += config4.maxToolConcurrency) {
    if (signal.aborted)
      break;
    const batch = toolCalls.slice(i, i + config4.maxToolConcurrency);
    const batchResults = await Promise.all(batch.map(async (call) => {
      if (signal.aborted)
        return { call, result: "[interrupted]" };
      try {
        const result2 = await executeTool(call, signal, cwd, sessionId);
        return { call, result: result2 };
      } catch (err) {
        return { call, result: `error: ${err?.message ?? String(err)}` };
      }
    }));
    results.push(...batchResults);
  }
  return results;
}
function abort(sessionId) {
  const ac = state.activeRequests.get(sessionId);
  if (ac) {
    ac.abort();
    return true;
  }
  return false;
}
function isActive(sessionId) {
  return state.activeRequests.has(sessionId);
}
var agentLoop = {
  config: config4,
  state,
  runAgentLoop,
  abort,
  isActive
};

// src/session/api-messages.ts
var apiConfig = {
  maxToolOutput: 50000,
  injectTurnTtl: 3,
  heavyThreshold: 4,
  thinkingThreshold: 10
};
function applyModelEvent(current, entry) {
  if (entry?.type !== "session")
    return current;
  if (entry.action === "model-set" && entry.model)
    return entry.model;
  if (entry.action === "model-change" && entry.new)
    return entry.new;
  if (entry.action === "init" && entry.model)
    return entry.model;
  return current;
}
function findReplayStart(entries) {
  for (let i = entries.length - 1;i >= 0; i--) {
    const e = entries[i];
    if (e.type === "reset" || e.type === "compact")
      return i + 1;
  }
  return 0;
}
function toAnthropicMessages(sessionId, allEntries) {
  const entries = allEntries ?? sessions.loadAllHistory(sessionId);
  const start = findReplayStart(entries);
  const sliced = entries.slice(start);
  const out = [];
  let currentModel;
  const totalUserTurns = sliced.filter((m) => m.role === "user").length;
  let userTurnsSeen = 0;
  let pendingInfos = [];
  for (const entry of sliced) {
    currentModel = applyModelEvent(currentModel, entry);
    if (entry.type === "info") {
      const turnsRemaining = totalUserTurns - userTurnsSeen;
      const visibility = entry.visibility ?? (entry.level === "error" ? "next-user" : "ui");
      if (visibility === "next-user" && turnsRemaining <= apiConfig.injectTurnTtl) {
        pendingInfos.push(entry.text ?? "");
      }
      continue;
    }
    if (!entry.role)
      continue;
    if (entry.role === "user") {
      userTurnsSeen++;
      const userContent = buildUserContent(sessionId, entry, pendingInfos);
      pendingInfos = [];
      out.push({ role: "user", content: userContent });
    } else if (entry.role === "assistant") {
      pendingInfos = [];
      const content = buildAssistantContent(sessionId, entry, currentModel);
      if (content.length > 0) {
        if (entry.continuation && out.length > 0 && out[out.length - 1].role === "assistant") {
          out[out.length - 1] = { role: "assistant", content };
        } else {
          out.push({ role: "assistant", content });
        }
      }
    } else if (entry.role === "tool_result") {
      const resultContent = buildToolResultContent(sessionId, entry);
      out.push({ role: "user", content: [resultContent] });
    }
  }
  repairToolPairing(out);
  return pruneMessages(out);
}
function buildUserContent(sessionId, entry, pendingInfos) {
  const infoPrefix = pendingInfos.length > 0 ? pendingInfos.join(`
`) : "";
  if (typeof entry.content === "string") {
    return infoPrefix ? infoPrefix + `
` + entry.content : entry.content;
  }
  if (Array.isArray(entry.content)) {
    const blocks = [];
    if (infoPrefix)
      blocks.push({ type: "text", text: infoPrefix });
    for (const b of entry.content) {
      if (b.type === "image" && b.blobId) {
        const data = blob.readBlobFromChain(sessionId, b.blobId);
        if (data?.media_type && data?.data) {
          blocks.push({
            type: "image",
            source: { type: "base64", media_type: data.media_type, data: data.data }
          });
        } else {
          blocks.push({ type: "text", text: `[image unavailable — blob ${b.blobId}]` });
        }
      } else {
        blocks.push(b);
      }
    }
    return blocks;
  }
  return infoPrefix || "";
}
function buildAssistantContent(sessionId, entry, currentModel) {
  const content = [];
  let thinkingText = entry.thinkingText;
  let thinkingSignature = entry.thinkingSignature;
  if (entry.thinkingBlobId && (!thinkingText || !thinkingSignature)) {
    const blobData = blob.readBlobFromChain(sessionId, entry.thinkingBlobId);
    if (!thinkingText)
      thinkingText = blobData?.thinking;
    if (!thinkingSignature)
      thinkingSignature = blobData?.signature;
  }
  if (thinkingText && thinkingSignature) {
    content.push({ type: "thinking", thinking: thinkingText, signature: thinkingSignature });
  }
  if (entry.text)
    content.push({ type: "text", text: entry.text });
  if (Array.isArray(entry.tools)) {
    for (const t of entry.tools) {
      const blobData = blob.readBlobFromChain(sessionId, t.blobId);
      content.push({ type: "tool_use", id: t.id, name: t.name, input: blobData?.call?.input ?? {} });
    }
  }
  return content;
}
function buildToolResultContent(sessionId, entry) {
  const blobData = blob.readBlobFromChain(sessionId, entry.blobId);
  let resultContent = blobData?.result?.content ?? "[interrupted]";
  if (typeof resultContent === "string" && resultContent.length > apiConfig.maxToolOutput) {
    const truncated = resultContent.length - apiConfig.maxToolOutput;
    resultContent = resultContent.slice(0, apiConfig.maxToolOutput) + `
[truncated ${truncated} chars]`;
  }
  return { type: "tool_result", tool_use_id: entry.tool_use_id, content: resultContent };
}
function repairToolPairing(msgs) {
  for (let i = 0;i < msgs.length; i++) {
    const msg = msgs[i];
    if (msg.role !== "assistant" || !Array.isArray(msg.content))
      continue;
    const toolUseIds = msg.content.filter((b) => b.type === "tool_use").map((b) => b.id);
    if (toolUseIds.length === 0)
      continue;
    const nextIdx = i + 1;
    const haveIds = new Set;
    if (nextIdx < msgs.length && msgs[nextIdx].role === "user" && Array.isArray(msgs[nextIdx].content)) {
      for (const b of msgs[nextIdx].content) {
        if (b.type === "tool_result" && toolUseIds.includes(b.tool_use_id)) {
          haveIds.add(b.tool_use_id);
        }
      }
    }
    const missingIds = toolUseIds.filter((id) => !haveIds.has(id));
    if (missingIds.length === 0)
      continue;
    const collected = [];
    for (const id of missingIds) {
      let found = false;
      for (let j = nextIdx;j < msgs.length && !found; j++) {
        if (msgs[j].role !== "user" || !Array.isArray(msgs[j].content))
          continue;
        const blocks = msgs[j].content;
        const bIdx = blocks.findIndex((b) => b.type === "tool_result" && b.tool_use_id === id);
        if (bIdx >= 0) {
          collected.push(blocks[bIdx]);
          blocks.splice(bIdx, 1);
          found = true;
        }
      }
      if (!found) {
        collected.push({ type: "tool_result", tool_use_id: id, content: "[interrupted]" });
      }
    }
    if (haveIds.size > 0 && nextIdx < msgs.length) {
      msgs[nextIdx].content.push(...collected);
    } else {
      msgs.splice(nextIdx, 0, { role: "user", content: collected });
      i++;
    }
  }
  for (let i = msgs.length - 1;i >= 0; i--) {
    if (Array.isArray(msgs[i].content) && msgs[i].content.length === 0) {
      msgs.splice(i, 1);
    }
  }
}
function isTurnEnd(msg) {
  if (msg.role !== "assistant")
    return false;
  if (!Array.isArray(msg.content))
    return true;
  return !msg.content.some((b) => b.type === "tool_use");
}
function pruneMessages(msgs) {
  const heavy = apiConfig.heavyThreshold;
  const thinking = apiConfig.thinkingThreshold;
  const age = new Array(msgs.length).fill(0);
  let count = 0;
  for (let i = msgs.length - 1;i >= 0; i--) {
    age[i] = count;
    if (isTurnEnd(msgs[i]))
      count++;
  }
  const out = [];
  for (let i = 0;i < msgs.length; i++) {
    const msg = msgs[i];
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      let content = msg.content.map((b) => {
        if (b.type === "tool_use" && age[i] > heavy)
          return { ...b, input: {} };
        return b;
      });
      if (age[i] > thinking) {
        content = content.filter((b) => b.type !== "thinking");
      }
      out.push({ ...msg, content });
    } else if (msg.role === "user" && Array.isArray(msg.content)) {
      const content = msg.content.map((b) => {
        if (b.type === "tool_result" && age[i] > heavy) {
          return { ...b, content: "[tool result omitted from context]" };
        }
        if (b.type === "image" && age[i] > heavy) {
          return { type: "text", text: "[image omitted from context]" };
        }
        return b;
      });
      out.push({ ...msg, content });
    } else {
      out.push(msg);
    }
  }
  return out;
}
var apiMessages = {
  config: apiConfig,
  toAnthropicMessages,
  applyModelEvent,
  findReplayStart
};

// src/server/runtime.ts
var activeSessions = [];
var activeRuntimePid = null;
function makeSessionId() {
  const month = String(new Date().getMonth() + 1).padStart(2, "0");
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let suffix = "";
  for (let i = 0;i < 3; i++)
    suffix += chars[Math.floor(Math.random() * chars.length)];
  return `${month}-${suffix}`;
}
async function createSession2() {
  const session2 = {
    id: makeSessionId(),
    name: `tab ${activeSessions.length + 1}`,
    cwd: process.cwd(),
    createdAt: new Date().toISOString()
  };
  activeSessions.push(session2);
  await sessions.createSession(session2.id, {
    id: session2.id,
    workingDir: session2.cwd,
    createdAt: session2.createdAt,
    topic: undefined
  });
  await persistSessionList();
  return session2;
}
async function persistSessionList() {
  await sessions.saveSessionList(activeSessions.map((s) => s.id));
}
function findSession(sessionId) {
  return activeSessions.find((s) => s.id === sessionId);
}
function broadcastSessions() {
  ipc.appendEvent({
    type: "sessions",
    sessions: activeSessions.map((s) => ({ id: s.id, name: s.name }))
  });
}
function emitInfo2(sessionId, text2, level = "info") {
  ipc.appendEvent({
    id: protocol.eventId(),
    type: "info",
    text: text2,
    level,
    sessionId,
    createdAt: new Date().toISOString()
  });
}
async function handlePrompt(session2, text2, label) {
  ipc.appendEvent({
    type: "prompt",
    text: text2,
    label,
    sessionId: session2.id,
    createdAt: new Date().toISOString()
  });
  const sessionState = {
    id: session2.id,
    name: session2.name,
    model: session2.model,
    cwd: session2.cwd,
    createdAt: session2.createdAt
  };
  const cmdResult = await commands.executeCommand(text2, sessionState, (msg, level) => emitInfo2(session2.id, msg, level));
  if (cmdResult.handled) {
    const cwdChanged = session2.cwd !== sessionState.cwd;
    const modelChanged = session2.model !== sessionState.model;
    session2.model = sessionState.model;
    session2.cwd = sessionState.cwd;
    if (cwdChanged || modelChanged) {
      sessions.updateMeta(session2.id, {
        workingDir: session2.cwd,
        model: session2.model
      });
    }
    if (cmdResult.output)
      emitInfo2(session2.id, cmdResult.output);
    if (cmdResult.error)
      emitInfo2(session2.id, cmdResult.error, "error");
    return;
  }
  await runGeneration(session2, text2);
}
async function runGeneration(session2, text2) {
  const model = session2.model ?? models.defaultModel();
  const promptResult = context.buildSystemPrompt({
    model,
    cwd: session2.cwd
  });
  await sessions.appendHistory(session2.id, [{
    role: "user",
    content: text2,
    ts: new Date().toISOString()
  }]);
  const messages = apiMessages.toAnthropicMessages(session2.id);
  ipc.appendEvent({
    type: "stream-start",
    sessionId: session2.id,
    createdAt: new Date().toISOString()
  });
  try {
    await agentLoop.runAgentLoop({
      sessionId: session2.id,
      model,
      cwd: session2.cwd,
      systemPrompt: promptResult.text,
      messages,
      onStatus: async (busy, activity) => {
        ipc.appendEvent({
          type: "status",
          sessionId: session2.id,
          busy,
          activity,
          createdAt: new Date().toISOString()
        });
      }
    });
  } catch (err) {
    emitInfo2(session2.id, `Generation failed: ${err?.message ?? String(err)}`, "error");
  }
}
async function handleCommand(cmd, signal) {
  const sessionId = cmd.sessionId;
  const session2 = sessionId ? findSession(sessionId) : activeSessions[0];
  switch (cmd.type) {
    case "prompt": {
      if (!session2)
        return;
      handlePrompt(session2, cmd.text ?? "");
      break;
    }
    case "steer": {
      if (!session2)
        return;
      if (agentLoop.isActive(session2.id)) {
        agentLoop.abort(session2.id);
        await Bun.sleep(50);
      }
      handlePrompt(session2, cmd.text ?? "", "steering");
      break;
    }
    case "abort": {
      if (!sessionId)
        return;
      const aborted = agentLoop.abort(sessionId);
      if (!aborted)
        emitInfo2(sessionId, "No active generation to abort");
      break;
    }
    case "compact": {
      if (!session2)
        return;
      emitInfo2(session2.id, "Compaction not yet implemented (needs Plan 3: Session)");
      break;
    }
    case "open": {
      await createSession2();
      broadcastSessions();
      break;
    }
    case "close": {
      if (!sessionId)
        return;
      agentLoop.abort(sessionId);
      activeSessions = activeSessions.filter((s) => s.id !== sessionId);
      if (activeSessions.length === 0)
        await createSession2();
      await persistSessionList();
      broadcastSessions();
      break;
    }
  }
}
function startRuntime(signal) {
  activeRuntimePid = process.pid;
  activeSessions = [];
  const metas = sessions.loadSessionMetas();
  if (metas.length > 0) {
    for (const meta of metas) {
      const dirName = meta.workingDir?.split("/").pop();
      activeSessions.push({
        id: meta.id,
        name: meta.topic ?? dirName ?? `tab ${activeSessions.length + 1}`,
        cwd: meta.workingDir ?? process.cwd(),
        createdAt: meta.createdAt
      });
    }
  } else {
    createSession2();
  }
  setTimeout(() => {
    if (signal.aborted || activeRuntimePid !== process.pid)
      return;
    broadcastSessions();
  }, 0);
  (async () => {
    for await (const cmd of ipc.tailCommands(signal)) {
      if (signal.aborted || activeRuntimePid !== process.pid)
        break;
      if (cmd.sessionId && !activeSessions.some((s) => s.id === cmd.sessionId))
        continue;
      try {
        await handleCommand(cmd, signal);
      } catch (err) {
        const sid = cmd.sessionId ?? activeSessions[0]?.id;
        if (sid)
          emitInfo2(sid, `Command error: ${err?.message ?? String(err)}`, "error");
      }
    }
  })();
  Promise.resolve().then(() => (init_client(), exports_client)).then(({ mcp: mcp2 }) => {
    mcp2.initServers().catch((err) => {
      console.error(`[mcp] init failed: ${err?.message ?? String(err)}`);
    });
    signal.addEventListener("abort", () => {
      mcp2.shutdown();
    }, { once: true });
  }).catch(() => {});
  Promise.resolve().then(() => (init_inbox(), exports_inbox)).then(({ inbox: inbox2 }) => {
    inbox2.startWatching(signal, (sessionId, text2) => {
      const session2 = findSession(sessionId);
      if (session2)
        handlePrompt(session2, text2);
    });
  }).catch(() => {});
}
var runtime = { startRuntime };

// src/client.ts
import { readFileSync as readFileSync10, writeFileSync as writeFileSync3 } from "fs";

// src/session/replay.ts
function userContentText(content) {
  if (typeof content === "string")
    return content;
  if (!Array.isArray(content))
    return "";
  return content.map((part) => {
    if (part?.type === "text")
      return part.text ?? "";
    if (part?.type === "image") {
      const file = part.originalFile ?? part.blobId ?? "";
      return file ? `[image ${file}]` : "[image]";
    }
    return "";
  }).join("");
}
function extractToolOutput(blobData) {
  const callData = blobData?.call ?? {};
  const raw = blobData?.result?.content ?? "";
  const output = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.filter((b) => b.type === "text").map((b) => b.text).join("") || "[image]" : "";
  const status = blobData?.result?.status === "error" ? "error" : blobData?.result ? "done" : "error";
  return { output, status, input: callData.input };
}
function replaySession(sessionId, opts) {
  const entries = sessions.loadAllHistory(sessionId);
  return replayEntries(sessionId, entries, opts);
}
function replayEntries(sessionId, entries, opts) {
  const model = opts?.model;
  const blocks = [];
  let tokenText = "";
  const toolResultBlobs = new Map;
  for (const m of entries) {
    if (m.role === "tool_result" && m.tool_use_id && m.blobId) {
      toolResultBlobs.set(m.tool_use_id, m.blobId);
    }
  }
  for (const entry of entries) {
    const ts = entry.ts ? Date.parse(entry.ts) : undefined;
    if (entry.type === "reset" || entry.type === "forked_from" || entry.type === "compact")
      continue;
    if (entry.type === "session")
      continue;
    if (entry.type === "info") {
      if (entry.level === "error") {
        blocks.push({ type: "error", text: entry.text ?? "", ts });
      } else {
        blocks.push({ type: "info", text: entry.text ?? "", ts });
      }
      continue;
    }
    if (entry.role === "user") {
      const text2 = userContentText(entry.content);
      if (text2) {
        blocks.push({
          type: "input",
          text: text2,
          model,
          source: typeof entry.source === "string" ? entry.source : undefined,
          ts
        });
        tokenText += text2 + `
`;
      }
      continue;
    }
    if (entry.role === "assistant") {
      if (entry.thinkingText) {
        blocks.push({
          type: "thinking",
          text: entry.thinkingText,
          model,
          sessionId,
          blobId: entry.thinkingBlobId,
          ts
        });
      }
      if (entry.text) {
        blocks.push({ type: "assistant", text: entry.text, model, ts });
        tokenText += entry.text + `
`;
      }
      if (Array.isArray(entry.tools)) {
        for (const tool of entry.tools) {
          const resultBlobId = toolResultBlobs.get(tool.id);
          const blobId = resultBlobId ?? tool.blobId;
          const blobData = blob.readBlobFromChain(sessionId, blobId);
          const { output, status, input } = extractToolOutput(blobData);
          blocks.push({
            type: "tool",
            text: "",
            name: tool.name,
            args: typeof input === "string" ? input : JSON.stringify(input ?? {}),
            output,
            status: blobData ? status : "done",
            blobId,
            sessionId,
            ts
          });
          tokenText += output + `
`;
        }
      }
      continue;
    }
  }
  const interrupted = sessions.detectInterruptedTools(entries);
  if (interrupted.length > 0) {
    const toolList = interrupted.map((t) => t.name).join(", ");
    blocks.push({ type: "info", text: `[interrupted] during tools (${toolList}). Press Enter to continue` });
  }
  return {
    blocks,
    tokenEstimate: models.estimateTokens(tokenText),
    model,
    interrupted
  };
}
function buildCompactionContext(sessionId, entries) {
  const userPrompts = [];
  for (const entry of entries) {
    if (entry.role !== "user")
      continue;
    const text2 = typeof entry.content === "string" ? entry.content : "";
    if (!text2 || text2.startsWith("["))
      continue;
    userPrompts.push(text2.split(`
`)[0].slice(0, 200));
  }
  const dir = sessions.sessionDir(sessionId);
  if (userPrompts.length === 0) {
    return `Context was compacted. No user prompts in previous conversation. Full history: ${dir}/history*.asonl + blobs/`;
  }
  const lines = [
    "Context was compacted to avoid exceeding the token limit. Verify before assuming.",
    "",
    "User messages from previous conversation:",
    ""
  ];
  if (userPrompts.length <= 20) {
    userPrompts.forEach((p, i) => lines.push(`${i + 1}. ${p}`));
  } else {
    lines.push("First 10:");
    userPrompts.slice(0, 10).forEach((p, i) => lines.push(`${i + 1}. ${p}`));
    lines.push("");
    lines.push("Last 10:");
    const start = userPrompts.length - 10;
    userPrompts.slice(-10).forEach((p, i) => lines.push(`${start + i + 1}. ${p}`));
  }
  lines.push("");
  lines.push(`Full history: ${dir}/history*.asonl + blobs/`);
  return lines.join(`
`);
}
function inputHistoryFromEntries(entries) {
  return entries.filter((e) => e.role === "user").map((e) => {
    if (typeof e.content === "string")
      return e.content;
    if (Array.isArray(e.content)) {
      return e.content.filter((b) => b.type === "text").map((b) => b.text).join(" ");
    }
    return "";
  }).filter((text2) => text2 && !text2.startsWith("[")).slice(-200);
}
var replay = {
  replaySession,
  replayEntries,
  buildCompactionContext,
  inputHistoryFromEntries,
  extractToolOutput
};

// src/client.ts
init_state();
init_ason();

// src/utils/strings.ts
function expandTabs(s, tabWidth = 4) {
  if (!s.includes("\t"))
    return s;
  let out = "";
  let col = 0;
  for (const ch of s) {
    if (ch === "\t") {
      const spaces = tabWidth - col % tabWidth;
      out += " ".repeat(spaces);
      col += spaces;
    } else if (ch === `
`) {
      out += ch;
      col = 0;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}
function charWidth(cp) {
  if (cp < 32)
    return 0;
  if (cp < 127)
    return 1;
  if (cp >= 57344 && cp <= 57349)
    return 0;
  if (cp >= 768 && cp <= 879 || cp >= 6832 && cp <= 6911 || cp >= 7616 && cp <= 7679 || cp >= 8400 && cp <= 8447 || cp >= 65024 && cp <= 65039 || cp >= 65056 && cp <= 65071 || cp === 8203 || cp === 8204 || cp === 8205 || cp === 8288 || cp === 65279 || cp >= 917760 && cp <= 917999)
    return 0;
  if (isWide(cp))
    return 2;
  return 1;
}
var EMOJI_PRESENTATION = new Set([
  8986,
  8987,
  9193,
  9194,
  9195,
  9196,
  9197,
  9198,
  9199,
  9200,
  9201,
  9202,
  9203,
  9208,
  9209,
  9210,
  9642,
  9643,
  9654,
  9664,
  9723,
  9724,
  9725,
  9726,
  9728,
  9729,
  9730,
  9731,
  9732,
  9742,
  9745,
  9748,
  9749,
  9752,
  9757,
  9760,
  9762,
  9763,
  9766,
  9770,
  9774,
  9775,
  9784,
  9785,
  9786,
  9792,
  9794,
  9800,
  9801,
  9802,
  9803,
  9804,
  9805,
  9806,
  9807,
  9808,
  9809,
  9810,
  9811,
  9823,
  9824,
  9827,
  9829,
  9830,
  9832,
  9851,
  9854,
  9855,
  9874,
  9875,
  9876,
  9877,
  9878,
  9879,
  9881,
  9883,
  9884,
  9888,
  9889,
  9895,
  9898,
  9899,
  9904,
  9905,
  9917,
  9918,
  9924,
  9925,
  9928,
  9934,
  9935,
  9937,
  9939,
  9940,
  9961,
  9962,
  9968,
  9969,
  9970,
  9971,
  9972,
  9973,
  9975,
  9976,
  9977,
  9978,
  9981,
  9986,
  9989,
  9992,
  9993,
  9994,
  9995,
  9996,
  9997,
  9999,
  10002,
  10004,
  10006,
  10013,
  10017,
  10024,
  10035,
  10036,
  10052,
  10055,
  10060,
  10062,
  10067,
  10068,
  10069,
  10071,
  10083,
  10084,
  10133,
  10134,
  10135,
  10145,
  10160,
  10175,
  10548,
  10549,
  11013,
  11014,
  11015,
  11035,
  11036,
  11088,
  11093,
  12336,
  12349,
  12951,
  12953
]);
function isWide(cp) {
  if (EMOJI_PRESENTATION.has(cp))
    return true;
  return cp >= 4352 && cp <= 4447 || cp >= 11904 && cp <= 12350 || cp >= 12353 && cp <= 19903 || cp >= 19968 && cp <= 40959 || cp >= 40960 && cp <= 42191 || cp >= 43360 && cp <= 43388 || cp >= 44032 && cp <= 55203 || cp >= 63744 && cp <= 64255 || cp >= 65040 && cp <= 65131 || cp >= 65281 && cp <= 65376 || cp >= 65504 && cp <= 65510 || cp >= 126976 && cp <= 130047 || cp >= 131072 && cp <= 262143;
}
function visLen(s) {
  let n = 0, esc = false, osc = false;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp === 27) {
      esc = true;
      continue;
    }
    if (esc) {
      if (cp === 93) {
        osc = true;
        esc = false;
        continue;
      }
      if (cp === 109)
        esc = false;
      continue;
    }
    if (osc) {
      if (cp === 7)
        osc = false;
      continue;
    }
    n += charWidth(cp);
  }
  return n;
}
function wordWrap(text2, width) {
  if (width <= 0)
    return text2.split(`
`);
  const out = [];
  for (const raw of text2.split(`
`)) {
    if (visLen(raw) <= width) {
      out.push(raw);
      continue;
    }
    let vis = 0, wordStart = 0, lineStart = 0, esc = false;
    for (let i = 0;i < raw.length; ) {
      const cp = raw.codePointAt(i);
      const cl = cp > 65535 ? 2 : 1;
      if (cp === 27) {
        esc = true;
        i += cl;
        continue;
      }
      if (esc) {
        if (cp === 109)
          esc = false;
        i += cl;
        continue;
      }
      if (cp === 32)
        wordStart = i;
      vis += charWidth(cp);
      if (vis > width) {
        const at = wordStart > lineStart ? wordStart : i;
        out.push(raw.slice(lineStart, at));
        lineStart = raw[at] === " " ? at + 1 : at;
        wordStart = lineStart;
        vis = visLen(raw.slice(lineStart, i + cl));
      }
      i += cl;
    }
    if (lineStart < raw.length)
      out.push(raw.slice(lineStart));
  }
  return out;
}
function clipVisual(s, max) {
  if (max <= 0)
    return "";
  if (visLen(s) <= max)
    return s;
  if (max === 1)
    return "…";
  let vis = 0, esc = false, osc = false, cut = 0;
  for (let i = 0;i < s.length; ) {
    const cp = s.codePointAt(i);
    const cl = cp > 65535 ? 2 : 1;
    if (cp === 27) {
      esc = true;
      i += cl;
      continue;
    }
    if (esc) {
      if (cp === 93) {
        osc = true;
        esc = false;
        i += cl;
        continue;
      }
      if (cp === 109)
        esc = false;
      i += cl;
      continue;
    }
    if (osc) {
      if (cp === 7)
        osc = false;
      i += cl;
      continue;
    }
    const w = charWidth(cp);
    if (vis + w > max - 1) {
      cut = i;
      break;
    }
    vis += w;
    i += cl;
  }
  return s.slice(0, cut) + "…";
}
var M_BOLD = "";
var M_BOLD_OFF = "";
var M_ITALIC = "";
var M_ITALIC_OFF = "";
var M_DIM = "";
var M_DIM_OFF = "";
var MARKER_ANSI = {
  [M_BOLD]: "\x1B[1m",
  [M_BOLD_OFF]: "\x1B[22m",
  [M_ITALIC]: "\x1B[3m",
  [M_ITALIC_OFF]: "\x1B[23m",
  [M_DIM]: "\x1B[2m",
  [M_DIM_OFF]: "\x1B[22m"
};
function resolveMarkers(lines) {
  const active = new Set;
  return lines.map((line) => {
    let out = "";
    for (const m of active)
      out += MARKER_ANSI[m];
    for (const ch of line) {
      const ansi = MARKER_ANSI[ch];
      if (ansi !== undefined) {
        out += ansi;
        const cp = ch.codePointAt(0);
        if ((cp & 1) === 0)
          active.add(ch);
        else
          active.delete(String.fromCodePoint(cp - 1));
      } else {
        out += ch;
      }
    }
    for (const m of active)
      out += MARKER_ANSI[String.fromCodePoint(m.codePointAt(0) + 1)];
    return out;
  });
}

// src/cli/md.ts
var DEFAULT_COLORS = {
  bold: [M_BOLD, M_BOLD_OFF],
  italic: [M_ITALIC, M_ITALIC_OFF],
  code: [M_DIM, M_DIM_OFF]
};
function mdSpans(text2) {
  const spans = [];
  let buf = [];
  let inCode = false;
  let codeLang = "";
  const flushText = () => {
    if (buf.length) {
      spans.push({ type: "text", lines: buf });
      buf = [];
    }
  };
  for (const line of text2.split(`
`)) {
    if (line.startsWith("```")) {
      if (inCode) {
        spans.push({ type: "code", lang: codeLang, lines: buf });
        buf = [];
        inCode = false;
        codeLang = "";
      } else {
        flushText();
        codeLang = line.slice(3).trim();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      buf.push(line);
      continue;
    }
    if (/^\|.+\|$/.test(line.trim())) {
      flushText();
      const last = spans[spans.length - 1];
      if (last?.type === "table") {
        last.lines.push(line);
      } else {
        spans.push({ type: "table", lines: [line] });
      }
      continue;
    }
    buf.push(line);
  }
  if (buf.length) {
    spans.push({ type: inCode ? "code" : "text", ...inCode ? { lang: codeLang } : {}, lines: buf });
  }
  return spans;
}
function mdInline(line, colors) {
  const c = colors ?? DEFAULT_COLORS;
  const hm = line.match(/^(#{1,6})\s+(.*)/);
  if (hm)
    return `${c.bold[0]}${inlineSpans(hm[2], c)}${c.bold[1]}`;
  return inlineSpans(line, c);
}
function inlineSpans(s, c) {
  const codes = [];
  const ph = (i) => `\x00C${i}\x00`;
  s = s.replace(/\*\*`([^`]+)`\*\*/g, (_, g) => {
    const i = codes.length;
    codes.push(`${c.bold[0]}${g}${c.bold[1]}`);
    return ph(i);
  });
  s = s.replace(/`([^`\n]+)`/g, (_, g) => {
    const i = codes.length;
    codes.push(`${c.code[0]}${g}${c.code[1]}`);
    return ph(i);
  });
  s = s.replace(/\*\*(.+?)\*\*/g, `${c.bold[0]}$1${c.bold[1]}`);
  s = s.replace(/(?<!\*)\*(?!\s)(.+?)(?<!\s)\*(?!\*)/g, `${c.italic[0]}$1${c.italic[1]}`);
  s = s.replace(/\x00C(\d+)\x00/g, (_, i) => codes[+i]);
  return s;
}
function visPad(s, targetWidth) {
  return s + " ".repeat(Math.max(0, targetWidth - visLen(s)));
}
function mdTable(lines, width, colors) {
  const rawRows = lines.filter((l) => !/^\|[\s\-:|]+\|$/.test(l.trim())).map((l) => l.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
  if (!rawRows.length)
    return [];
  const rendered = rawRows.map((row) => row.map((cell) => mdInline(cell, colors)));
  const numCols = Math.max(...rendered.map((r) => r.length));
  if (numCols === 0)
    return [];
  const borderOverhead = 3 * numCols + 1;
  const availableForCells = width - borderOverhead;
  const naturalWidths = Array.from({ length: numCols }, (_, i) => Math.max(...rendered.map((r) => visLen(r[i] ?? ""))));
  const totalNatural = naturalWidths.reduce((a, b) => a + b, 0);
  let colWidths;
  if (totalNatural <= availableForCells) {
    colWidths = naturalWidths;
  } else {
    colWidths = new Array(numCols).fill(1);
    const extra = Math.max(0, availableForCells - numCols);
    if (extra > 0 && totalNatural > 0) {
      for (let i = 0;i < numCols; i++) {
        colWidths[i] = Math.max(1, Math.floor(naturalWidths[i] / totalNatural * availableForCells));
      }
      let allocated = colWidths.reduce((a, b) => a + b, 0);
      let remaining = availableForCells - allocated;
      for (let i = 0;remaining > 0 && i < numCols; i++) {
        if (colWidths[i] < naturalWidths[i]) {
          colWidths[i]++;
          remaining--;
        }
      }
    }
  }
  function wrapCell(text2, colWidth) {
    if (visLen(text2) <= colWidth)
      return resolveMarkers([text2]);
    return resolveMarkers(wordWrap(text2, colWidth));
  }
  const out = [];
  const hRule = (left, mid, right) => left + colWidths.map((w) => "─".repeat(w + 2)).join(mid) + right;
  out.push(hRule("┌", "┬", "┐"));
  for (let rowIdx = 0;rowIdx < rendered.length; rowIdx++) {
    const row = rendered[rowIdx];
    const cellLines = Array.from({ length: numCols }, (_, ci) => wrapCell(row[ci] ?? "", colWidths[ci]));
    const rowHeight = Math.max(...cellLines.map((cl) => cl.length));
    for (let li = 0;li < rowHeight; li++) {
      const parts = cellLines.map((cl, ci) => visPad(cl[li] ?? "", colWidths[ci]));
      out.push("│ " + parts.join(" │ ") + " │");
    }
    if (rowIdx < rendered.length - 1) {
      out.push(hRule("├", "┼", "┤"));
    }
  }
  out.push(hRule("└", "┴", "┘"));
  return out;
}
var md = { mdSpans, mdInline, mdTable };

// src/cli/colors.ts
init_live_file();
init_ason();
import { readFileSync as readFileSync9 } from "fs";

// src/utils/oklch.ts
function oklchToRgb(L, C, H) {
  const hRad = H * Math.PI / 180;
  const a = C * Math.cos(hRad);
  const b = C * Math.sin(hRad);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const rl = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const gl = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  const gamma = (c) => Math.round(255 * Math.max(0, Math.min(1, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)));
  return [gamma(rl), gamma(gl), gamma(bl)];
}
function toFg(L, C, H) {
  const [r, g, b] = oklchToRgb(L, C, H);
  return `\x1B[38;2;${r};${g};${b}m`;
}
function toBg(L, C, H) {
  const [r, g, b] = oklchToRgb(L, C, H);
  return `\x1B[48;2;${r};${g};${b}m`;
}
var oklch = { oklchToRgb, toFg, toBg };

// src/cli/colors.ts
var HAL_DIR2 = import.meta.dir.replace(/\/src\/cli$/, "");
var COLORS_PATH = `${HAL_DIR2}/colors.ason`;
var assistant = { fg: "", bg: "", bold: "", code: "" };
var thinking = { fg: "", bg: "", bold: "", code: "" };
var user = { fg: "", bg: "" };
var input = { fg: "", bg: "", cursor: "" };
var system = { fg: "", bg: "" };
var info = { fg: "", bg: "" };
var error = { fg: "", bg: "" };
var tools = {};
function resolveTriple(t, vars) {
  return t.map((v) => typeof v === "string" && v.startsWith("$") ? vars[v.slice(1)] ?? 0 : Number(v));
}
function fg(t, vars) {
  return oklch.toFg(...resolveTriple(t, vars));
}
function bg(t, vars) {
  return oklch.toBg(...resolveTriple(t, vars));
}
function load() {
  let raw;
  try {
    raw = ason.parse(readFileSync9(COLORS_PATH, "utf-8"));
  } catch {
    return;
  }
  if (!raw || typeof raw !== "object")
    return;
  const vars = { ...raw.vars };
  function resolveBlock(def, target) {
    if (def?.fg)
      target.fg = fg(def.fg, vars);
    if (def?.bg)
      target.bg = bg(def.bg, vars);
  }
  function resolveMd(def, target) {
    resolveBlock(def, target);
    if (def?.bold)
      target.bold = fg(def.bold, vars);
    else
      target.bold = target.fg;
    if (def?.code)
      target.code = fg(def.code, vars);
    else
      target.code = target.fg;
  }
  resolveMd(raw.assistant, assistant);
  resolveMd(raw.thinking, thinking);
  resolveBlock(raw.user, user);
  resolveBlock(raw.system, system);
  resolveBlock(raw.error, error);
  if (raw.info?.fg)
    info.fg = fg(raw.info.fg, vars);
  info.bg = "";
  if (raw.input) {
    if (raw.input.fg)
      input.fg = fg(raw.input.fg, vars);
    if (raw.input.bg)
      input.bg = bg(raw.input.bg, vars);
    if (raw.input.cursor)
      input.cursor = fg(raw.input.cursor, vars);
  }
  const toolDefs = raw.tools ?? {};
  for (const [name, def] of Object.entries(toolDefs)) {
    if (!tools[name])
      tools[name] = { fg: "", bg: "" };
    resolveBlock(def, tools[name]);
  }
  if (tools.read) {
    tools.grep = tools.read;
    tools.glob = tools.read;
    tools.ls = tools.read;
  }
}
function tool(name) {
  const stripped = name.startsWith("mcp__") ? name.replace(/^mcp__[^_]+__/, "") : name;
  return tools[stripped] ?? tools.default ?? { fg: "", bg: "" };
}
load();
var watcher = liveFiles.liveFile(COLORS_PATH, {}, { watch: true });
liveFiles.onChange(watcher, load);
var colors = {
  assistant,
  thinking,
  user,
  input,
  system,
  info,
  error,
  tool,
  tools,
  load
};

// src/cli/blocks.ts
init_ason();
init_state();
var blockConfig = {
  tabWidth: 4,
  blobBatchSize: 64,
  maxToolOutputLines: 20,
  maxEditDiffLines: 3
};
function parseTs(ts) {
  return ts ? Date.parse(ts) : undefined;
}
function blobPath(sessionId, blobId) {
  return `${STATE_DIR}/sessions/${sessionId}/blobs/${blobId}.ason`;
}
function userText(entry) {
  const content = entry.content ?? entry.text;
  if (typeof content === "string")
    return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (part?.type === "text" && typeof part.text === "string")
        parts.push(part.text);
      else if (part?.type === "image")
        parts.push("[image]");
    }
    return parts.join("") || "";
  }
  return "";
}
function historyToBlocks(history, sessionId) {
  const result2 = [];
  for (const entry of history) {
    if (entry.role === "user") {
      const text2 = userText(entry);
      if (!text2)
        continue;
      const isSystem = text2.startsWith("[system] ");
      const source = isSystem ? "system" : entry.source ?? undefined;
      result2.push({
        type: "user",
        text: isSystem ? text2.slice(9) : text2,
        source,
        status: entry.status,
        ts: parseTs(entry.ts)
      });
      continue;
    }
    if (entry.role === "assistant") {
      if (entry.thinkingText) {
        result2.push({
          type: "thinking",
          text: entry.thinkingText,
          blobId: entry.thinkingBlobId,
          sessionId,
          ts: parseTs(entry.ts)
        });
      }
      if (entry.tools && Array.isArray(entry.tools)) {
        for (const tool2 of entry.tools) {
          result2.push({
            type: "tool",
            name: tool2.name,
            title: capitalize(tool2.name),
            blobId: tool2.blobId,
            sessionId,
            ts: parseTs(entry.ts)
          });
        }
      }
      if (typeof entry.text === "string" && entry.text) {
        result2.push({
          type: "assistant",
          text: entry.text,
          model: entry.model,
          ts: parseTs(entry.ts)
        });
      }
      continue;
    }
    if (entry.role === "tool_result")
      continue;
    if (entry.type === "info") {
      const isError = entry.level === "error";
      if (typeof entry.text === "string") {
        result2.push({ type: isError ? "error" : "info", text: entry.text, ts: parseTs(entry.ts) });
      }
      continue;
    }
  }
  return result2;
}
function applyBlob(block, text2) {
  block.blobLoaded = true;
  try {
    const blob2 = ason.parse(text2);
    const input2 = blob2?.call?.input;
    block.title = toolTitle(block.name, input2);
    block.command = toolCommand(block.name, input2);
    if (typeof blob2?.result?.content === "string")
      block.output = blob2.result.content;
  } catch {}
}
var MAX_BLOB_SIZE = 1024 * 1024;
async function loadToolBlobs(blocks) {
  const tools2 = blocks.filter((b) => b.type === "tool" && !b.blobLoaded && !!b.blobId);
  if (tools2.length === 0)
    return 0;
  const batchSize = blockConfig.blobBatchSize;
  for (let i = 0;i < tools2.length; i += batchSize) {
    const batch = tools2.slice(i, i + batchSize);
    const files = batch.map((b) => Bun.file(blobPath(b.sessionId ?? "", b.blobId)));
    const sizes = await Promise.allSettled(files.map((f) => f.size));
    const reads = files.map((f, j) => {
      const sz = sizes[j];
      if (sz.status === "fulfilled" && sz.value <= MAX_BLOB_SIZE)
        return f.text();
      return Promise.resolve(null);
    });
    const results = await Promise.allSettled(reads);
    for (let j = 0;j < batch.length; j++) {
      const r = results[j];
      if (r.status === "fulfilled" && r.value !== null)
        applyBlob(batch[j], r.value);
      else
        batch[j].blobLoaded = true;
    }
    await Bun.sleep(0);
  }
  return tools2.length;
}
function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function toolTitle(name, input2) {
  if (!input2)
    return capitalize(name);
  switch (name) {
    case "bash": {
      const cmd = input2.command ?? "";
      if (!cmd.includes(`
`) && cmd.length <= 60)
        return `Bash: ${cmd}`;
      return "Bash";
    }
    case "read": {
      let s = `Read ${input2.path ?? "?"}`;
      if (input2.offset)
        s += `:${input2.offset}`;
      if (input2.limit)
        s += `-${input2.offset + input2.limit}`;
      return s;
    }
    case "write":
      return `Write ${input2.path ?? "?"}`;
    case "edit":
      return `Edit ${input2.path ?? "?"}`;
    case "eval":
      return "Eval";
    case "grep":
      return `Grep ${input2.pattern ?? "?"} in ${input2.path ?? "?"}`;
    case "ls":
      return `Ls ${input2.path ?? "."}`;
    default:
      return capitalize(name);
  }
}
function toolCommand(name, input2) {
  if (!input2)
    return;
  if (name === "bash") {
    const cmd = input2.command ?? "";
    if (!cmd.includes(`
`) && cmd.length <= 60)
      return;
    return cmd;
  }
  if (name === "eval") {
    return input2.code ?? undefined;
  }
  return;
}
var RED_FG = "\x1B[31m";
var GREEN_FG = "\x1B[32m";
var FG_OFF = "\x1B[39m";
function formatSize(bytes) {
  if (bytes < 1024)
    return `${bytes} B`;
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function countLines(output) {
  return output.trim() ? output.trimEnd().split(`
`).length : 0;
}
function countIndicator(output, empty, unit) {
  if (!output.trim() || output === empty)
    return { bodyLines: [] };
  const total = countLines(output);
  return {
    bodyLines: [],
    hiddenIndicator: total > 5 ? `[${total} ${unit}]` : undefined
  };
}
function formatEdit(output) {
  if (!output)
    return { bodyLines: [] };
  const beforeMatch = output.match(/^--- before\n([\s\S]*?)(?:\n\n\+\+\+ after|$)/);
  const afterMatch = output.match(/\+\+\+ after\n([\s\S]*)$/);
  if (!beforeMatch && !afterMatch)
    return { bodyLines: [] };
  let beforeLines = beforeMatch ? beforeMatch[1].split(`
`).filter((l) => l.trim()) : [];
  let afterLines = afterMatch ? afterMatch[1].split(`
`).filter((l) => l.trim()) : [];
  while (beforeLines.length && afterLines.length && beforeLines[0] === afterLines[0]) {
    beforeLines.shift();
    afterLines.shift();
  }
  while (beforeLines.length && afterLines.length && beforeLines[beforeLines.length - 1] === afterLines[afterLines.length - 1]) {
    beforeLines.pop();
    afterLines.pop();
  }
  const lines = [];
  const MAX = blockConfig.maxEditDiffLines;
  for (const [content, prefix, color] of [
    [beforeLines, "−", RED_FG],
    [afterLines, "+", GREEN_FG]
  ]) {
    if (!content.length)
      continue;
    const limit = content.length <= MAX + 1 ? content.length : MAX;
    for (const l of content.slice(0, limit)) {
      lines.push(`${color}${prefix} ${l}${FG_OFF}`);
    }
    if (content.length > limit) {
      lines.push(`  … ${content.length - limit} more`);
    }
  }
  return { bodyLines: lines, suppressOutput: true };
}
function formatRead(output) {
  if (!output.trim())
    return { bodyLines: [] };
  const n = countLines(output);
  const sz = formatSize(Buffer.byteLength(output, "utf8"));
  return { bodyLines: [`${n} lines, ${sz}`] };
}
function formatWrite(output) {
  const lines = output.split(`
`).filter((l) => l.trim());
  if (!lines.length || lines.length === 1 && lines[0] === "ok") {
    return { bodyLines: [], suppressOutput: true };
  }
  return { bodyLines: lines, suppressOutput: true };
}
var toolFormatters = {
  edit: formatEdit,
  write: formatWrite,
  grep: (o) => countIndicator(o, "No matches found.", "matches"),
  glob: (o) => countIndicator(o, "No files found.", "files"),
  ls: (o) => countIndicator(o, "(empty directory)", "entries"),
  read: formatRead
};
function formatToolOutput(name, output) {
  return toolFormatters[name]?.(output) ?? { bodyLines: [] };
}
var SPINNER_CHARS = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
function spinnerChar(elapsed2) {
  const idx = Math.floor(elapsed2 / 80) % SPINNER_CHARS.length;
  return SPINNER_CHARS[idx];
}
function formatElapsed(ms) {
  if (ms < 60000)
    return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.floor(ms % 60000 / 1000);
  return `${m}m${String(s).padStart(2, "0")}s`;
}
var RESET_BG = "\x1B[49m";
var DIM = "\x1B[2m";
var DIM_OFF = "\x1B[22m";
function clipLine(line, cols) {
  if (visLen(expandTabs(line, blockConfig.tabWidth)) <= cols)
    return line;
  return clipVisual(expandTabs(line, blockConfig.tabWidth), cols);
}
function bgLine(content, cols, bg2) {
  return `${bg2}\x1B[K\r${content}${RESET_BG}`;
}
function blockColors(block) {
  switch (block.type) {
    case "assistant":
      return colors.assistant;
    case "thinking":
      return colors.thinking;
    case "user":
      return colors.user;
    case "tool":
      return colors.tool(block.name);
    case "info":
      return colors.info;
    case "error":
      return colors.error;
  }
}
function formatHHMM(ts) {
  if (!ts)
    return "";
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function buildHeader(title, time, blobRef, cols) {
  const left = time ? `── ${time} ${title} ` : `── ${title} `;
  const right = blobRef ? ` ${DIM}(${blobRef})${DIM_OFF} ──` : "";
  const fillLen = Math.max(1, cols - visLen(left) - visLen(right));
  return `${left}${"─".repeat(fillLen)}${right}`;
}
function blockLabel(block) {
  switch (block.type) {
    case "user": {
      if (block.source && block.source !== "user" && block.source !== "system") {
        return `Message from ${block.source}`;
      }
      if (block.status === "steering")
        return "You (steering)";
      if (block.status === "queued")
        return "You (queued)";
      return "You";
    }
    case "assistant":
      return "Hal";
    case "thinking":
      return "Thinking";
    case "tool":
      return block.title;
    case "info":
      return "Info";
    case "error":
      return "Error";
  }
}
function formatBashCommand(cmd, contentWidth) {
  const rawLines = cmd.split(`
`);
  if (rawLines.length === 1 && visLen(cmd) <= contentWidth) {
    return [cmd];
  }
  const result2 = [];
  for (let i = 0;i < rawLines.length; i++) {
    const isLast = i === rawLines.length - 1;
    const wrapWidth = isLast ? contentWidth : contentWidth - 2;
    const wrapped = wordWrap(rawLines[i], wrapWidth);
    for (let j = 0;j < wrapped.length; j++) {
      const lineIsLast = isLast && j === wrapped.length - 1;
      result2.push(lineIsLast ? wrapped[j] : wrapped[j] + " \\");
    }
  }
  return result2;
}
function blockContent(block, cols) {
  const cw = cols;
  const indent = "";
  if (block.type === "assistant") {
    const lines2 = [];
    for (const span of md.mdSpans(block.text)) {
      if (span.type === "code") {
        for (const raw of span.lines) {
          const measured = visLen(expandTabs(raw, blockConfig.tabWidth));
          const styled = measured > cols ? `${indent}${DIM}${clipVisual(expandTabs(raw, blockConfig.tabWidth), cols)}${DIM_OFF}` : `${indent}${DIM}${raw}${DIM_OFF}`;
          lines2.push(styled);
        }
      } else if (span.type === "table") {
        for (const l of md.mdTable(span.lines, cw))
          lines2.push(`${indent}${l}`);
      } else {
        for (const l of span.lines) {
          for (const wl of wordWrap(`${indent}${md.mdInline(l)}`, cols))
            lines2.push(wl);
        }
      }
    }
    return resolveMarkers(lines2);
  }
  if (block.type === "tool") {
    const lines2 = [];
    if (block.command) {
      for (const l of formatBashCommand(block.command, cw)) {
        lines2.push(`${indent}${l}`);
      }
    }
    if (block.output) {
      const output = block.output;
      const fmt = formatToolOutput(block.name, output);
      for (const l of fmt.bodyLines) {
        lines2.push(`${indent}${clipLine(l, cw)}`);
      }
      if (!fmt.suppressOutput) {
        const outLines = output.trimEnd().split(`
`);
        const MAX = blockConfig.maxToolOutputLines;
        if (outLines.length > MAX) {
          const indicator = fmt.hiddenIndicator ?? `[+ ${outLines.length - MAX} lines]`;
          lines2.push(`${indent}${DIM}${indicator}${DIM_OFF}`);
          for (const l of outLines.slice(-MAX)) {
            lines2.push(`${indent}${clipLine(l, cw)}`);
          }
        } else {
          for (const l of outLines) {
            lines2.push(`${indent}${clipLine(l, cw)}`);
          }
        }
      }
    }
    return lines2;
  }
  const text2 = block.type === "user" ? block.text : block.type === "thinking" ? block.text : block.text;
  const lines = [];
  for (const raw of expandTabs(text2, blockConfig.tabWidth).split(`
`)) {
    for (const wl of wordWrap(`${indent}${raw}`, cols))
      lines.push(wl);
  }
  return lines;
}
function renderBlock(block, cols) {
  const label = blockLabel(block);
  const time = formatHHMM(block.ts);
  const { fg: fg2, bg: bg2 } = blockColors(block);
  let blobRef = "";
  if ("blobId" in block && block.blobId && "sessionId" in block && block.sessionId) {
    blobRef = `${block.sessionId}/${block.blobId}`;
  }
  const header = buildHeader(label, time, blobRef, cols);
  const content = blockContent(block, cols);
  const lines = [];
  lines.push(bgLine(`${fg2}${header}`, cols, bg2));
  for (const l of content)
    lines.push(bgLine(`${fg2}${l}`, cols, bg2));
  if (lines.length > 0)
    lines[lines.length - 1] += "\x1B[39m";
  return lines;
}
var blocks = {
  config: blockConfig,
  historyToBlocks,
  renderBlock,
  loadToolBlobs,
  formatToolOutput,
  spinnerChar,
  formatElapsed
};

// src/client.ts
var config6 = {
  backgroundLoadTabs: true,
  backgroundLoadBlobs: true,
  repaintAfterBlobLoad: true
};
var state3 = {
  tabs: [],
  activeTab: 0,
  promptText: "",
  promptCursor: 0,
  role: "server",
  peak: 0,
  peakCols: 0,
  model: null,
  busy: new Map,
  activity: new Map
};
var onChange2 = () => {};
function setOnChange(fn) {
  onChange2 = fn;
}
function currentTab() {
  return state3.tabs[state3.activeTab] ?? null;
}
function isBusy() {
  const tab = currentTab();
  return tab ? state3.busy.get(tab.sessionId) ?? false : false;
}
function getActivity() {
  const tab = currentTab();
  return tab ? state3.activity.get(tab.sessionId) ?? "" : "";
}
var onTabSwitch = null;
function setOnTabSwitch(fn) {
  onTabSwitch = fn;
}
function switchTab(index) {
  if (index >= 0 && index < state3.tabs.length && index !== state3.activeTab) {
    const fromSession = state3.tabs[state3.activeTab]?.sessionId ?? "";
    state3.activeTab = index;
    ensureTabLoaded(state3.tabs[index]);
    const toSession = state3.tabs[index]?.sessionId ?? "";
    if (onTabSwitch)
      onTabSwitch(fromSession, toSession);
    saveClientState();
    onChange2(true);
  }
}
function ensureTabLoaded(tab) {
  if (tab.loaded)
    return;
  tab.inputHistory = replay.inputHistoryFromEntries(tab.rawHistory);
  tab.history = blocks.historyToBlocks(tab.rawHistory, tab.sessionId);
  tab.rawHistory = undefined;
  tab.loaded = true;
}
var CLIENT_STATE_PATH = `${STATE_DIR}/client.ason`;
function loadClientState() {
  try {
    const data = ason.parse(readFileSync10(CLIENT_STATE_PATH, "utf-8"));
    return {
      lastTab: data?.lastTab ?? null,
      peak: data?.peak ?? 0,
      peakCols: data?.peakCols ?? 0,
      model: data?.model ?? null
    };
  } catch {
    return { lastTab: null, peak: 0, peakCols: 0, model: null };
  }
}
function saveClientState() {
  const tab = currentTab();
  try {
    writeFileSync3(CLIENT_STATE_PATH, ason.stringify({
      lastTab: tab?.sessionId ?? null,
      peak: state3.peak,
      peakCols: state3.peakCols,
      model: state3.model
    }) + `
`);
  } catch {}
}
function getInputHistory() {
  return currentTab()?.inputHistory ?? [];
}
function appendInputHistory(line) {
  const tab = currentTab();
  if (!tab || !line.trim())
    return;
  tab.inputHistory.push(line);
}
function nextTab() {
  if (state3.tabs.length > 0)
    switchTab((state3.activeTab + 1) % state3.tabs.length);
}
function prevTab() {
  if (state3.tabs.length > 0)
    switchTab((state3.activeTab - 1 + state3.tabs.length) % state3.tabs.length);
}
function addEntry(text2, type = "info") {
  const tab = currentTab();
  if (tab) {
    tab.history.push({ type, text: text2, ts: Date.now() });
    onChange2(false);
  }
}
function addBlockToTab(sessionId, block) {
  let tab = sessionId ? state3.tabs.find((t) => t.sessionId === sessionId) : currentTab();
  if (!tab)
    tab = currentTab();
  if (tab) {
    tab.history.push(block);
    onChange2(false);
  }
}
function setPrompt(text2, cursor) {
  state3.promptText = text2;
  state3.promptCursor = cursor;
  onChange2(false);
}
function clearPrompt() {
  state3.promptText = "";
  state3.promptCursor = 0;
  onChange2(false);
}
function sendCommand(type, text2) {
  const tab = currentTab();
  ipc.appendCommand({ type, text: text2, sessionId: tab?.sessionId });
}
function handleEvent(event) {
  if (event.type === "runtime-start" || event.type === "host-released")
    return;
  if (event.type === "sessions") {
    const newTabs = [];
    for (const s of event.sessions) {
      const existing = state3.tabs.find((t) => t.sessionId === s.id);
      if (existing) {
        existing.name = s.name;
        newTabs.push(existing);
      } else {
        newTabs.push({ sessionId: s.id, name: s.name, history: [], inputHistory: [], loaded: true });
      }
    }
    const grew = newTabs.length > state3.tabs.length;
    state3.tabs = newTabs;
    if (state3.activeTab >= state3.tabs.length)
      state3.activeTab = state3.tabs.length - 1;
    if (grew)
      state3.activeTab = state3.tabs.length - 1;
    onChange2(false);
  } else if (event.type === "prompt") {
    addBlockToTab(event.sessionId, {
      type: "user",
      text: event.text,
      status: event.label,
      ts: event.createdAt ? Date.parse(event.createdAt) : undefined
    });
  } else if (event.type === "response") {
    addBlockToTab(event.sessionId, {
      type: event.isError ? "error" : "assistant",
      text: event.text,
      ts: event.createdAt ? Date.parse(event.createdAt) : undefined
    });
  } else if (event.type === "info") {
    addBlockToTab(event.sessionId ?? null, {
      type: "info",
      text: event.text,
      ts: event.createdAt ? Date.parse(event.createdAt) : undefined
    });
  } else if (event.type === "status" && event.sessionId) {
    state3.busy.set(event.sessionId, event.busy ?? false);
    state3.activity.set(event.sessionId, event.activity ?? "");
    onChange2(false);
  } else if (event.type === "tool-call" && event.sessionId) {
    addBlockToTab(event.sessionId, {
      type: "tool",
      name: event.name,
      title: event.name,
      toolId: event.toolId,
      ts: event.createdAt ? Date.parse(event.createdAt) : undefined
    });
  } else if (event.type === "tool-result" && event.sessionId) {
    const tab = state3.tabs.find((t) => t.sessionId === event.sessionId);
    if (tab) {
      const toolBlock = tab.history.find((b) => b.type === "tool" && b.toolId === event.toolId);
      if (toolBlock) {
        toolBlock.output = event.output;
        onChange2(false);
      }
    }
  }
}
function eventsForCurrentRuntime(events) {
  for (let i = events.length - 1;i >= 0; i--) {
    if (events[i]?.type === "runtime-start")
      return events.slice(i + 1);
  }
  return events;
}
function loadPersistedSessions() {
  const loaded = sessions.loadAllSessions();
  if (loaded.length === 0)
    return;
  const newTabs = [];
  for (const s of loaded) {
    const dirName = s.meta.workingDir?.split("/").pop();
    const name = s.meta.topic ?? dirName ?? `tab ${newTabs.length + 1}`;
    newTabs.push({ sessionId: s.meta.id, name, history: [], inputHistory: [], rawHistory: s.history, loaded: false });
  }
  state3.tabs = newTabs;
  const saved = loadClientState();
  const lastIdx = saved.lastTab ? newTabs.findIndex((t) => t.sessionId === saved.lastTab) : -1;
  state3.activeTab = lastIdx >= 0 ? lastIdx : 0;
  if (saved.model)
    state3.model = saved.model;
  const active = state3.tabs[state3.activeTab];
  if (active)
    ensureTabLoaded(active);
  const cols = process.stdout.columns || 80;
  if (saved.peakCols === cols && saved.peak > 0) {
    state3.peak = saved.peak;
  }
  state3.peakCols = cols;
  perf.mark(`Client loaded ${loaded.length} sessions (1 active)`);
}
async function loadInBackground() {
  if (config6.backgroundLoadBlobs) {
    const active = state3.tabs[state3.activeTab];
    if (active) {
      const n = await blocks.loadToolBlobs(active.history);
      if (n > 0 && config6.repaintAfterBlobLoad)
        onChange2(false);
    }
  }
  if (!config6.backgroundLoadTabs)
    return;
  for (const tab of state3.tabs) {
    if (!tab.loaded)
      ensureTabLoaded(tab);
    if (config6.backgroundLoadBlobs) {
      const n = await blocks.loadToolBlobs(tab.history);
      if (n > 0 && tab === state3.tabs[state3.activeTab])
        onChange2(false);
    }
  }
  perf.mark("All tabs loaded");
}
function startClient(signal) {
  loadPersistedSessions();
  for (const event of eventsForCurrentRuntime(ipc.readAllEvents())) {
    handleEvent(event);
  }
  onChange2(false);
  loadInBackground();
  (async () => {
    for await (const event of ipc.tailEvents(signal)) {
      handleEvent(event);
    }
  })();
}
var client = {
  config: config6,
  state: state3,
  setOnChange,
  setOnTabSwitch,
  currentTab,
  isBusy,
  getActivity,
  switchTab,
  nextTab,
  prevTab,
  addEntry,
  setPrompt,
  clearPrompt,
  sendCommand,
  startClient,
  saveState: saveClientState,
  getInputHistory,
  appendInputHistory
};

// src/cli/help-bar.ts
var config7 = {
  learnThreshold: 5
};
var usageCounts = {};
var HINTS = {
  "idle-empty": [
    { text: "ctrl-t new", keys: ["ctrl-t"] },
    { text: "ctrl-n/p switch", keys: ["ctrl-n", "ctrl-p"] },
    { text: "ctrl-f fork", keys: ["ctrl-f"] },
    { text: "/ commands", keys: ["/"] },
    { text: "ctrl-c quit", keys: ["ctrl-c"] }
  ],
  "idle-text": [
    { text: "enter send", keys: ["enter"] },
    { text: "shift-enter newline", keys: ["shift-enter"] },
    { text: "tab complete", keys: ["tab"] }
  ],
  streaming: [
    { text: "esc pause", keys: ["escape"] }
  ]
};
function isLearned(hint) {
  if (hint.keys.length === 0)
    return false;
  return hint.keys.every((k) => (usageCounts[k] ?? 0) >= config7.learnThreshold);
}
function logKey(name) {
  usageCounts[name] = (usageCounts[name] ?? 0) + 1;
}
function deriveState(busy, hasText) {
  if (busy)
    return "streaming";
  if (hasText)
    return "idle-text";
  return "idle-empty";
}
function build(busy, hasText) {
  const st = deriveState(busy, hasText);
  const visible = HINTS[st].filter((h) => !isLearned(h));
  if (visible.length === 0)
    return "";
  return visible.map((h) => h.text).join(" │ ");
}
var helpBar = {
  config: config7,
  build,
  logKey,
  deriveState,
  isLearned,
  HINTS
};

// src/cli/clipboard.ts
import { mkdirSync as mkdirSync7, existsSync as existsSync10, readdirSync as readdirSync3, writeFileSync as writeFileSync4 } from "fs";
import { homedir as homedir3 } from "os";
var IMAGE_DIR = "/tmp/hal/images";
var PASTE_DIR = "/tmp/hal/paste";
var MAX_INLINE_NEWLINES = 5;
function ensureDir2(dir) {
  if (!existsSync10(dir))
    mkdirSync7(dir, { recursive: true });
}
var pasteCounter = 0;
var pendingPastes = 0;
function allocPlaceholder() {
  return `[image:${++pasteCounter}]`;
}
function getClipboardImageAsync() {
  if (process.platform !== "darwin")
    return Promise.resolve(null);
  ensureDir2(IMAGE_DIR);
  const path = `${IMAGE_DIR}/${Math.random().toString(36).slice(2, 8)}.png`;
  const script = `set tempPath to "${path}"
try
  set clipData to the clipboard as «class PNGf»
  set fileRef to open for access POSIX file tempPath with write permission
  write clipData to fileRef
  close access fileRef
  return tempPath
on error
  return "no-image"
end try`;
  const proc = Bun.spawn(["osascript", "-e", script], { stdout: "pipe", stderr: "pipe" });
  return new Response(proc.stdout).text().then((out) => {
    const s = out.trim();
    return s === "no-image" ? null : s;
  });
}
function readClipboardText() {
  try {
    return Bun.spawnSync(["pbpaste"]).stdout.toString();
  } catch {
    return "";
  }
}
function pasteFromClipboard(onResolve) {
  const text2 = readClipboardText();
  if (text2)
    return text2;
  const placeholder = allocPlaceholder();
  pendingPastes++;
  getClipboardImageAsync().then((imagePath) => {
    pendingPastes--;
    if (pendingPastes === 0)
      pasteCounter = 0;
    if (onResolve)
      onResolve(placeholder, imagePath ? `[${imagePath}]` : "");
  });
  return placeholder;
}
function saveMultilinePaste(text2) {
  ensureDir2(PASTE_DIR);
  const existing = readdirSync3(PASTE_DIR).filter((f) => /^\d{4}\.txt$/.test(f)).map((f) => parseInt(f.slice(0, 4), 10));
  const next = existing.length > 0 ? Math.max(...existing) + 1 : 1;
  const path = `${PASTE_DIR}/${String(next).padStart(4, "0")}.txt`;
  writeFileSync4(path, text2);
  return `[${path}]`;
}
var IMAGE_EXTS = /\.(png|jpg|jpeg|gif|webp)$/i;
function cleanPaste(raw) {
  const text2 = raw.replace(/\r\n/g, `
`).replace(/\r/g, `
`).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
  if (!text2)
    return "";
  const trimmed = text2.trim();
  if (trimmed.startsWith("/") && !trimmed.includes(`
`) && IMAGE_EXTS.test(trimmed) && existsSync10(trimmed)) {
    return `[${trimmed.replace(homedir3(), "~")}]`;
  }
  const newlineCount = (text2.match(/\n/g) || []).length;
  if (newlineCount > MAX_INLINE_NEWLINES)
    return saveMultilinePaste(text2);
  return text2;
}
function hasPendingPastes() {
  return pendingPastes > 0;
}
var clipboard = { pasteFromClipboard, cleanPaste, hasPendingPastes };

// src/cli/prompt.ts
var MAX_PROMPT_LINES = 12;
var MAX_UNDO = 200;
function wordWrapLines(text2, width) {
  if (width <= 0)
    return [text2];
  const result2 = [];
  for (const segment of text2.split(`
`)) {
    let remaining = segment;
    while (remaining.length > width) {
      let breakAt = remaining.lastIndexOf(" ", width);
      if (breakAt <= 0)
        breakAt = width;
      result2.push(remaining.slice(0, breakAt));
      remaining = remaining[breakAt] === " " ? remaining.slice(breakAt + 1) : remaining.slice(breakAt);
    }
    result2.push(remaining);
  }
  return result2;
}
function getLayout(input2, width) {
  const lines = wordWrapLines(input2, width);
  const starts = [];
  let pos = 0;
  for (let i = 0;i < lines.length; i++) {
    starts.push(pos);
    const len = lines[i].length;
    const nextChar = i < lines.length - 1 && pos + len < input2.length ? input2[pos + len] : "";
    pos += len + (nextChar === " " || nextChar === `
` ? 1 : 0);
  }
  return { lines, starts };
}
function cursorToRowCol(input2, absPos, width) {
  const { lines, starts } = getLayout(input2, width);
  for (let i = 0;i < lines.length; i++) {
    if (absPos <= starts[i] + lines[i].length) {
      return { row: i, col: absPos - starts[i] };
    }
  }
  const last = lines.length - 1;
  return { row: last, col: lines[last]?.length ?? 0 };
}
function rowColToCursor(input2, row, col, width) {
  const { lines, starts } = getLayout(input2, width);
  if (lines.length === 0)
    return 0;
  const r = Math.max(0, Math.min(row, lines.length - 1));
  return starts[r] + Math.max(0, Math.min(col, lines[r].length));
}
function verticalMove(input2, width, cur, goal, dir) {
  const { lines } = getLayout(input2, width);
  const { row, col } = cursorToRowCol(input2, cur, width);
  const g = goal ?? col;
  const target = row + dir;
  if (target < 0 || target >= lines.length)
    return { cursor: cur, goalCol: g, atBoundary: true };
  return {
    cursor: rowColToCursor(input2, target, g, width),
    goalCol: g,
    atBoundary: false
  };
}
function wordLeft(text2, pos) {
  let i = pos - 1;
  while (i > 0 && /\s/.test(text2[i]))
    i--;
  while (i > 0 && !/\s/.test(text2[i - 1]))
    i--;
  return Math.max(0, i);
}
function wordRight(text2, pos) {
  let i = pos;
  while (i < text2.length && /\s/.test(text2[i]))
    i++;
  while (i < text2.length && !/\s/.test(text2[i]))
    i++;
  return i;
}
var buf = "";
var cursor = 0;
var goalCol = null;
var selAnchor = null;
var undoStack = [];
var redoStack = [];
var undoGrouping = false;
var history = [];
var historyIndex = -1;
var historyDraft = "";
var renderCallback = null;
function clamp(pos) {
  return Math.max(0, Math.min(pos, buf.length));
}
function selRange() {
  if (selAnchor === null)
    return null;
  const lo = Math.min(selAnchor, cursor);
  const hi = Math.max(selAnchor, cursor);
  return lo === hi ? null : { start: lo, end: hi };
}
function pushUndo() {
  const prev = undoStack[undoStack.length - 1];
  if (prev && prev.text === buf && prev.cursor === cursor)
    return;
  undoStack.push({ text: buf, cursor, selAnchor });
  if (undoStack.length > MAX_UNDO)
    undoStack.splice(0, undoStack.length - MAX_UNDO);
  redoStack.length = 0;
}
function replaceSelection(text2) {
  pushUndo();
  const sel = selRange();
  if (sel) {
    buf = buf.slice(0, sel.start) + text2 + buf.slice(sel.end);
    cursor = sel.start + text2.length;
  } else {
    buf = buf.slice(0, cursor) + text2 + buf.slice(cursor);
    cursor += text2.length;
  }
  selAnchor = null;
  goalCol = null;
}
function typeChar(ch) {
  if (!undoGrouping)
    pushUndo();
  undoGrouping = true;
  const sel = selRange();
  if (sel) {
    buf = buf.slice(0, sel.start) + ch + buf.slice(sel.end);
    cursor = sel.start + ch.length;
  } else {
    buf = buf.slice(0, cursor) + ch + buf.slice(cursor);
    cursor += ch.length;
  }
  selAnchor = null;
  goalCol = null;
}
function deleteRange(start, end) {
  pushUndo();
  buf = buf.slice(0, start) + buf.slice(end);
  cursor = start;
  selAnchor = null;
  goalCol = null;
}
function deleteSel() {
  const sel = selRange();
  if (!sel)
    return false;
  deleteRange(sel.start, sel.end);
  return true;
}
function move(pos, selecting) {
  if (selecting) {
    if (selAnchor === null)
      selAnchor = cursor;
  } else {
    selAnchor = null;
  }
  cursor = clamp(pos);
  goalCol = null;
}
function collapseOrMove(pos, edge) {
  const sel = selRange();
  if (sel) {
    cursor = edge === "start" ? sel.start : sel.end;
    selAnchor = null;
    goalCol = null;
  } else {
    move(pos, false);
  }
}
function undo() {
  undoGrouping = false;
  const snap = undoStack.pop();
  if (!snap)
    return false;
  redoStack.push({ text: buf, cursor, selAnchor });
  buf = snap.text;
  cursor = clamp(snap.cursor);
  selAnchor = snap.selAnchor;
  goalCol = null;
  return true;
}
function redo() {
  undoGrouping = false;
  const snap = redoStack.pop();
  if (!snap)
    return false;
  undoStack.push({ text: buf, cursor, selAnchor });
  buf = snap.text;
  cursor = clamp(snap.cursor);
  selAnchor = snap.selAnchor;
  goalCol = null;
  return true;
}
function writeToClipboard(text2) {
  if (!text2)
    return;
  try {
    const p = Bun.spawn(["pbcopy"], { stdin: "pipe" });
    p.stdin.write(text2);
    p.stdin.end();
  } catch {}
}
function resolvePlaceholder(placeholder, replacement) {
  const idx = buf.lastIndexOf(placeholder);
  if (idx < 0)
    return;
  buf = buf.slice(0, idx) + replacement + buf.slice(idx + placeholder.length);
  if (cursor > idx)
    cursor += replacement.length - placeholder.length;
  cursor = clamp(cursor);
  renderCallback?.();
}
function doPaste() {
  const t = clipboard.cleanPaste(clipboard.pasteFromClipboard((ph, result2) => {
    resolvePlaceholder(ph, result2);
  }));
  if (t)
    replaceSelection(t);
}
function handleKey(k, contentWidth) {
  if (!(k.char && k.char.length === 1 && !k.ctrl && !k.alt && !k.cmd))
    undoGrouping = false;
  if (k.cmd) {
    if (k.key === "c") {
      const s = selRange();
      if (s)
        writeToClipboard(buf.slice(s.start, s.end));
      return true;
    }
    if (k.key === "x") {
      const s = selRange();
      if (s) {
        writeToClipboard(buf.slice(s.start, s.end));
        deleteRange(s.start, s.end);
      }
      return true;
    }
    if (k.key === "v") {
      doPaste();
      return true;
    }
    if (k.key === "a") {
      selAnchor = 0;
      cursor = buf.length;
      return true;
    }
    if (k.key === "u" && k.shift) {
      redo();
      return true;
    }
    if (k.key === "u") {
      undo();
      return true;
    }
    return false;
  }
  if (k.key === "enter" && (k.shift || k.alt)) {
    replaceSelection(`
`);
    return true;
  }
  if (k.key === "enter")
    return false;
  if (k.key === "backspace") {
    if (k.alt) {
      if (!deleteSel() && cursor > 0)
        deleteRange(wordLeft(buf, cursor), cursor);
    } else {
      if (!deleteSel() && cursor > 0)
        deleteRange(cursor - 1, cursor);
    }
    return true;
  }
  if (k.key === "delete") {
    if (!deleteSel() && cursor < buf.length)
      deleteRange(cursor, cursor + 1);
    return true;
  }
  if (k.key === "d" && k.ctrl) {
    if (buf.length === 0)
      return false;
    if (!deleteSel() && cursor < buf.length)
      deleteRange(cursor, cursor + 1);
    return true;
  }
  if (k.key === "u" && k.ctrl) {
    if (cursor > 0)
      deleteRange(0, cursor);
    return true;
  }
  if (k.key === "k" && k.ctrl) {
    if (cursor < buf.length)
      deleteRange(cursor, buf.length);
    return true;
  }
  if (k.key === "a" && k.ctrl) {
    move(0, k.shift);
    return true;
  }
  if (k.key === "e" && k.ctrl) {
    move(buf.length, k.shift);
    return true;
  }
  if ((k.key === "v" || k.key === "y") && k.ctrl) {
    doPaste();
    return true;
  }
  if (k.key === "/" && k.ctrl && k.shift) {
    redo();
    return true;
  }
  if (k.key === "/" && k.ctrl) {
    undo();
    return true;
  }
  if (k.key === "left") {
    if (k.alt) {
      move(wordLeft(buf, cursor), k.shift);
      return true;
    }
    if (k.shift) {
      move(cursor - 1, true);
      return true;
    }
    collapseOrMove(cursor - 1, "start");
    return true;
  }
  if (k.key === "right") {
    if (k.alt) {
      move(wordRight(buf, cursor), k.shift);
      return true;
    }
    if (k.shift) {
      move(cursor + 1, true);
      return true;
    }
    collapseOrMove(cursor + 1, "end");
    return true;
  }
  if (k.key === "up" || k.key === "down") {
    const dir = k.key === "up" ? -1 : 1;
    if (k.alt) {
      move(dir === -1 ? 0 : buf.length, k.shift);
      return true;
    }
    if (!k.shift) {
      const r = verticalMove(buf, contentWidth, cursor, goalCol, dir);
      if (!r.atBoundary) {
        selAnchor = null;
        cursor = r.cursor;
        goalCol = r.goalCol;
        return true;
      }
      if (history.length > 0) {
        if (dir === -1) {
          if (historyIndex < 0) {
            historyDraft = buf;
            historyIndex = history.length - 1;
          } else if (historyIndex > 0) {
            historyIndex--;
          } else {
            cursor = 0;
            goalCol = null;
            selAnchor = null;
            return true;
          }
          buf = history[historyIndex];
          cursor = buf.length;
          goalCol = null;
          selAnchor = null;
        } else {
          if (historyIndex < 0) {
            cursor = buf.length;
            goalCol = null;
            selAnchor = null;
            return true;
          }
          if (historyIndex < history.length - 1) {
            historyIndex++;
            buf = history[historyIndex];
          } else {
            historyIndex = -1;
            buf = historyDraft;
            historyDraft = "";
          }
          cursor = buf.length;
          goalCol = null;
          selAnchor = null;
        }
        return true;
      }
      cursor = dir === -1 ? 0 : buf.length;
      goalCol = null;
      selAnchor = null;
    } else {
      if (selAnchor === null)
        selAnchor = cursor;
      const r = verticalMove(buf, contentWidth, cursor, goalCol, dir);
      if (!r.atBoundary) {
        cursor = r.cursor;
        goalCol = r.goalCol;
      } else {
        cursor = dir === -1 ? 0 : buf.length;
        goalCol = null;
      }
    }
    return true;
  }
  if (k.key === "home") {
    move(0, k.shift);
    return true;
  }
  if (k.key === "end") {
    move(buf.length, k.shift);
    return true;
  }
  if (k.char) {
    if (k.char.length === 1 && !selRange()) {
      typeChar(k.char);
    } else {
      const text2 = k.char.length > 1 ? clipboard.cleanPaste(k.char) : k.char;
      if (text2)
        replaceSelection(text2);
    }
    return true;
  }
  return false;
}
function buildPrompt(contentWidth) {
  const layout = getLayout(buf, contentWidth);
  const promptLines = Math.min(layout.lines.length, MAX_PROMPT_LINES);
  const { row: curRow, col: curCol } = cursorToRowCol(buf, cursor, contentWidth);
  const sel = selRange();
  let scrollTop = 0;
  if (layout.lines.length > promptLines) {
    scrollTop = Math.min(curRow, layout.lines.length - promptLines);
    scrollTop = Math.max(scrollTop, curRow - promptLines + 1);
  }
  const lines = [];
  for (let i = scrollTop;i < scrollTop + promptLines; i++) {
    const lineText = layout.lines[i] ?? "";
    const lineStart = layout.starts[i] ?? 0;
    if (sel) {
      const lo = Math.max(0, sel.start - lineStart);
      const hi = Math.min(lineText.length, sel.end - lineStart);
      if (lo < hi && lo < lineText.length && hi > 0) {
        lines.push(`${lineText.slice(0, lo)}\x1B[7m${lineText.slice(lo, hi)}\x1B[0m${lineText.slice(hi)}`);
      } else {
        lines.push(lineText);
      }
    } else {
      lines.push(lineText);
    }
  }
  return { lines, cursor: { rowOffset: curRow - scrollTop, col: curCol } };
}
var drafts = new Map;
function saveDraft(sessionId) {
  if (buf) {
    drafts.set(sessionId, buf);
  } else {
    drafts.delete(sessionId);
  }
}
function restoreDraft(sessionId) {
  const saved = drafts.get(sessionId) ?? "";
  buf = saved;
  cursor = saved.length;
  goalCol = null;
  selAnchor = null;
  historyIndex = -1;
  historyDraft = "";
}
function text2() {
  return buf;
}
function cursorPos() {
  return cursor;
}
function setText(t, c) {
  buf = t;
  cursor = c ?? t.length;
  goalCol = null;
  selAnchor = null;
  historyIndex = -1;
  historyDraft = "";
}
function clear() {
  buf = "";
  cursor = 0;
  goalCol = null;
  selAnchor = null;
  undoStack = [];
  redoStack = [];
  undoGrouping = false;
  historyIndex = -1;
  historyDraft = "";
}
function setHistory(h) {
  history = h;
  historyIndex = -1;
  historyDraft = "";
}
function pushHistory(text3) {
  history.push(text3);
}
function setRenderCallback(cb) {
  renderCallback = cb;
}
function lineCount(w) {
  return Math.min(getLayout(buf, w).lines.length, MAX_PROMPT_LINES);
}
var prompt = {
  text: text2,
  cursorPos,
  setText,
  clear,
  setHistory,
  pushHistory,
  setRenderCallback,
  handleKey,
  buildPrompt,
  lineCount,
  saveDraft,
  restoreDraft
};

// src/client/render.ts
var CSI = "\x1B[";
var prevLines = [];
var cursorRow = 0;
var cursorCol = 0;
var fullscreen = false;
var lineCountCache = new WeakMap;
function resetRenderer() {
  prevLines = [];
  cursorRow = 0;
  cursorCol = 0;
  fullscreen = false;
}
function renderEntry(block, cols) {
  return blocks.renderBlock(block, cols);
}
function historyLineCount(tab) {
  const cached = lineCountCache.get(tab);
  if (cached && cached.entryCount === tab.history.length)
    return cached.lineCount;
  const cols = process.stdout.columns || 80;
  let count = 0;
  for (const entry of tab.history)
    count += renderEntry(entry, cols).length;
  lineCountCache.set(tab, { entryCount: tab.history.length, lineCount: count });
  return count;
}
function renderHistory(lines, tab) {
  const cols = process.stdout.columns || 80;
  for (let i = 0;i < tab.history.length; i++) {
    if (i > 0)
      lines.push("");
    for (const line of renderEntry(tab.history[i], cols))
      lines.push(line);
  }
}
function renderTabBar(lines) {
  const cols = process.stdout.columns || 80;
  const tabs = client.state.tabs;
  const active = client.state.activeTab;
  const named = tabs.map((tab, i) => i === active ? `\x1B[1m[${i + 1} ${tab.name}]\x1B[0m` : `\x1B[90m ${i + 1} ${tab.name} \x1B[0m`);
  if (visLen(named.join("")) <= cols) {
    lines.push(named.join(""));
    return;
  }
  const padded = tabs.map((_, i) => i === active ? `\x1B[1m[${i + 1}]\x1B[0m` : `\x1B[90m ${i + 1} \x1B[0m`);
  if (visLen(padded.join("")) <= cols) {
    lines.push(padded.join(""));
    return;
  }
  const terse = tabs.map((_, i) => i === active ? `\x1B[1m[${i + 1}]\x1B[0m` : `\x1B[90m${i + 1}\x1B[0m`);
  const terseStr = terse.join(" ");
  lines.push(visLen(terseStr) > cols ? clipVisual(terseStr, cols) : terseStr);
}
function renderStatusLine(lines) {
  const cols = process.stdout.columns || 80;
  const mode = fullscreen ? "full" : "grow";
  const activity = client.getActivity();
  const activityPart = activity ? ` · ${activity}` : "";
  const info2 = ` ${client.state.role} · pid ${process.pid} · ${mode}${activityPart} `;
  const dashes = Math.max(0, cols - visLen(info2));
  lines.push(`\x1B[90m${info2}${"─".repeat(dashes)}\x1B[0m`);
}
function renderHelpBar(lines) {
  const busy = client.isBusy();
  const hasText = prompt.text().length > 0;
  const bar = helpBar.build(busy, hasText);
  if (bar)
    lines.push(`\x1B[90m${bar}\x1B[0m`);
}
function renderPrompt(lines) {
  const cols = process.stdout.columns || 80;
  const p = prompt.buildPrompt(cols);
  for (const line of p.lines)
    lines.push(line);
}
function chromeLines() {
  const cols = process.stdout.columns || 80;
  const busy = client.isBusy();
  const hasText = prompt.text().length > 0;
  const hasHelp = helpBar.build(busy, hasText) !== "";
  return 2 + (hasHelp ? 1 : 0) + prompt.lineCount(cols);
}
function buildFrame() {
  const rows = process.stdout.rows || 24;
  const cols = process.stdout.columns || 80;
  const chrome = chromeLines();
  const tab = client.currentTab();
  const lines = [];
  if (tab)
    renderHistory(lines, tab);
  if (tab) {
    const c = historyLineCount(tab);
    if (c > client.state.peak) {
      client.state.peak = c;
      client.state.peakCols = cols;
    }
  }
  const contentHeight = Math.min(client.state.peak, Math.max(0, rows - chrome));
  const padding = Math.max(0, contentHeight - lines.length);
  for (let i = 0;i < padding; i++)
    lines.push("");
  if (lines.length + chrome > rows)
    fullscreen = true;
  renderTabBar(lines);
  renderStatusLine(lines);
  renderHelpBar(lines);
  renderPrompt(lines);
  return lines;
}
function cursorTarget(frameLen) {
  const cols = process.stdout.columns || 80;
  const p = prompt.buildPrompt(cols);
  const row = frameLen - p.lines.length + p.cursor.rowOffset;
  return { row, col: p.cursor.col + 1 };
}
function moveCursor(from, to) {
  const d = to - from;
  if (d > 0)
    return `${CSI}${d}B`;
  if (d < 0)
    return `${CSI}${-d}A`;
  return "";
}
function positionCursor(from, target) {
  cursorRow = target.row;
  cursorCol = target.col;
  return moveCursor(from, target.row) + `\r${CSI}${target.col}G${CSI}?25h`;
}
function draw(force = false) {
  const rows = process.stdout.rows || 24;
  const lines = buildFrame();
  const cursor2 = cursorTarget(lines.length);
  if (force) {
    const out2 = [`${CSI}?2026h`, `${CSI}?25l`];
    if (!fullscreen) {
      const up = Math.min(cursorRow, rows - 1);
      out2.push("\r");
      if (up > 0)
        out2.push(`${CSI}${up}A`);
      out2.push(`${CSI}J`);
    } else {
      out2.push(`${CSI}2J${CSI}H${CSI}3J`);
    }
    for (let i = 0;i < lines.length; i++) {
      if (i > 0)
        out2.push(`\r
`);
      out2.push(lines[i]);
    }
    out2.push(positionCursor(lines.length - 1, cursor2));
    out2.push(`${CSI}?2026l`);
    prevLines = lines;
    process.stdout.write(out2.join(""));
    return;
  }
  if (fullscreen && lines.length < prevLines.length) {
    return draw(true);
  }
  let first = -1;
  const max = Math.max(lines.length, prevLines.length);
  for (let i = 0;i < max; i++) {
    if ((lines[i] ?? "") !== (prevLines[i] ?? "")) {
      first = i;
      break;
    }
  }
  if (first === -1) {
    if (cursorRow === cursor2.row && cursorCol === cursor2.col && prevLines.length > 0)
      return;
    process.stdout.write(positionCursor(cursorRow, cursor2));
    return;
  }
  const out = [`${CSI}?2026h`, `${CSI}?25l`];
  const isAppend = first >= prevLines.length && prevLines.length > 0;
  if (isAppend) {
    out.push(moveCursor(cursorRow, prevLines.length - 1));
    for (let i = first;i < lines.length; i++) {
      out.push(`\r
${CSI}2K${lines[i]}`);
    }
  } else {
    out.push(moveCursor(cursorRow, first));
    out.push("\r");
    for (let i = first;i < lines.length; i++) {
      if (i > first)
        out.push(`\r
`);
      out.push(`${CSI}2K${lines[i]}`);
    }
  }
  let lastWrittenRow = lines.length - 1;
  if (lines.length < prevLines.length) {
    out.push(`\r
${CSI}J`);
    lastWrittenRow = lines.length;
  }
  out.push(positionCursor(lastWrittenRow, cursor2));
  out.push(`${CSI}?2026l`);
  prevLines = lines;
  process.stdout.write(out.join(""));
}
function clearFrame() {
  if (prevLines.length === 0)
    return;
  const rows = process.stdout.rows || 24;
  if (!fullscreen) {
    const up = Math.min(cursorRow, rows - 1);
    const out = ["\r"];
    if (up > 0)
      out.push(`${CSI}${up}A`);
    out.push(`${CSI}J`);
    process.stdout.write(out.join(""));
  } else {
    process.stdout.write(`${CSI}2J${CSI}H${CSI}3J`);
  }
  prevLines = [];
  cursorRow = 0;
}
var render = { draw, resetRenderer, clearFrame };

// src/cli/keys.ts
function ke(key, mods) {
  return { key, shift: false, alt: false, ctrl: false, cmd: false, ...mods };
}
function parseMods(raw) {
  const m = Math.max(0, raw - 1);
  return { shift: (m & 1) !== 0, alt: (m & 2) !== 0, ctrl: (m & 4) !== 0, cmd: (m & 8) !== 0 };
}
var CSI_SUFFIX_KEYS = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end"
};
var CSI_TILDE_KEYS = {
  1: "home",
  2: "insert",
  3: "delete",
  4: "end",
  5: "pageup",
  6: "pagedown"
};
function parseCsi(body, terminator) {
  const parts = body.split(";");
  const keyName = CSI_SUFFIX_KEYS[terminator];
  if (keyName) {
    const modField = parts[1] ?? "";
    const [rawModStr, eventTypeStr] = modField.split(":", 2);
    if (eventTypeStr === "3")
      return null;
    const mod = parts.length >= 2 ? Number(rawModStr || "1") : 1;
    return ke(keyName, parseMods(mod));
  }
  if (terminator === "~") {
    const num = Number(parts[0]);
    const name = CSI_TILDE_KEYS[num];
    if (!name)
      return null;
    const modField = parts[1] ?? "";
    const [rawModStr, eventTypeStr] = modField.split(":", 2);
    if (eventTypeStr === "3")
      return null;
    const mod = parts.length >= 2 ? Number(rawModStr || "1") : 1;
    return ke(name, parseMods(mod));
  }
  return null;
}
function parseCsiU(body) {
  const fields = body.split(";");
  const codepoint = Number((fields[0] || "").split(":", 1)[0]);
  if (!Number.isFinite(codepoint))
    return null;
  const modPart = fields[1] ?? "";
  const [rawModStr, eventTypeStr] = modPart.split(":", 2);
  const rawMod = Number(rawModStr || "1");
  const eventType = Number(eventTypeStr || "1");
  if (!Number.isFinite(rawMod))
    return null;
  if (eventType === 3)
    return null;
  const mods = parseMods(rawMod);
  let text3;
  if (fields.length >= 3 && fields[2]) {
    const cps = fields[2].split(":").map(Number);
    if (cps.length > 0 && cps.every((n) => Number.isFinite(n) && n > 0))
      text3 = String.fromCodePoint(...cps);
  }
  if (codepoint === 13)
    return ke("enter", mods);
  if (codepoint === 9)
    return ke("tab", mods);
  if (codepoint === 27)
    return ke("escape", mods);
  if (codepoint === 127)
    return ke("backspace", mods);
  if (codepoint === 8)
    return ke("backspace", mods);
  if (codepoint === 65507 || codepoint === 65508)
    return null;
  if (codepoint >= 57344 && codepoint <= 63743)
    return null;
  if (mods.ctrl && !mods.cmd && codepoint >= 0 && codepoint <= 127) {
    const ch2 = String.fromCharCode(codepoint).toLowerCase();
    return ke(ch2, mods);
  }
  const ch = text3 ?? (codepoint >= 32 ? String.fromCodePoint(codepoint) : undefined);
  const key = ch?.toLowerCase() ?? `u+${codepoint.toString(16)}`;
  return ke(key, { ...mods, char: !mods.ctrl && !mods.cmd ? ch : undefined });
}
var CTRL_KEYS = {
  0: "space",
  1: "a",
  2: "b",
  3: "c",
  4: "d",
  5: "e",
  6: "f",
  7: "g",
  8: "backspace",
  9: "tab",
  11: "k",
  12: "l",
  13: "enter",
  14: "n",
  15: "o",
  16: "p",
  17: "q",
  18: "r",
  19: "s",
  20: "t",
  21: "u",
  22: "v",
  23: "w",
  24: "x",
  25: "y",
  26: "z",
  27: "escape",
  31: "/",
  127: "backspace"
};
var PASTE_START = "\x1B[200~";
var PASTE_END = "\x1B[201~";
var pasteBuffer = null;
function splitKeys(data) {
  const keys = [];
  let i = 0;
  if (pasteBuffer !== null) {
    const endIdx = data.indexOf(PASTE_END);
    if (endIdx >= 0) {
      const pasted = pasteBuffer + data.slice(0, endIdx);
      pasteBuffer = null;
      if (pasted)
        keys.push(pasted);
      i = endIdx + PASTE_END.length;
    } else {
      pasteBuffer += data;
      return keys;
    }
  }
  while (i < data.length) {
    if (data.startsWith(PASTE_START, i)) {
      const contentStart = i + PASTE_START.length;
      const endIdx = data.indexOf(PASTE_END, contentStart);
      if (endIdx >= 0) {
        const pasted = data.slice(contentStart, endIdx);
        if (pasted)
          keys.push(pasted);
        i = endIdx + PASTE_END.length;
      } else {
        pasteBuffer = data.slice(contentStart);
        return keys;
      }
      continue;
    }
    if (data[i] === "\x1B") {
      if (i + 1 < data.length && (data[i + 1] === "[" || data[i + 1] === "O")) {
        let j = i + 2;
        while (j < data.length && data.charCodeAt(j) >= 32 && data.charCodeAt(j) <= 63)
          j++;
        if (j < data.length)
          j++;
        keys.push(data.slice(i, j));
        i = j;
      } else if (i + 2 < data.length && data[i + 1] === "\x1B" && (data[i + 2] === "[" || data[i + 2] === "O")) {
        let j = i + 3;
        while (j < data.length && data.charCodeAt(j) >= 32 && data.charCodeAt(j) <= 63)
          j++;
        if (j < data.length)
          j++;
        keys.push(data.slice(i, j));
        i = j;
      } else if (i + 1 < data.length) {
        keys.push(data.slice(i, i + 2));
        i += 2;
      } else {
        keys.push("\x1B");
        i++;
      }
    } else {
      keys.push(data[i]);
      i++;
    }
  }
  return keys;
}
function parseKey2(data) {
  if (!data)
    return null;
  if (data.startsWith("\x1B[")) {
    const terminator = data[data.length - 1];
    const body = data.slice(2, -1);
    if (terminator === "u")
      return parseCsiU(body);
    return parseCsi(body, terminator);
  }
  if (data.length === 2 && data[0] === "\x1B") {
    const ch = data[1];
    if (ch === "\r" || ch === `
`)
      return ke("enter", { alt: true });
    if (ch === "")
      return ke("backspace", { alt: true });
    if (ch === "b")
      return ke("left", { alt: true });
    if (ch === "f")
      return ke("right", { alt: true });
    if (ch >= " ")
      return ke(ch.toLowerCase(), { alt: true });
    const code = ch.charCodeAt(0);
    const name = CTRL_KEYS[code];
    if (name)
      return ke(name, { alt: true, ctrl: true });
  }
  if (data.length === 4 && data[0] === "\x1B" && data[1] === "\x1B" && data[2] === "[") {
    const arrow = CSI_SUFFIX_KEYS[data[3]];
    if (arrow)
      return ke(arrow, { alt: true });
  }
  if (data === "\x1B")
    return ke("escape");
  if (data.length === 1) {
    const code = data.charCodeAt(0);
    if (code === 10)
      return ke("enter", { shift: true });
    if (code < 32 || code === 127) {
      const name = CTRL_KEYS[code];
      if (name) {
        if (name === "tab" || name === "enter" || name === "backspace" || name === "escape")
          return ke(name);
        return ke(name, { ctrl: true });
      }
    }
    return ke(data.toLowerCase(), { char: data });
  }
  if (!data.startsWith("\x1B"))
    return ke(data, { char: data });
  return null;
}
function parseKeys(data) {
  const tokens = splitKeys(data);
  const events = [];
  for (const token of tokens) {
    const k = parseKey2(token);
    if (k)
      events.push(k);
  }
  return events;
}
var keys = { parseKey: parseKey2, parseKeys };

// src/cli/completion.ts
import { basename as basename2, resolve as resolve4, dirname as dirname4 } from "path";
import { readdirSync as readdirSync4, statSync as statSync3 } from "fs";
import { homedir as homedir4 } from "os";
var COMMANDS = [
  { name: "help" },
  { name: "reset" },
  { name: "compact" },
  { name: "model", arg: "model" },
  { name: "cd", arg: "dir" },
  { name: "continue" },
  { name: "fork" },
  { name: "tab" },
  { name: "close" },
  { name: "system" },
  { name: "show" },
  { name: "clear" },
  { name: "exit" }
];
var config8 = {
  modelNames: [
    "sonnet",
    "opus",
    "haiku",
    "claude-sonnet-4-20250514",
    "claude-opus-4-20250514",
    "gpt-4o",
    "gpt-4.1",
    "o3",
    "o4-mini",
    "gemini-2.5-pro"
  ]
};
var state4 = {
  active: false,
  selectedIndex: 0,
  lastResult: null
};
function longestCommonPrefix(values) {
  if (values.length === 0)
    return "";
  let prefix = values[0];
  for (let i = 1;i < values.length; i++) {
    while (prefix.length > 0 && !values[i].startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
    }
    if (!prefix)
      break;
  }
  return prefix;
}
function expandTilde(p) {
  if (p === "~")
    return homedir4();
  if (p.startsWith("~/"))
    return homedir4() + p.slice(1);
  return p;
}
function listDirs(dir) {
  try {
    return readdirSync4(dir, { withFileTypes: true }).filter((e) => {
      if (e.name.startsWith("."))
        return false;
      if (e.isDirectory())
        return true;
      if (e.isSymbolicLink()) {
        try {
          return statSync3(resolve4(dir, e.name)).isDirectory();
        } catch {
          return false;
        }
      }
      return false;
    }).map((e) => e.name).sort();
  } catch {
    return [];
  }
}
function completeDirs(argPrefix, cwd) {
  const expanded = expandTilde(argPrefix);
  const useTilde = argPrefix.startsWith("~");
  let searchDir;
  let prefix;
  if (expanded.endsWith("/") || expanded === "") {
    searchDir = expanded === "" ? cwd : resolve4(cwd, expanded);
    prefix = "";
  } else {
    searchDir = resolve4(cwd, dirname4(expanded));
    prefix = basename2(expanded);
  }
  const dirs = listDirs(searchDir);
  const matching = prefix ? dirs.filter((d) => d.startsWith(prefix)) : dirs;
  const base = expanded.endsWith("/") ? argPrefix : argPrefix === "" ? "" : argPrefix.includes("/") ? argPrefix.slice(0, argPrefix.lastIndexOf("/") + 1) : "";
  return matching.map((d) => base + d + "/");
}
function complete(text3, cursor2) {
  if (cursor2 < 0 || cursor2 > text3.length)
    cursor2 = text3.length;
  const before = text3.slice(0, cursor2);
  if (!before.startsWith("/"))
    return null;
  if (before.includes(`
`))
    return null;
  const body = before.slice(1);
  const hasSpace = /[ \t]$/.test(before);
  const trimmed = body.trim();
  const parts = trimmed ? trimmed.split(/\s+/) : [];
  if (parts.length === 0 || parts.length === 1 && !hasSpace) {
    const needle = parts[0] ?? "";
    const names = COMMANDS.map((c) => c.name).sort();
    const matches = names.filter((n) => n.startsWith(needle));
    if (matches.length === 0)
      return null;
    const items2 = matches.map((n) => `/${n}`);
    const prefix2 = longestCommonPrefix(items2);
    return { items: items2, prefix: prefix2, start: 0 };
  }
  const command = parts[0];
  const spec = COMMANDS.find((c) => c.name === command);
  if (!spec?.arg)
    return null;
  if (parts.length > 2)
    return null;
  const argPrefix = hasSpace ? "" : parts[1] ?? "";
  let values = [];
  if (spec.arg === "model") {
    values = config8.modelNames.filter((m) => m.startsWith(argPrefix));
  } else if (spec.arg === "dir") {
    values = completeDirs(argPrefix, process.cwd());
  }
  if (values.length === 0)
    return null;
  const items = values.map((v) => `/${command} ${v}`);
  const prefix = longestCommonPrefix(items);
  return { items, prefix, start: 0 };
}
function apply(text3, cursor2, item) {
  const after = text3.slice(cursor2);
  const isDirCompletion = item.match(/^\/cd\s/) && item.endsWith("/");
  const suffix = isDirCompletion ? "" : " ";
  const newText = item + suffix + after;
  const newCursor = item.length + suffix.length;
  return { text: newText, cursor: newCursor };
}
function cycle(dir) {
  if (!state4.lastResult || state4.lastResult.items.length === 0)
    return;
  const len = state4.lastResult.items.length;
  state4.selectedIndex = (state4.selectedIndex + dir + len) % len;
}
function dismiss() {
  state4.active = false;
  state4.selectedIndex = 0;
  state4.lastResult = null;
}
function selectedItem() {
  if (!state4.active || !state4.lastResult)
    return null;
  return state4.lastResult.items[state4.selectedIndex] ?? null;
}
var completion = {
  config: config8,
  state: state4,
  complete,
  apply,
  cycle,
  dismiss,
  selectedItem
};

// src/client/cli.ts
var RESTART_CODE = 100;
var KITTY_TERMS = /^(kitty|ghostty|iTerm\.app)$/;
var useKitty = KITTY_TERMS.test(process.env.TERM_PROGRAM ?? "");
var KITTY_ON = "\x1B[>19u";
var KITTY_OFF = "\x1B[<u";
var BRACKETED_PASTE_ON = "\x1B[?2004h";
var BRACKETED_PASTE_OFF = "\x1B[?2004l";
function setTabStops(cols) {
  const tw = blocks.config.tabWidth;
  let seq = "\x1B[3g";
  for (let c = tw + 1;c <= cols; c += tw) {
    seq += `\x1B[${c}G\x1BH`;
  }
  seq += "\x1B[1G";
  process.stdout.write(seq);
}
function restoreDefaultTabStops(cols) {
  let seq = "\x1B[3g";
  for (let c = 9;c <= cols; c += 8) {
    seq += `\x1B[${c}G\x1BH`;
  }
  seq += "\x1B[1G";
  process.stdout.write(seq);
}
function draw2(force = false) {
  render.draw(force);
}
var terminalCleaned = false;
function cleanupTerminal() {
  if (terminalCleaned)
    return;
  terminalCleaned = true;
  client.saveState();
  if (useKitty)
    process.stdout.write(KITTY_OFF);
  process.stdout.write(BRACKETED_PASTE_OFF);
  restoreDefaultTabStops(process.stdout.columns || 80);
  if (process.stdin.isTTY)
    process.stdin.setRawMode(false);
}
function submit() {
  const text3 = prompt.text().trim();
  if (!text3)
    return;
  completion.dismiss();
  prompt.pushHistory(text3);
  client.appendInputHistory(text3);
  if (client.isBusy()) {
    client.sendCommand("steer", text3);
  } else {
    client.sendCommand("prompt", text3);
  }
  prompt.clear();
}
function handleCompletionKey(k) {
  if (k.key === "tab" && !k.ctrl && !k.alt && !k.cmd) {
    if (!completion.state.active) {
      const result2 = completion.complete(prompt.text(), prompt.cursorPos());
      if (!result2 || result2.items.length === 0)
        return false;
      completion.state.active = true;
      completion.state.lastResult = result2;
      completion.state.selectedIndex = 0;
      if (result2.prefix.length > prompt.text().slice(0, prompt.cursorPos()).length) {
        const after = prompt.text().slice(prompt.cursorPos());
        prompt.setText(result2.prefix + after, result2.prefix.length);
      }
      if (result2.items.length === 1) {
        const applied = completion.apply(prompt.text(), prompt.cursorPos(), result2.items[0]);
        prompt.setText(applied.text, applied.cursor);
        completion.dismiss();
      }
      return true;
    }
    completion.cycle(k.shift ? -1 : 1);
    return true;
  }
  if (!completion.state.active)
    return false;
  if (k.key === "down" && !k.ctrl && !k.alt) {
    completion.cycle(1);
    return true;
  }
  if (k.key === "up" && !k.ctrl && !k.alt) {
    completion.cycle(-1);
    return true;
  }
  if (k.key === "enter" && !k.shift || k.char === " " && !k.ctrl && !k.alt) {
    const item = completion.selectedItem();
    if (item) {
      const applied = completion.apply(prompt.text(), prompt.cursorPos(), item);
      prompt.setText(applied.text, applied.cursor);
    }
    completion.dismiss();
    return true;
  }
  if (k.key === "escape") {
    completion.dismiss();
    return true;
  }
  completion.dismiss();
  return false;
}
function canonicalKeyName(k) {
  const parts = [];
  if (k.ctrl)
    parts.push("ctrl");
  if (k.alt)
    parts.push("alt");
  if (k.shift)
    parts.push("shift");
  if (k.cmd)
    parts.push("cmd");
  parts.push(k.key || k.char || "?");
  return parts.join("-");
}
function handleAppKey(k) {
  if (k.key === "r" && k.ctrl) {
    render.clearFrame();
    cleanupTerminal();
    process.exit(RESTART_CODE);
  }
  if (k.key === "c" && k.ctrl) {
    cleanupTerminal();
    process.stdout.write(`\r
`);
    process.exit(0);
  }
  if (k.key === "d" && k.ctrl && !prompt.text()) {
    cleanupTerminal();
    process.stdout.write(`\r
`);
    process.exit(0);
  }
  if (k.key === "l" && k.ctrl) {
    draw2(true);
    return true;
  }
  if (k.key === "t" && k.ctrl) {
    if (client.state.tabs.length < 40)
      client.sendCommand("open");
    return true;
  }
  if (k.key === "w" && k.ctrl) {
    if (client.state.tabs.length > 1)
      client.sendCommand("close");
    return true;
  }
  if (k.key === "n" && k.ctrl) {
    client.nextTab();
    return true;
  }
  if (k.key === "p" && k.ctrl) {
    client.prevTab();
    return true;
  }
  if (k.alt && k.key >= "0" && k.key <= "9") {
    client.switchTab(k.key === "0" ? 9 : Number(k.key) - 1);
    return true;
  }
  if (k.key === "enter" && !k.shift) {
    if (clipboard.hasPendingPastes())
      return true;
    submit();
    draw2();
    return true;
  }
  return false;
}
function startCli(signal) {
  client.setOnChange((force) => draw2(force));
  prompt.setRenderCallback(() => {
    syncPromptToClient();
    draw2();
  });
  client.startClient(signal);
  prompt.setHistory(client.getInputHistory());
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    if (useKitty)
      process.stdout.write(KITTY_ON);
    process.stdout.write(BRACKETED_PASTE_ON);
    setTabStops(process.stdout.columns || 80);
  }
  process.on("exit", cleanupTerminal);
  perf.mark("First draw");
  draw2();
  perf.mark("First draw done");
  process.stdout.on("resize", () => {
    setTabStops(process.stdout.columns || 80);
    draw2(true);
  });
  perf.mark("Ready for input");
  client.setOnTabSwitch((fromSession, toSession) => {
    prompt.saveDraft(fromSession);
    prompt.restoreDraft(toSession);
    prompt.setHistory(client.getInputHistory());
    syncPromptToClient();
  });
  process.stdin.on("data", (data) => {
    const cols = process.stdout.columns || 80;
    const contentWidth = cols;
    for (const k of keys.parseKeys(data.toString("utf-8"))) {
      if (k.ctrl || k.alt || k.cmd || k.key === "enter" || k.key === "escape" || k.key === "tab") {
        helpBar.logKey(canonicalKeyName(k));
      }
      if (handleCompletionKey(k)) {
        syncPromptToClient();
        draw2();
        continue;
      }
      if (handleAppKey(k))
        continue;
      if (prompt.handleKey(k, contentWidth)) {
        syncPromptToClient();
        draw2();
      }
    }
  });
}
function syncPromptToClient() {
  client.setPrompt(prompt.text(), prompt.cursorPos());
}
var cli = { startCli };

// src/utils/is-pid-alive.ts
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0)
    return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

// src/utils/log.ts
init_state();
import { appendFileSync as appendFileSync3, statSync as statSync4, writeFileSync as writeFileSync5 } from "fs";
var LOG_PATH = `${STATE_DIR}/hal.log`;
var MAX_SIZE = 1e6;
var envVal = (process.env.HAL_LOG ?? "").toLowerCase();
var enabledLevel = envVal === "debug" ? "debug" : envVal === "1" || envVal === "true" || envVal === "info" ? "info" : null;
function isEnabled(level) {
  if (!enabledLevel)
    return false;
  if (enabledLevel === "debug")
    return true;
  if (level === "debug")
    return false;
  return true;
}
function write(level, msg, data) {
  if (!isEnabled(level))
    return;
  try {
    const st = statSync4(LOG_PATH);
    if (st.size > MAX_SIZE)
      writeFileSync5(LOG_PATH, "");
  } catch {}
  const ts = new Date().toISOString();
  const dataStr = data ? " " + JSON.stringify(data) : "";
  const line = `[${ts}] [${level.toUpperCase()}] ${msg}${dataStr}
`;
  try {
    appendFileSync3(LOG_PATH, line);
  } catch {}
}
function info2(msg, data) {
  write("info", msg, data);
}
function error2(msg, data) {
  write("error", msg, data);
}
function debug(msg, data) {
  write("debug", msg, data);
}
var log = { info: info2, error: error2, debug, isEnabled, LOG_PATH };

// src/config.ts
init_live_file();
var modules = {
  client: client.config,
  blocks: blocks.config
};
var HAL_DIR3 = import.meta.dir.replace(/\/src$/, "");
var data = liveFiles.liveFile(`${HAL_DIR3}/config.ason`, {});
function apply2() {
  for (const [name, overrides] of Object.entries(data)) {
    const target = modules[name];
    if (target && overrides && typeof overrides === "object") {
      Object.assign(target, overrides);
    }
  }
}
apply2();
liveFiles.onChange(data, apply2);

// src/main.ts
perf.mark("First line of code executed");
ensureStateDir();
perf.mark("State directories exist");
var isHost = await ipc.claimHost();
var lock = ipc.readHostLock();
var serverPid = isHost ? process.pid : lock?.pid ?? null;
perf.mark(`Host status established (I am ${isHost ? "host" : "client"}, server pid ${serverPid})`);
log.info("Startup", { isHost, serverPid, pid: process.pid });
client.state.role = isHost ? "server" : "client";
if (isHost) {
  ipc.appendEvent({
    type: "runtime-start",
    pid: process.pid,
    startedAt: new Date().toISOString()
  });
  client.addEntry(`Server started (pid ${process.pid}) [${perf.elapsed()}ms]`);
} else {
  client.addEntry(`Joined server (pid ${serverPid}) [${perf.elapsed()}ms]`);
}
var ac = new AbortController;
function cleanup() {
  ac.abort();
  if (isHost) {
    ipc.appendEvent({ type: "host-released" });
    ipc.releaseHost();
  }
  perf.stop();
}
process.on("exit", cleanup);
process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});
if (isHost) {
  runtime.startRuntime(ac.signal);
} else {
  let promoting = false;
  async function tryPromote() {
    if (promoting || isHost)
      return;
    promoting = true;
    try {
      if (await ipc.promote()) {
        isHost = true;
        serverPid = process.pid;
        client.state.role = "server";
        client.addEntry(`Promoted to server (pid ${process.pid})`);
        runtime.startRuntime(ac.signal);
      }
    } finally {
      promoting = false;
    }
  }
  (async () => {
    for await (const event of ipc.tailEvents(ac.signal)) {
      if (event.type === "host-released")
        tryPromote();
    }
  })();
  const pollTimer = setInterval(() => {
    if (isHost || promoting)
      return;
    if (serverPid !== null && !isPidAlive(serverPid)) {
      log.info("Server pid died, promoting", { serverPid });
      serverPid = null;
      tryPromote();
    }
  }, 1000);
  ac.signal.addEventListener("abort", () => clearInterval(pollTimer));
}
perf.setSink((lines) => {
  for (const line of lines)
    client.addEntry(line);
});
cli.startCli(ac.signal);

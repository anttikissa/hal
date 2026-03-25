# Plan 6/7: MCP

## Overview
MCP (Model Context Protocol) client for external tool servers.
Budget: ~180 lines added. Target after: ~6,065.

## Subplan

### 6a. MCP client (~180 lines)

**File:** `src/mcp/client.ts`

Port from `prev/src/mcp/client.ts` (220 lines). Skip mock server for now.

MCP client connects to external tool servers defined in `mcp.json`:

```json
{
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-server-filesystem", "/tmp"]
    }
  }
}
```

Architecture:
- `MCPClient` class: connects to server via stdio transport
- JSON-RPC 2.0 over stdin/stdout of child process
- Methods:
  - `connect(config: ServerConfig): Promise<void>`
  - `listTools(): Promise<MCPTool[]>`
  - `callTool(name: string, args: any): Promise<any>`
  - `disconnect(): void`

Lifecycle:
- Read mcp.json on startup
- Launch each server as child process
- List tools from each server
- Register MCP tools alongside native tools (prefix with server name)
- Proxy tool calls to appropriate server

Key concerns:
- Server crash recovery: detect dead process, attempt restart
- Timeout: tool calls timeout after 60s
- Multiple servers: each server's tools are namespaced

Protocol flow (JSON-RPC):
1. → `initialize` with capabilities
2. ← server responds with capabilities + tool list
3. → `tools/list` to enumerate available tools
4. → `tools/call` with name + arguments
5. ← result or error

## Dependencies
- Depends on tool registry (plan 5a) for registration
- Depends on protocol types (plan 2a)

## Testing
- `bun test` after implementation
- `bun cloc` to verify budget

# mcp_server_core

## Overview

`mcp_server_core` is a small shared library that bootstraps MCP (Model Context Protocol) servers with Express and the Streamable HTTP transport. It centralizes common concerns so individual servers can focus on registering tools, resources, and prompts.

Key features:
- Express-based HTTP entrypoint at `/mcp` using MCP Streamable HTTP transport
- Configurable body size limits, CORS, and startup logging
- Pluggable API key authentication via `Authorization: Bearer <key>`
- One-time startup logging of registered tools/resources/prompts

## Installation

This package is designed to be consumed from source and built automatically via `prepare`.

```bash
npm install github:karrierenest/mcp_server_core#master
```

Peer dependencies (must be present in the consuming project):
- `@modelcontextprotocol/sdk` (>= 1.16.0)
- `express` (>= 4.18.3)

## Usage

Register your tools/resources in a single place and pass a `register` hook to the server factory:

```ts
import { createMcpHttpServer } from "mcp-server-core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

createMcpHttpServer({
  serverName: "my-mcp-server",
  serverVersion: "1.0.0",
  port: 3000,
  bodyLimitMb: 15,
  enableCors: true,
  logRegistrations: true,
  auth: { type: "apiKey", envVarName: "mcp_api_key" },
  register: (server: McpServer) => {
    server.registerTool(
      "ping",
      { title: "Ping", description: "Echo a message", inputSchema: { message: { type: "string" } } },
      async ({ message }: { message: string }) => ({ content: [{ type: "text", text: `pong: ${message}` }] }),
    );
  },
});
```

## API

```ts
createMcpHttpServer(options: CreateMcpHttpServerOptions): { app, server }
```

### Options
- `serverName` (string): Name shown in logs and advertised to the client
- `serverVersion` (string): Semantic version string
- `port` (number, default 3000): Port for the HTTP server
- `bodyLimitMb` (number, default 15): Max JSON payload size for requests
- `enableCors` (boolean, default true): Enables permissive CORS for development and simple integrations
- `logRegistrations` (boolean, default true): Logs tools/resources/prompts registered during startup
- `auth` (object):
  - `{ type: "none" }` to disable auth
  - `{ type: "apiKey", headerName = "Authorization", scheme = "Bearer", envVarName = "mcp_api_key", allowInQueryParam? }` to enforce a static API key loaded from `process.env[envVarName]`
- `register` ((server: McpServer) => void | Promise<void>): Hook to register tools/resources/prompts

### Endpoints
- `POST /mcp` — MCP Streamable HTTP endpoint. Clients MUST send `Accept: application/json, text/event-stream`.

### Error handling
- Payloads larger than `bodyLimitMb` will return HTTP 413 with a helpful message
- API key auth returns 401 (missing) or 403 (invalid)

## Authentication

Enable API key auth by setting:

```ts
auth: { type: "apiKey", envVarName: "mcp_api_key" }
```

And provide the key via environment:

```bash
export mcp_api_key=YOUR_SECRET
```

Clients send:

```http
Authorization: Bearer YOUR_SECRET
```

## Build

This package ships TypeScript sources and builds on install via `prepare`.

```bash
npm run build
```

## License

MIT






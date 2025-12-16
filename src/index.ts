// Clean single implementation with backward compatibility
import express, { Request, Response, NextFunction } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// ============================================================================
// ORIGINAL TYPES AND FUNCTION (backward compatible - DO NOT MODIFY)
// ============================================================================

export type RegisterHooks = (server: McpServer) => void | Promise<void>;

export interface CreateMcpHttpServerOptions {
  serverName: string;
  serverVersion: string;
  port?: number; // default 3000
  bodyLimitMb?: number; // default 15
  enableCors?: boolean; // default true
  logRegistrations?: boolean; // default true
  auth?:
    | { type: "none" }
    | {
        type: "apiKey";
        headerName?: string; // default: Authorization
        scheme?: string; // default: Bearer
        envVarName?: string; // default: MCP_API_KEY
        allowInQueryParam?: string; // optional: e.g. "api_key" (discouraged)
      };
  register: RegisterHooks; // register tools/resources/prompts
}

/**
 * Creates a standard MCP HTTP server with endpoint at /mcp
 * This is the original function - fully backward compatible.
 */
export function createMcpHttpServer(options: CreateMcpHttpServerOptions) {
  const { serverName, serverVersion, port = 3000, bodyLimitMb = 15, enableCors = true, logRegistrations = true, auth = { type: "none" }, register } = options;

  const app = express();
  app.use(express.json({ limit: `${bodyLimitMb}mb` }));
  app.use(express.urlencoded({ limit: `${bodyLimitMb}mb`, extended: true }));

  app.use((error: any, _req: Request, res: Response, next: NextFunction) => {
    if (error instanceof Error && error.message.includes("request entity too large")) {
      return res.status(413).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: `Request payload too large. Maximum allowed size is ${bodyLimitMb}MB. Please reduce attachment sizes or number of files.` },
        id: null,
      });
    }
    next(error);
  });

  if (enableCors) {
    app.use((req, res, next) => {
      res.header("Access-Control-Allow-Origin", "*");
      res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, MCP-Session-Id");
      if (req.method === "OPTIONS") {
        res.sendStatus(200);
      } else {
        next();
      }
    });
  }

  // Authentication middleware
  if ((auth as any)?.type === "apiKey") {
    const { headerName = "authorization", scheme = "Bearer", envVarName = "mcp_api_key", allowInQueryParam } = auth as Exclude<typeof auth, { type: "none" }>;
    const expectedKey = process.env[envVarName];
    if (!expectedKey) {
      console.warn(`[MCP] API key auth enabled but env var '${envVarName}' is not set.`);
    }
    app.use((req, res, next) => {
      try {
        const headerValue = req.headers[headerName.toLowerCase()] as string | undefined;
        let provided: string | undefined;
        if (headerValue) {
          const parts = headerValue.split(" ");
          if (parts.length === 2 && parts[0] === scheme && parts[1]) {
            provided = parts[1];
          }
        }
        if (!provided && allowInQueryParam && typeof req.query?.[allowInQueryParam] === "string") {
          provided = String(req.query[allowInQueryParam]);
        }
        if (!expectedKey || !provided) {
          return res.status(401).json({
            jsonrpc: "2.0",
            error: { code: -32010, message: "Unauthorized: Missing API key" },
            id: null,
          });
        }
        if (provided !== expectedKey) {
          return res.status(403).json({
            jsonrpc: "2.0",
            error: { code: -32011, message: "Forbidden: Invalid API key" },
            id: null,
          });
        }
        return next();
      } catch (e) {
        console.error("[MCP] Auth middleware error:", e);
        return res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    });
  }

  // One-time startup registration logging (without binding to a live transport)
  if (logRegistrations) {
    try {
      const tempServer = new McpServer({ name: serverName, version: serverVersion });
      const anyServer = tempServer as any;
      if (typeof anyServer.registerTool === "function") {
        const orig = anyServer.registerTool.bind(tempServer);
        anyServer.registerTool = (name: string, def: any, handler: any) => {
          console.log(`[MCP] Tool registered: ${name}`);
          return orig(name, def, handler);
        };
      }
      if (typeof anyServer.registerResource === "function") {
        const origRes = anyServer.registerResource.bind(tempServer);
        anyServer.registerResource = (name: string, template: any, meta: any, resolver: any) => {
          console.log(`[MCP] Resource registered: ${name}`);
          return origRes(name, template, meta, resolver);
        };
      }
      if (typeof anyServer.registerPrompt === "function") {
        const origPrompt = anyServer.registerPrompt.bind(tempServer);
        anyServer.registerPrompt = (name: string, prompt: any) => {
          console.log(`[MCP] Prompt registered: ${name}`);
          return origPrompt(name, prompt);
        };
      }
      // Support both sync/async register hooks without making outer function async
      const maybePromise = register(tempServer);
      if (maybePromise && typeof (maybePromise as any).then === "function") {
        (maybePromise as Promise<void>).then(() => tempServer.close()).catch(() => tempServer.close());
      } else {
        tempServer.close();
      }
    } catch (e) {
      console.warn("[MCP] Startup registration logging failed:", e);
    }
  }

  app.post("/mcp", async (req, res) => {
    try {
      const mcpServer = new McpServer({ name: serverName, version: serverVersion });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        transport.close();
        mcpServer.close();
      });

      await Promise.resolve(register(mcpServer));
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  const methodNotAllowed = (req: Request, res: Response) => {
    console.log(`Received ${req.method} MCP request`);
    res.writeHead(405).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  const server = app.listen(port, (error?: unknown) => {
    if (error) {
      console.error("Failed to start server:", error);
      process.exit(1);
    }
    console.log(`MCP Stateless Streamable HTTP Server "${serverName}" listening on port ${port}`);
  });

  return { app, server };
}

// ============================================================================
// NEW TYPES AND FUNCTION (with URL parameter support)
// ============================================================================

export type RegisterHooksWithUrlParam = (server: McpServer, urlParamValue: string) => void | Promise<void>;

export interface CreateMcpHttpServerWithUrlParamOptions {
  serverName: string;
  serverVersion: string;
  port?: number; // default 3000
  bodyLimitMb?: number; // default 15
  enableCors?: boolean; // default true
  logRegistrations?: boolean; // default true
  urlParamName: string; // e.g. "index_name" - creates route /mcp/:index_name
  auth?:
    | { type: "none" }
    | {
        type: "apiKey";
        headerName?: string; // default: Authorization
        scheme?: string; // default: Bearer
        envVarName?: string; // default: MCP_API_KEY
        allowInQueryParam?: string; // optional: e.g. "api_key" (discouraged)
      };
  register: RegisterHooksWithUrlParam; // register callback receives the URL param value
}

/**
 * Creates an MCP HTTP server with a required URL path parameter.
 * Endpoint: /mcp/:urlParamName (e.g., /mcp/:index_name -> /mcp/my-index)
 * 
 * The URL parameter value is passed to the register callback, allowing tools
 * to be configured based on the URL. Requests to /mcp without the parameter
 * will return a 400 error.
 * 
 * Example usage:
 * ```typescript
 * createMcpHttpServerWithUrlParam({
 *   serverName: "my-server",
 *   serverVersion: "1.0.0",
 *   urlParamName: "index_name",
 *   register: (mcpServer, indexName) => {
 *     // indexName comes from URL: /mcp/{indexName}
 *     registerMyTool(mcpServer, indexName);
 *   }
 * });
 * ```
 */
export function createMcpHttpServerWithUrlParam(options: CreateMcpHttpServerWithUrlParamOptions) {
  const { serverName, serverVersion, port = 3000, bodyLimitMb = 15, enableCors = true, logRegistrations = true, urlParamName, auth = { type: "none" }, register } = options;

  const app = express();
  app.use(express.json({ limit: `${bodyLimitMb}mb` }));
  app.use(express.urlencoded({ limit: `${bodyLimitMb}mb`, extended: true }));

  app.use((error: any, _req: Request, res: Response, next: NextFunction) => {
    if (error instanceof Error && error.message.includes("request entity too large")) {
      return res.status(413).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: `Request payload too large. Maximum allowed size is ${bodyLimitMb}MB. Please reduce attachment sizes or number of files.` },
        id: null,
      });
    }
    next(error);
  });

  if (enableCors) {
    app.use((req, res, next) => {
      res.header("Access-Control-Allow-Origin", "*");
      res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, MCP-Session-Id");
      if (req.method === "OPTIONS") {
        res.sendStatus(200);
      } else {
        next();
      }
    });
  }

  // Authentication middleware
  if ((auth as any)?.type === "apiKey") {
    const { headerName = "authorization", scheme = "Bearer", envVarName = "mcp_api_key", allowInQueryParam } = auth as Exclude<typeof auth, { type: "none" }>;
    const expectedKey = process.env[envVarName];
    if (!expectedKey) {
      console.warn(`[MCP] API key auth enabled but env var '${envVarName}' is not set.`);
    }
    app.use((req, res, next) => {
      try {
        const headerValue = req.headers[headerName.toLowerCase()] as string | undefined;
        let provided: string | undefined;
        if (headerValue) {
          const parts = headerValue.split(" ");
          if (parts.length === 2 && parts[0] === scheme && parts[1]) {
            provided = parts[1];
          }
        }
        if (!provided && allowInQueryParam && typeof req.query?.[allowInQueryParam] === "string") {
          provided = String(req.query[allowInQueryParam]);
        }
        if (!expectedKey || !provided) {
          return res.status(401).json({
            jsonrpc: "2.0",
            error: { code: -32010, message: "Unauthorized: Missing API key" },
            id: null,
          });
        }
        if (provided !== expectedKey) {
          return res.status(403).json({
            jsonrpc: "2.0",
            error: { code: -32011, message: "Forbidden: Invalid API key" },
            id: null,
          });
        }
        return next();
      } catch (e) {
        console.error("[MCP] Auth middleware error:", e);
        return res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    });
  }

  // One-time startup registration logging (without binding to a live transport)
  // Uses "__startup_log__" as placeholder for the URL param value
  if (logRegistrations) {
    try {
      const tempServer = new McpServer({ name: serverName, version: serverVersion });
      const anyServer = tempServer as any;
      if (typeof anyServer.registerTool === "function") {
        const orig = anyServer.registerTool.bind(tempServer);
        anyServer.registerTool = (name: string, def: any, handler: any) => {
          console.log(`[MCP] Tool registered: ${name}`);
          return orig(name, def, handler);
        };
      }
      if (typeof anyServer.registerResource === "function") {
        const origRes = anyServer.registerResource.bind(tempServer);
        anyServer.registerResource = (name: string, template: any, meta: any, resolver: any) => {
          console.log(`[MCP] Resource registered: ${name}`);
          return origRes(name, template, meta, resolver);
        };
      }
      if (typeof anyServer.registerPrompt === "function") {
        const origPrompt = anyServer.registerPrompt.bind(tempServer);
        anyServer.registerPrompt = (name: string, prompt: any) => {
          console.log(`[MCP] Prompt registered: ${name}`);
          return origPrompt(name, prompt);
        };
      }
      // Use "__startup_log__" as placeholder for URL param value during startup logging
      const maybePromise = register(tempServer, "__startup_log__");
      if (maybePromise && typeof (maybePromise as any).then === "function") {
        (maybePromise as Promise<void>).then(() => tempServer.close()).catch(() => tempServer.close());
      } else {
        tempServer.close();
      }
    } catch (e) {
      console.warn("[MCP] Startup registration logging failed:", e);
    }
  }

  // Handler for requests WITHOUT URL param - return error
  app.post("/mcp", async (_req, res) => {
    return res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32602, message: `Missing required '${urlParamName}' in URL. Use /mcp/{${urlParamName}} instead.` },
      id: null,
    });
  });

  // Handler for requests WITH URL param in path
  app.post(`/mcp/:${urlParamName}`, async (req, res) => {
    try {
      const urlParamValue = req.params[urlParamName];

      // Validate URL param
      if (!urlParamValue || urlParamValue.trim() === "") {
        return res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32602, message: `Missing required '${urlParamName}' in URL path. URL must be /mcp/{${urlParamName}}` },
          id: null,
        });
      }

      console.log(`[MCP] Request received with ${urlParamName}: ${urlParamValue}`);

      const mcpServer = new McpServer({ name: serverName, version: serverVersion });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        transport.close();
        mcpServer.close();
      });

      // Pass URL param value to register callback so tools can use it
      await Promise.resolve(register(mcpServer, urlParamValue));
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  const methodNotAllowed = (req: Request, res: Response) => {
    console.log(`Received ${req.method} MCP request`);
    res.writeHead(405).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));
  };
  app.get("/mcp", methodNotAllowed);
  app.get(`/mcp/:${urlParamName}`, methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);
  app.delete(`/mcp/:${urlParamName}`, methodNotAllowed);

  const server = app.listen(port, (error?: unknown) => {
    if (error) {
      console.error("Failed to start server:", error);
      process.exit(1);
    }
    console.log(`MCP Stateless Streamable HTTP Server "${serverName}" listening on port ${port}`);
    console.log(`[MCP] Endpoint: POST http://localhost:${port}/mcp/{${urlParamName}}`);
    console.log(`[MCP] '${urlParamName}' is required in the URL path and cannot be omitted`);
  });

  return { app, server };
}

export default createMcpHttpServer;

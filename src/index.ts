import express, { Request, Response, NextFunction } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export type RegisterHooks = (server: McpServer) => void | Promise<void>;

export interface CreateMcpHttpServerOptions {
  serverName: string;
  serverVersion: string;
  port?: number;
  bodyLimitMb?: number; // default 15
  enableCors?: boolean; // default true
  register: RegisterHooks; // register tools/resources/prompts
}

export function createMcpHttpServer(options: CreateMcpHttpServerOptions) {
  const {
    serverName,
    serverVersion,
    port = 3000,
    bodyLimitMb = 15,
    enableCors = true,
    register,
  } = options;

  const app = express();

  app.use(express.json({ limit: `${bodyLimitMb}mb` }));
  app.use(express.urlencoded({ limit: `${bodyLimitMb}mb`, extended: true }));

  // Payload too large → MCP error object
  app.use((error: any, _req: Request, res: Response, next: NextFunction) => {
    if (error instanceof Error && error.message.includes("request entity too large")) {
      return res.status(413).json({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: `Request payload too large. Maximum allowed size is ${bodyLimitMb}MB. Please reduce attachment sizes or number of files.`,
        },
        id: null,
      });
    }
    next(error);
  });

  if (enableCors) {
    app.use((req, res, next) => {
      res.header("Access-Control-Allow-Origin", "*");
      res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.header(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, Accept, MCP-Session-Id",
      );
      if (req.method === "OPTIONS") {
        res.sendStatus(200);
      } else {
        next();
      }
    });
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
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // Non-POST are blocked in stateless mode
  const methodNotAllowed = (req: Request, res: Response) => {
    console.log(`Received ${req.method} MCP request`);
    res.writeHead(405).end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed." },
        id: null,
      }),
    );
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  const server = app.listen(port, (error?: unknown) => {
    if (error) {
      console.error("Failed to start server:", error);
      process.exit(1);
    }
    console.log(`MCP Stateless Streamable HTTP Server listening on port ${port}`);
  });

  return { app, server };
}

export default createMcpHttpServer;



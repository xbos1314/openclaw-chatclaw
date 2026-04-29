import type http from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";

import { chatclawPlugin } from "./src/channel.js";
import { registerChatClawMemoTools } from "./src/memo/tools.js";
import { registerChatClawMiniprogramTools } from "./src/miniprogram/tools.js";
import { registerChatClawDocumentTools } from "./src/document/tools.js";
import { assertHostCompatibility } from "./src/compat.js";
import { ChatClawConfigSchema } from "./src/config/config-schema.js";
import { setChatClawRuntime } from "./src/runtime.js";
import { startChatClawWsServer, stopChatClawWsServer, wss, wssClosed } from "./src/websocket/server.js";
import { startHttpServer, stopHttpServer } from "./src/http/server.js";
import { logger } from "./src/util/logger.js";

let httpServer: http.Server | null = null;

export default {
  id: "openclaw-chatclaw",
  name: "ChatClaw",
  description: "ChatClaw channel (WebSocket + HTTP API)",
  configSchema: buildChannelConfigSchema(ChatClawConfigSchema),
  register(api: OpenClawPluginApi) {
    // Fail-fast: reject incompatible host versions
    assertHostCompatibility(api.runtime?.version);

    if (api.runtime) {
      setChatClawRuntime(api.runtime);
    }

    api.registerChannel({ plugin: chatclawPlugin });

    // Register ChatClaw memo tools
    registerChatClawMemoTools(api);

    // Register ChatClaw miniprogram tools
    registerChatClawMiniprogramTools(api);

    // Register ChatClaw document tools
    registerChatClawDocumentTools(api);

    // registrationMode exists in 2026.3.22+; skip heavy operations in setup-only mode
    const mode = (api as { registrationMode?: string }).registrationMode;
    if (mode && mode !== "full") return;

    // Get configuration
    const config = (api as { config?: { port?: number; maxConnections?: number; heartbeatInterval?: number } }).config ?? {};
    const port = config.port ?? 9788;
    const maxConnections = config.maxConnections ?? 100;
    const heartbeatInterval = config.heartbeatInterval ?? 30000;

    // Check if already running (prevent multiple instances)
    if (wss && !wssClosed) {
      logger.info(`ChatClaw WebSocket server already running on port ${port}`);
      return;
    }

    // Start single HTTP server first, then attach WebSocket upgrade handling on /ws
    logger.info(`Starting ChatClaw HTTP server on port ${port}...`);
    startHttpServer({
      port,
      log: api.runtime?.log,
    }).then((server) => {
      httpServer = server;
      logger.info(`ChatClaw HTTP server started on port ${port}`);
      return startChatClawWsServer({
        server,
        maxConnections,
        heartbeatInterval,
        path: "/ws",
        log: api.runtime?.log,
      });
    }).then(() => {
      logger.info(`ChatClaw WebSocket server attached on port ${port} path /ws`);
    }).catch((err) => {
      logger.error(`Failed to start ChatClaw servers: ${err}`);
    });

    // Register shutdown handlers
    const shutdown = async () => {
      logger.info("Shutting down ChatClaw servers...");
      await stopChatClawWsServer();
      if (httpServer) {
        await new Promise<void>((resolve) => {
          httpServer!.close(() => resolve());
        });
        httpServer = null;
      }
      logger.info("ChatClaw servers stopped");
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  },
};

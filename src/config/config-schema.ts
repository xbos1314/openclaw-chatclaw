import { z } from "zod";

export const ChatClawConfigSchema = z.object({
  port: z.number().default(9788).describe("Shared HTTP/WebSocket server port"),
  maxConnections: z.number().default(100).describe("Maximum concurrent connections"),
  heartbeatInterval: z.number().default(30000).describe("Heartbeat interval in milliseconds"),
});

export type ChatClawConfig = z.infer<typeof ChatClawConfigSchema>;

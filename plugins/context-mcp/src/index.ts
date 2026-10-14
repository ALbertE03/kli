/**
 * @kli/context-mcp — MCP server bridge
 */
import type { HarnessPlugin, Capability, Registry } from "@kli/api";

const capabilities: Capability[] = ["net.http"];

export const plugin: HarnessPlugin = {
  manifest: {
    id: "kli.context.mcp",
    version: "1.0.0",
    apiVersion: "1",
    kind: ["context"] as Array<"tool" | "provider" | "context" | "policy">,
    entrypoint: "./dist/index.js",
    capabilities,
    priority: 5,
  },
  register(registry) {
    // Load MCP config and register servers
    const config = loadMcpConfig(registry);
    for (const [name, server] of Object.entries(config.servers ?? {})) {
      // In production, spawn MCP server and bridge tools
      registry.registerMcpServer(name, []);
    }
  },
};

export default plugin;

interface McpConfig {
  servers?: Record<string, {
    transport?: { type: string; command: string; args?: string[] };
    toolPrefix?: string;
  }>;
}

function loadMcpConfig(registry: Registry): McpConfig {
  // Placeholder — in production, this would spawn real MCP servers
  // using @modelcontextprotocol/sdk
  return { servers: {} };
}
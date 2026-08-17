import { AcpDriver } from "./drivers/acp.ts";
import { ClaudeAgentSdkDriver } from "./drivers/claude-agent-sdk.ts";
import { CodexAppServerDriver } from "./drivers/codex-app-server.ts";
import type { AgentDriver, AgentSourceConfig } from "./types.ts";

export function createAgentDriver(
  config: AgentSourceConfig,
): AgentDriver {
  switch (config.driver) {
    case "claude-agent-sdk":
      return new ClaudeAgentSdkDriver(config);
    case "codex-app-server":
      return new CodexAppServerDriver(config);
    case "acp":
      return new AcpDriver(config);
  }
}

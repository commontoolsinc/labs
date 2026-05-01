import type { BuiltinToolId } from "../contracts/tool-descriptor.ts";
import { bashTool } from "./bash.ts";
import { bashNoSandboxTool } from "./bash-no-sandbox.ts";
import { delegateTaskTool } from "./delegate-task.ts";
import { readFileTool } from "./read-file.ts";
import { readSkillResourceTool } from "./read-skill-resource.ts";
import { writeFileTool } from "./write-file.ts";
import type { HarnessToolDefinition } from "./types.ts";

export const BUILTIN_TOOLS = [
  bashTool,
  bashNoSandboxTool,
  readFileTool,
  readSkillResourceTool,
  writeFileTool,
  delegateTaskTool,
] as const;

export const BUILTIN_TOOL_REGISTRY = new Map<
  BuiltinToolId,
  HarnessToolDefinition
>(
  BUILTIN_TOOLS.map((tool) => [tool.descriptor.toolId, tool]),
);

export const getBuiltinTool = (
  toolId: BuiltinToolId,
): HarnessToolDefinition | undefined => BUILTIN_TOOL_REGISTRY.get(toolId);

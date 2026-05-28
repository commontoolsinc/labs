import type { BuiltinToolId } from "../contracts/tool-descriptor.ts";
import { bashTool } from "./bash.ts";
import { bashNoSandboxTool } from "./bash-no-sandbox.ts";
import { delegateTaskTool } from "./delegate-task.ts";
import { editFileTool } from "./edit-file.ts";
import { readFileTool } from "./read-file.ts";
import { readSkillResourceTool } from "./read-skill-resource.ts";
import { runSkillScriptTool } from "./run-skill-script.ts";
import { webFetchTool } from "./web-fetch.ts";
import { viewImageTool } from "./view-image.ts";
import { writeFileTool } from "./write-file.ts";
import type { HarnessToolDefinition } from "./types.ts";

export const BUILTIN_TOOLS = [
  bashTool,
  bashNoSandboxTool,
  readFileTool,
  viewImageTool,
  webFetchTool,
  readSkillResourceTool,
  runSkillScriptTool,
  editFileTool,
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

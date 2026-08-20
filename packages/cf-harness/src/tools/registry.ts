import type { BuiltinToolId } from "../contracts/tool-descriptor.ts";
import { assignSlugTool } from "./assign-slug.ts";
import { bashTool } from "./bash.ts";
import { bashNoSandboxTool } from "./bash-no-sandbox.ts";
import { delegateTaskTool } from "./delegate-task.ts";
import { describeHandleTool } from "./describe-handle.ts";
import { editFileTool } from "./edit-file.ts";
import { readFileTool } from "./read-file.ts";
import { readSkillResourceTool } from "./read-skill-resource.ts";
import { runPatternTool } from "./run-pattern.ts";
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
  runPatternTool,
  assignSlugTool,
  describeHandleTool,
] as const;

export const BUILTIN_TOOL_REGISTRY = new Map<
  BuiltinToolId,
  HarnessToolDefinition
>(
  BUILTIN_TOOLS.map((tool) => [tool.descriptor.toolId, tool]),
);

/**
 * The builtin tool registered under `toolId`, or `undefined` when no tool
 * answers to that name. Takes any string: a name a model wrote is a candidate
 * id until this lookup says otherwise, and the registry is the only authority
 * on which names are builtin tool ids.
 */
export const getBuiltinTool = (
  toolId: string,
): HarnessToolDefinition | undefined =>
  BUILTIN_TOOL_REGISTRY.get(toolId as BuiltinToolId);

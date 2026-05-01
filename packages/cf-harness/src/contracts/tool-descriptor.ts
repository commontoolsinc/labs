import type { JSONSchema } from "@commonfabric/api";

export type BuiltinToolId =
  | "bash"
  | "bash-no-sandbox"
  | "read_file"
  | "read_skill_resource"
  | "write_file"
  | "delegate_task";

export const DEFAULT_PARENT_TOOL_IDS = [
  "bash",
  "read_file",
  "read_skill_resource",
  "write_file",
  "delegate_task",
] as const satisfies readonly BuiltinToolId[];

export type HarnessToolEffectClass = "read" | "write" | "side-effect";

export interface HarnessToolDescriptor {
  toolId: BuiltinToolId;
  title: string;
  description: string;
  effectClass: HarnessToolEffectClass;
  inputSchema: JSONSchema;
  outputSchema?: JSONSchema;
  tags?: readonly string[];
}

import type { JSONSchema } from "@commonfabric/api";

export type BuiltinToolId = "bash" | "read_file" | "write_file";

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

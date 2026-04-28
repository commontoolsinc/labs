import { assert, assertEquals } from "@std/assert";
import {
  BUILTIN_TOOL_REGISTRY,
  BUILTIN_TOOLS,
  getBuiltinTool,
} from "../src/tools/registry.ts";
import { WRITE_FILE_MODES } from "../src/tools/write-file.ts";

Deno.test("builtin tool registry includes the agreed first-pass tool floor", () => {
  assertEquals(BUILTIN_TOOLS.map((tool) => tool.descriptor.toolId), [
    "bash",
    "read_file",
    "write_file",
    "delegate_task",
  ]);
  assertEquals(BUILTIN_TOOL_REGISTRY.size, 4);
});

Deno.test("builtin tool registry exposes invoke functions for all built-ins", () => {
  for (const tool of BUILTIN_TOOLS) {
    assertEquals(typeof tool.invoke, "function");
  }
});

Deno.test("write_file descriptor includes append support", () => {
  const writeFileTool = getBuiltinTool("write_file");
  assert(writeFileTool);
  assertEquals(WRITE_FILE_MODES, ["replace", "append"]);
  assertEquals(writeFileTool.descriptor.effectClass, "write");
  assertEquals(
    (writeFileTool.descriptor.inputSchema as {
      properties: { mode: { enum: string[] } };
    }).properties.mode.enum,
    ["replace", "append"],
  );
});

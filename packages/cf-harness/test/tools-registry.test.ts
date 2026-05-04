import { assert, assertEquals } from "@std/assert";
import {
  type BuiltinToolId,
  DEFAULT_PARENT_TOOL_IDS,
} from "../src/contracts/tool-descriptor.ts";
import {
  BUILTIN_TOOL_REGISTRY,
  BUILTIN_TOOLS,
  getBuiltinTool,
} from "../src/tools/registry.ts";
import { WRITE_FILE_MODES } from "../src/tools/write-file.ts";

Deno.test("builtin tool registry includes the agreed first-pass tool floor", () => {
  assertEquals(BUILTIN_TOOLS.map((tool) => tool.descriptor.toolId), [
    "bash",
    "bash-no-sandbox",
    "read_file",
    "read_skill_resource",
    "write_file",
    "delegate_task",
  ]);
  assertEquals(BUILTIN_TOOL_REGISTRY.size, 6);
  assertEquals(
    [...DEFAULT_PARENT_TOOL_IDS],
    [
      "bash",
      "read_file",
      "read_skill_resource",
      "write_file",
      "delegate_task",
    ] satisfies BuiltinToolId[],
  );
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

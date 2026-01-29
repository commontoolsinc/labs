import { assertEquals, assertExists } from "@std/assert";
import {
  classifyFrame,
  classifyStack,
  createErrorMapper,
  createErrorReport,
  filterFrames,
  formatError,
  formatFrames,
  mapError,
} from "../../src/sandbox/mod.ts";

Deno.test("classifyFrame - pattern frames", async (t) => {
  await t.step("classifies pattern code", () => {
    const frame = classifyFrame(
      "    at myFunction (pattern.ts:10:5)",
    );
    assertEquals(frame.type, "pattern");
    assertEquals(frame.functionName, "myFunction");
    assertEquals(frame.file, "pattern.ts");
    assertEquals(frame.line, 10);
    assertEquals(frame.column, 5);
  });

  await t.step("classifies anonymous function in pattern", () => {
    const frame = classifyFrame(
      "    at (pattern.ts:20:10)",
    );
    assertEquals(frame.type, "pattern");
    assertEquals(frame.file, "pattern.ts");
    assertEquals(frame.line, 20);
  });
});

Deno.test("classifyFrame - runtime frames", async (t) => {
  await t.step("classifies runner internal frames", () => {
    const frame = classifyFrame(
      "    at instantiateNode (/runner/src/runner.ts:100:5)",
    );
    assertEquals(frame.type, "runtime");
  });

  await t.step("classifies harness frames", () => {
    const frame = classifyFrame(
      "    at Engine.exec (/harness/engine.ts:50:10)",
    );
    assertEquals(frame.type, "runtime");
  });

  await t.step("classifies AMDLoader frames", () => {
    const frame = classifyFrame(
      "    at AMDLoader.require (recipe-abc.js:1:923)",
    );
    assertEquals(frame.type, "runtime");
  });

  await t.step("classifies CT_INTERNAL frames", () => {
    const frame = classifyFrame("    at <CT_INTERNAL>");
    assertEquals(frame.type, "runtime");
  });
});

Deno.test("classifyFrame - SES frames", async (t) => {
  await t.step("classifies ses module frames", () => {
    const frame = classifyFrame(
      "    at lockdown (/node_modules/ses/lockdown.js:10:5)",
    );
    assertEquals(frame.type, "ses");
  });

  await t.step("classifies Compartment frames", () => {
    const frame = classifyFrame(
      "    at Compartment.evaluate (ses:compartment:50:10)",
    );
    assertEquals(frame.type, "ses");
  });
});

Deno.test("classifyFrame - external frames", async (t) => {
  await t.step("classifies node_modules frames", () => {
    const frame = classifyFrame(
      "    at lodash (/node_modules/lodash/index.js:100:5)",
    );
    assertEquals(frame.type, "external");
  });

  await t.step("classifies esm.sh frames", () => {
    const frame = classifyFrame(
      "    at parse (https://esm.sh/zod@3.0.0/index.js:50:10)",
    );
    assertEquals(frame.type, "external");
  });

  await t.step("classifies npm: frames", () => {
    const frame = classifyFrame(
      "    at validate (npm:zod@3.0.0/index.js:50:10)",
    );
    assertEquals(frame.type, "external");
  });
});

Deno.test("classifyStack - full stack trace", async (t) => {
  await t.step("classifies multiple frames", () => {
    const stack = `Error: Test error
    at myHandler (pattern.ts:10:5)
    at eval (recipe-abc.js:4:52)
    at AMDLoader.resolveModule (recipe-abc.js:1:1764)
    at Engine.exec (/harness/engine.ts:50:10)`;

    const frames = classifyStack(stack);
    assertEquals(frames.length, 4);
    assertEquals(frames[0].type, "pattern");
    assertEquals(frames[1].type, "runtime"); // eval frame
    assertEquals(frames[2].type, "runtime"); // AMDLoader
    assertEquals(frames[3].type, "runtime"); // harness
  });
});

Deno.test("filterFrames - non-debug mode", async (t) => {
  await t.step("filters out runtime frames after pattern frames", () => {
    const stack = `Error: Test
    at Engine.invoke (/runner/src/runner.ts:100:5)
    at myHandler (pattern.ts:10:5)
    at Engine.run (/runner/src/runner.ts:200:10)`;

    const frames = classifyStack(stack);
    const filtered = filterFrames(frames, false);

    // Should include runtime frame before pattern, and pattern frame
    assertEquals(filtered.length, 2);
    assertEquals(filtered[0].type, "runtime");
    assertEquals(filtered[1].type, "pattern");
  });

  await t.step("includes external frames", () => {
    const stack = `Error: Test
    at myHandler (pattern.ts:10:5)
    at validate (https://esm.sh/zod@3.0.0/index.js:50:10)`;

    const frames = classifyStack(stack);
    const filtered = filterFrames(frames, false);

    assertEquals(filtered.length, 2);
    assertEquals(filtered[0].type, "pattern");
    assertEquals(filtered[1].type, "external");
  });
});

Deno.test("filterFrames - debug mode", async (t) => {
  await t.step("includes all frames in debug mode", () => {
    const stack = `Error: Test
    at myHandler (pattern.ts:10:5)
    at Engine.run (/runner/src/runner.ts:200:10)
    at Compartment.evaluate (ses:50:10)`;

    const frames = classifyStack(stack);
    const filtered = filterFrames(frames, true);

    assertEquals(filtered.length, 3);
  });
});

Deno.test("formatFrames", async (t) => {
  await t.step("formats frames as string", () => {
    const stack = `Error: Test
    at myHandler (pattern.ts:10:5)`;

    const frames = classifyStack(stack);
    const formatted = formatFrames(frames);

    assertEquals(formatted, "    at myHandler (pattern.ts:10:5)");
  });

  await t.step("includes type annotations in verbose mode", () => {
    const stack = `Error: Test
    at myHandler (pattern.ts:10:5)`;

    const frames = classifyStack(stack);
    const formatted = formatFrames(frames, true);

    assertEquals(formatted, "    at myHandler (pattern.ts:10:5) [pattern]");
  });
});

Deno.test("ErrorMapper", async (t) => {
  await t.step("maps error and classifies frames", () => {
    const mapper = createErrorMapper(false);
    const error = new Error("Test error");
    error.stack = `Error: Test error
    at myHandler (pattern.ts:10:5)
    at Engine.run (/runner/src/runner.ts:200:10)`;

    const mapped = mapper.mapError(error, { patternId: "test-pattern" });

    assertExists(mapped.originalError);
    assertExists(mapped.mappedStack);
    assertExists(mapped.frames);
    assertExists(mapped.userMessage);
    assertEquals(mapped.userMessage.includes("test-pattern"), true);
  });
});

Deno.test("mapError - quick helper", async (t) => {
  await t.step("maps error without persistent mapper", () => {
    const error = new Error("Quick test");
    error.stack = `Error: Quick test
    at handler (pattern.ts:5:10)`;

    const mapped = mapError(error, { patternId: "quick-pattern" });

    assertEquals(mapped.originalError, error);
    assertEquals(mapped.userMessage.includes("quick-pattern"), true);
  });
});

Deno.test("formatError", async (t) => {
  await t.step("formats mapped error", () => {
    const error = new Error("Format test");
    error.stack = `Error: Format test
    at handler (pattern.ts:5:10)`;

    const mapped = mapError(error);
    const formatted = formatError(mapped);

    assertEquals(formatted.includes("Error: Format test"), true);
    assertEquals(formatted.includes("pattern.ts:5:10"), true);
  });
});

Deno.test("createErrorReport", async (t) => {
  await t.step("creates structured report", () => {
    const error = new Error("Report test");
    // Runtime frame before pattern frame (gets included)
    // Pattern frame (gets included)
    error.stack = `Error: Report test
    at Engine.invoke (/runner/src/runner.ts:100:5)
    at handler (pattern.ts:5:10)`;

    const mapped = mapError(error);
    const report = createErrorReport(mapped, "report-pattern");

    assertEquals(report.message, "Report test");
    assertEquals(report.name, "Error");
    assertEquals(report.patternId, "report-pattern");
    // In non-debug mode, runtime frames after pattern frames are filtered
    // So we get: 1 runtime (before pattern) + 1 pattern = 2 frames
    assertEquals(report.frameSummary.total, 2);
    assertEquals(report.frameSummary.pattern, 1);
    assertEquals(report.frameSummary.runtime, 1);
  });

  await t.step("includes all frames in debug mode", () => {
    const error = new Error("Debug report test");
    error.stack = `Error: Debug report test
    at handler (pattern.ts:5:10)
    at Engine.run (/runner/src/runner.ts:200:10)`;

    const mapped = mapError(error, { debug: true });
    const report = createErrorReport(mapped, "debug-pattern");

    assertEquals(report.message, "Debug report test");
    assertEquals(report.frameSummary.total, 2);
    assertEquals(report.frameSummary.pattern, 1);
    assertEquals(report.frameSummary.runtime, 1);
  });
});

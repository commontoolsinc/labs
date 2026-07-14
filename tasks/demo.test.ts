import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { parseDemoArgs, resolveDemoTest } from "./demo.ts";

Deno.test("parseDemoArgs accepts deterministic demo options", () => {
  assertEquals(
    parseDemoArgs([
      "patterns",
      "lunch-poll-vote",
      "--keep-frames",
      "--output=tmp/lunch.mp4",
      "--viewport=960x720",
      "--port-offset=500",
    ]),
    {
      packageName: "patterns",
      filter: "lunch-poll-vote",
      keepFrames: true,
      outputPath: "tmp/lunch.mp4",
      viewport: "960x720",
      portOffset: 500,
    },
  );
});

Deno.test("parseDemoArgs rejects non-browser packages", () => {
  assertThrows(
    () => parseDemoArgs(["runner", "counter"]),
    Error,
    "unsupported browser-test package",
  );
});

Deno.test("resolveDemoTest requires exactly one file", async () => {
  const root = await Deno.makeTempDir();
  try {
    const dir = `${root}/packages/patterns/integration`;
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(`${dir}/one-demo.test.ts`, "");
    await Deno.writeTextFile(`${dir}/two-demo.test.ts`, "");
    const base = parseDemoArgs(["patterns", "one-demo"]);
    assertEquals(await resolveDemoTest(root, base), "one-demo.test.ts");
    await assertRejects(
      () => resolveDemoTest(root, { ...base, filter: "demo" }),
      Error,
      "ambiguous",
    );
    await assertRejects(
      () => resolveDemoTest(root, { ...base, filter: "missing" }),
      Error,
      "no patterns integration test",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

import { assert, assertEquals } from "@std/assert";
import { createMemoryWsDeflateStatsRecorder } from "./memory-ws-deflate-stats.ts";

Deno.test("deflate stats recorder flushes once and classifies browsers", async () => {
  const statsFile = await Deno.makeTempFile({ suffix: ".jsonl" });
  Deno.env.set("CF_MEMORY_WS_DEFLATE_STATS_FILE", statsFile);
  try {
    const recorder = createMemoryWsDeflateStatsRecorder(
      "Mozilla/5.0 (X11; Linux x86_64)",
      true,
    );
    assert(recorder !== undefined);
    recorder!.recordInbound(50, 100, true, 0.5);
    recorder!.recordOutbound(80, 80, false);
    recorder!.flush();
    // A second flush (close and error events can both fire) must not append
    // a duplicate line.
    recorder!.flush();

    const lines = (await Deno.readTextFile(statsFile)).trim().split("\n");
    assertEquals(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assertEquals(record.kind, "browser");
    assertEquals(record.negotiated, true);
    assertEquals(record.inbound.compressedFrames, 1);
    assertEquals(record.outbound.compressedFrames, 0);
    assertEquals(record.cpuMs, 0.5);
  } finally {
    Deno.env.delete("CF_MEMORY_WS_DEFLATE_STATS_FILE");
    await Deno.remove(statsFile).catch(() => {});
  }
});

Deno.test("deflate stats recorder swallows write failures on flush", () => {
  Deno.env.set(
    "CF_MEMORY_WS_DEFLATE_STATS_FILE",
    "/nonexistent-dir/never/stats.jsonl",
  );
  try {
    const recorder = createMemoryWsDeflateStatsRecorder(undefined, false);
    assert(recorder !== undefined);
    recorder!.recordOutbound(10, 10, false);
    // The append target is unwritable: flush must not throw — diagnostics
    // never disturb the connection.
    recorder!.flush();
  } finally {
    Deno.env.delete("CF_MEMORY_WS_DEFLATE_STATS_FILE");
  }
});

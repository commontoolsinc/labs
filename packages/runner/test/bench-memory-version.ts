import type { MemoryVersion } from "../src/storage/interface.ts";

export const BENCH_MEMORY_VERSION: MemoryVersion =
  Deno.env.get("BENCH_MEMORY_VERSION") === "v1" ? "v1" : "v2";

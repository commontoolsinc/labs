/**
 * Diagnostic: per-connection byte accounting for the memory websocket
 * deflate transport. When `CF_MEMORY_WS_DEFLATE_STATS_FILE` names a file,
 * every memory websocket connection appends one JSON line on close with its
 * logical (uncompressed text) versus wire (post-compression) byte totals per
 * direction, frame counts, and compression CPU time. Payload contents are
 * never recorded. With the env var unset this module is inert.
 */

export interface MemoryWsDeflateStatsRecorder {
  recordInbound(
    wireBytes: number,
    logicalBytes: number,
    compressed: boolean,
    cpuMs?: number,
  ): void;
  recordOutbound(
    wireBytes: number,
    logicalBytes: number,
    compressed: boolean,
    cpuMs?: number,
  ): void;
  flush(): void;
}

const statsFile = (): string | undefined => {
  const value = Deno.env.get("CF_MEMORY_WS_DEFLATE_STATS_FILE");
  return value === undefined || value === "" ? undefined : value;
};

const connectionKind = (userAgent: string | undefined): string =>
  userAgent !== undefined && userAgent.includes("Mozilla")
    ? "browser"
    : "runtime";

let connectionSeq = 0;

export const createMemoryWsDeflateStatsRecorder = (
  userAgent: string | undefined,
  negotiated: boolean,
): MemoryWsDeflateStatsRecorder | undefined => {
  const file = statsFile();
  if (file === undefined) return undefined;

  const connectionId = ++connectionSeq;
  const totals = {
    inbound: { wireBytes: 0, logicalBytes: 0, frames: 0, compressedFrames: 0 },
    outbound: { wireBytes: 0, logicalBytes: 0, frames: 0, compressedFrames: 0 },
  };
  let cpuMs = 0;
  let flushed = false;

  const record = (
    direction: "inbound" | "outbound",
    wireBytes: number,
    logicalBytes: number,
    compressed: boolean,
    frameCpuMs?: number,
  ) => {
    const bucket = totals[direction];
    bucket.wireBytes += wireBytes;
    bucket.logicalBytes += logicalBytes;
    bucket.frames += 1;
    if (compressed) bucket.compressedFrames += 1;
    if (frameCpuMs !== undefined) cpuMs += frameCpuMs;
  };

  return {
    recordInbound: (wireBytes, logicalBytes, compressed, frameCpuMs) =>
      record("inbound", wireBytes, logicalBytes, compressed, frameCpuMs),
    recordOutbound: (wireBytes, logicalBytes, compressed, frameCpuMs) =>
      record("outbound", wireBytes, logicalBytes, compressed, frameCpuMs),
    flush: () => {
      if (flushed) return;
      flushed = true;
      try {
        Deno.writeTextFileSync(
          file,
          JSON.stringify({
            connectionId,
            kind: connectionKind(userAgent),
            negotiated,
            cpuMs: Math.round(cpuMs * 1000) / 1000,
            ...totals,
          }) + "\n",
          { append: true },
        );
      } catch {
        // Diagnostics never disturb the connection.
      }
    },
  };
};

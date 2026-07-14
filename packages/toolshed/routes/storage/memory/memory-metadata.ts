import type { MemoryWireConnectionMetadata } from "@commonfabric/memory/v2/wire-accounting";

export const memoryWireConnectionMetadataFromHeaders = (
  headers: Headers,
): MemoryWireConnectionMetadata => {
  const userAgent = headers.get("user-agent") ?? undefined;
  const origin = headers.get("origin") ?? undefined;
  const metadata: MemoryWireConnectionMetadata = {
    kind: userAgent?.includes("Mozilla") ? "browser" : "runtime",
  };
  if (userAgent !== undefined) metadata.userAgent = userAgent;
  if (origin !== undefined) metadata.origin = origin;
  return metadata;
};

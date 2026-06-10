import { MEMORY_PROTOCOL } from "@commonfabric/memory/v2";
import * as MemoryServer from "@commonfabric/memory/v2/server";
import { hashOf } from "@commonfabric/data-model/value-hash";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import * as FS from "@std/fs";
import * as Path from "@std/path";
import env from "@/env.ts";
import { resolveMemoryEngineStoreRootUrl } from "./memory-path.ts";
import { fromDID } from "../../../memory/util.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const authorizationError = (message: string): Error =>
  Object.assign(new Error(message), { name: "AuthorizationError" });

const sameSessionDescriptor = (
  left: Record<string, unknown>,
  right: { sessionId?: string; seenSeq?: number },
): boolean =>
  (typeof left.sessionId === "string" ? left.sessionId : undefined) ===
    right.sessionId &&
  (typeof left.seenSeq === "number" ? left.seenSeq : undefined) ===
    right.seenSeq;

const authorizeSessionOpen = async (
  message: {
    space: string;
    session: { sessionId?: string; seenSeq?: number };
    invocation?: Record<string, unknown>;
    authorization?: unknown;
  },
): Promise<string> => {
  // The session signature travels as a `FabricBytes` (emitted by the client in
  // `v2-remote-session.ts`), which decodes to one here. A non-null `signature`
  // implies a well-formed `authorization`, so it needn't be checked separately.
  const rawSignature = isRecord(message.authorization)
    ? message.authorization.signature
    : undefined;
  const signature = rawSignature instanceof FabricBytes
    ? rawSignature.slice()
    : null;
  if (!isRecord(message.invocation) || signature === null) {
    throw authorizationError("memory session.open requires authorization");
  }

  const invocation = message.invocation;
  if (
    typeof invocation.iss !== "string" ||
    invocation.cmd !== "session.open" ||
    invocation.sub !== message.space ||
    !isRecord(invocation.args) ||
    invocation.args.protocol !== MEMORY_PROTOCOL ||
    !isRecord(invocation.args.session) ||
    !sameSessionDescriptor(invocation.args.session, message.session)
  ) {
    throw authorizationError("memory session.open authorization mismatch");
  }

  const issuer = await fromDID(invocation.iss);
  if (issuer.error) {
    throw issuer.error;
  }

  const verified = await issuer.ok.verify({
    payload: hashOf(invocation).bytes,
    signature,
  });
  if (verified.error) {
    throw verified.error;
  }

  return invocation.iss;
};

// Determine store URL: DB_PATH (single-file mode) or MEMORY_DIR (directory mode)
let storeUrl: URL;

if (env.DB_PATH) {
  // Single file mode: use explicit database file (must be absolute path)
  storeUrl = Path.toFileUrl(env.DB_PATH);
  console.log(`Memory: Using single database file: ${env.DB_PATH}`);
} else {
  // Directory mode: use MEMORY_DIR (existing behavior)
  storeUrl = new URL(env.MEMORY_DIR);
  console.log(`Memory: Using directory mode: ${env.MEMORY_DIR}`);
}

const memoryEngineStoreUrl = resolveMemoryEngineStoreRootUrl(storeUrl, {
  singleFileMode: Boolean(env.DB_PATH),
});
await FS.ensureDir(memoryEngineStoreUrl);

export const memoryServer = new MemoryServer.Server({
  store: memoryEngineStoreUrl,
  authorizeSessionOpen,
});
export const memory = {
  async close(): Promise<
    { ok: Record<PropertyKey, never> } | { error: unknown }
  > {
    await memoryServer.close();
    return { ok: {} };
  },
};
console.log("Memory: Provider initialized successfully");

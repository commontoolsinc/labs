import * as Memory from "@commonfabric/memory";
import { MEMORY_V2_PROTOCOL } from "@commonfabric/memory/v2";
import { hashOf } from "@commonfabric/data-model/value-hash";
import * as FS from "@std/fs";
import * as Path from "@std/path";
import env from "@/env.ts";
import { identity } from "@/lib/identity.ts";
import { resolveMemoryEngineStoreRootUrl } from "./memory-path.ts";
import { fromDID } from "../../../memory/util.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const authorizationError = (message: string): Error =>
  Object.assign(new Error(message), { name: "AuthorizationError" });

const toByteArray = (value: unknown): Uint8Array | null => {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (Array.isArray(value) && value.every((item) => Number.isInteger(item))) {
    return Uint8Array.from(value);
  }
  if (!isRecord(value)) {
    return null;
  }

  const entries = Object.entries(value)
    .map(([key, item]) => [Number(key), item] as const)
    .filter(([index, item]) =>
      Number.isInteger(index) && index >= 0 && Number.isInteger(item)
    )
    .toSorted(([left], [right]) => left - right);

  if (
    entries.length === 0 ||
    entries.some(([index], position) => index !== position)
  ) {
    return null;
  }

  return Uint8Array.from(entries.map(([, item]) => item as number));
};

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
  const signature = toByteArray(
    isRecord(message.authorization)
      ? message.authorization.signature
      : undefined,
  );
  if (
    !isRecord(message.invocation) ||
    !isRecord(message.authorization) ||
    signature === null
  ) {
    throw authorizationError("memory/v2 session.open requires authorization");
  }

  const invocation = message.invocation;
  if (
    typeof invocation.iss !== "string" ||
    invocation.iss !== message.space ||
    invocation.cmd !== "session.open" ||
    invocation.sub !== message.space ||
    !isRecord(invocation.args) ||
    invocation.args.protocol !== MEMORY_V2_PROTOCOL ||
    !isRecord(invocation.args.session) ||
    !sameSessionDescriptor(invocation.args.session, message.session)
  ) {
    throw authorizationError("memory/v2 session.open authorization mismatch");
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

// Initialize memory provider using top-level await
console.log("Memory: Initializing provider...");
const result = await Memory.Provider.open({
  store: storeUrl,
  serviceDid: identity.did(),
  memoryVersion: "v1",
});

if (result.error) {
  throw result.error;
}

const memoryEngineStoreUrl = resolveMemoryEngineStoreRootUrl(storeUrl, {
  singleFileMode: Boolean(env.DB_PATH),
});
await FS.ensureDir(memoryEngineStoreUrl);

export const memory = result.ok;
export const memoryV2Server = new Memory.V2Server.Server({
  store: memoryEngineStoreUrl,
  authorizeSessionOpen,
});
console.log("Memory: Provider initialized successfully");

export { Memory };

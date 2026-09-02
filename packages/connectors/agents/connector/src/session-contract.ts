// deno-lint-ignore no-control-regex -- identity parts explicitly reject ASCII controls.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

function requiredIdentityPart(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must not be empty`);
  if (CONTROL_CHARACTER.test(normalized)) {
    throw new Error(`${field} must not contain control characters`);
  }
  return normalized;
}

export function normalizeSourceId(sourceId: string): string {
  return requiredIdentityPart(sourceId, "sourceId").toLowerCase();
}

export function normalizeCommandId(commandId: string): string {
  return requiredIdentityPart(commandId, "commandId");
}

export function normalizeNativeSessionId(nativeSessionId: string): string {
  return requiredIdentityPart(nativeSessionId, "nativeSessionId");
}

export function sessionKey(sourceId: string, nativeSessionId: string): string {
  const source = normalizeSourceId(sourceId);
  const session = normalizeNativeSessionId(nativeSessionId);
  return `${encodeURIComponent(source)}/${encodeURIComponent(session)}`;
}

export function sessionCause(
  spaceDid: string,
  ownerDid: string,
  sourceId: string,
  nativeSessionId: string,
): Record<string, string | number> {
  return {
    spaceDid,
    ownerDid: requiredIdentityPart(ownerDid, "ownerDid"),
    agentConnector: "session",
    sourceId: normalizeSourceId(sourceId),
    nativeSessionId: normalizeNativeSessionId(nativeSessionId),
  };
}

export function sessionChunkCause(
  spaceDid: string,
  ownerDid: string,
  sourceId: string,
  nativeSessionId: string,
  part: number,
  contentHash: string,
): Record<string, string | number> {
  if (!Number.isSafeInteger(part) || part < 0) {
    throw new Error("part must be a non-negative safe integer");
  }
  return {
    ...sessionCause(spaceDid, ownerDid, sourceId, nativeSessionId),
    agentConnector: "session-chunk",
    part,
    contentHash: requiredIdentityPart(contentHash, "contentHash"),
  };
}

export function commandReceiptCause(
  spaceDid: string,
  ownerDid: string,
  commandId: string,
): Record<string, string | number> {
  return {
    spaceDid,
    ownerDid: requiredIdentityPart(ownerDid, "ownerDid"),
    agentConnector: "command-receipt",
    commandId: normalizeCommandId(commandId),
  };
}

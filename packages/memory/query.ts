import type { DID, MemorySpace, Meta, Query, Selector } from "./interface.ts";

export const create = <Space extends MemorySpace>({
  issuer,
  subject,
  select,
  since,
  meta,
}: {
  issuer: DID;
  subject: Space;
  select: Selector;
  since?: number;
  meta?: Meta;
}): Query<Space> => {
  const iat = (Date.now() / 1000) | 0;
  const exp = iat + 60 * 60; // expires in an hour
  return {
    cmd: "/memory/query",
    iss: issuer,
    sub: subject,
    args: since != null ? { select, since } : { select },
    ...(meta ? { meta } : undefined),
    prf: [],
    iat,
    exp,
  };
};

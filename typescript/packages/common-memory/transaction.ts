import type {
  Changes,
  DID,
  MemorySpace,
  Meta,
  Transaction,
} from "./interface.ts";
export const create = <Space extends MemorySpace>({
  issuer,
  subject,
  changes,
  meta,
}: {
  issuer: DID;
  subject: Space;
  changes: Changes;
  meta?: Meta;
}): Transaction<Space> => {
  const iat = (Date.now() / 1000) | 0;
  const exp = iat + 60 * 60; // expires in an hour
  return {
    cmd: "/memory/transact",
    iss: issuer,
    sub: subject,
    args: { changes },
    ...(meta ? { meta } : undefined),
    prf: [],
    iat,
    exp,
  };
};

import type { Principal, MemorySpace, Changes, Meta, Transaction } from "./interface.ts";
export const create = <Space extends MemorySpace>({
  issuer,
  subject,
  changes,
  meta,
}: {
  issuer: Principal;
  subject: Space;
  changes: Changes;
  meta?: Meta;
}): Transaction<Space> => ({
  cmd: "/memory/transact",
  iss: issuer,
  sub: subject,
  args: { changes },
  ...(meta ? { meta } : undefined),
});

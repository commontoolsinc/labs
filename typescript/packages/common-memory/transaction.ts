import type {
  ChangesBuilder,
  MemorySpace,
  Meta,
  Principal,
  Transaction,
} from "./interface.ts";
export const create = <Space extends MemorySpace>({
  issuer,
  subject,
  changes,
  meta,
}: {
  issuer: Principal;
  subject: Space;
  changes: ChangesBuilder;
  meta?: Meta;
}): Transaction<Space> => ({
  cmd: "/memory/transact",
  iss: issuer,
  sub: subject,
  args: { changes },
  ...(meta ? { meta } : undefined),
});

import type {
  MemorySpace,
  Meta,
  Principal,
  Query,
  Selector,
} from "./interface.ts";

export const create = <Space extends MemorySpace>({
  issuer,
  subject,
  select,
  since,
  meta,
}: {
  issuer: Principal;
  subject: Space;
  select: Selector;
  since?: number;
  meta?: Meta;
}): Query<Space> => ({
  cmd: "/memory/query",
  iss: issuer,
  sub: subject,
  args: since != null ? { select, since } : { select },
  ...(meta ? { meta } : undefined),
});

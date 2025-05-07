import type {
  Changes,
  Clock,
  DID,
  MemorySpace,
  Meta,
  Seconds,
  Transaction,
} from "./interface.ts";
import * as Settings from "./settings.ts";
export const create = <Space extends MemorySpace>({
  issuer,
  subject,
  changes,
  meta,
  clock = Settings.clock,
  ttl = Settings.ttl,
}: {
  issuer: DID;
  subject: Space;
  changes: Changes;
  meta?: Meta;
  clock?: Clock;
  ttl?: Seconds;
}): Transaction<Space> => {
  const iat = clock.now();
  return {
    cmd: "/memory/transact",
    iss: issuer,
    sub: subject,
    args: { changes },
    ...(meta ? { meta } : undefined),
    prf: [],
    iat,
    exp: iat + ttl,
  };
};

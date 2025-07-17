/// <cts-enable />
import { OpaqueRef, derive, h } from "commontools";
const count: OpaqueRef<number> = {} as any;
const element = <div>{derive(count, _v1 => _v1 + 1)}</div>;
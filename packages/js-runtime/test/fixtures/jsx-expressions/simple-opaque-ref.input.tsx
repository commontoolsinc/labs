import { OpaqueRef, derive, h } from "commontools";
const count: OpaqueRef<number> = {} as any;
const element = <div>{count + 1}</div>;
import { OpaqueRef } from "commontools";
const isActive: OpaqueRef<boolean> = {} as any;
const result = isActive ? "active" : "inactive";
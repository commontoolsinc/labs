/// <cts-enable />
import { OpaqueRef, derive } from "commontools";
const name: OpaqueRef<string> = {} as any;
const greeting = commontools_1.derive(name, _v1 => "Hello, " + _v1);
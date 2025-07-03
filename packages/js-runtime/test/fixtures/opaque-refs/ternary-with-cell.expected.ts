/// <cts-enable />
import { OpaqueRef, ifElse, cell } from "commontools";
const isActive = cell<boolean>(false);
const result = commontools_1.ifElse(isActive, "active", "inactive");
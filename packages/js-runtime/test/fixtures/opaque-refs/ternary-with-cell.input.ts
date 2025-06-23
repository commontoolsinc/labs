import { OpaqueRef, ifElse, cell } from "commontools";
const isActive = cell<boolean>(false);
const result = isActive ? "active" : "inactive";
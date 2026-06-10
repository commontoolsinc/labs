import { App } from "../shared/mod.ts";
import { type RuntimeClient } from "@commonfabric/runtime-client";
import { type DID } from "@commonfabric/identity";

declare global {
  var app: App;
  var commonfabric: {
    rt?: RuntimeClient;
    /**
     * The bound space of the active runtime. Page operations on `rt`
     * require an explicit space — console/debug callers pass this.
     */
    space?: DID;
    detectNonIdempotent?: (durationMs?: number) => Promise<unknown>;
    watchWrites?: (
      options?:
        | {
          space?: string;
          did?: string;
          id?: string;
          path?: string[];
          match?: "exact" | "prefix";
          label?: string;
        }
        | {
          space?: string;
          did?: string;
          id?: string;
          path?: string[];
          match?: "exact" | "prefix";
          label?: string;
        }[],
    ) => Promise<unknown>;
    getWriteStackTrace?: () => Promise<unknown>;
    explainTriggerTrace?: (options?: {
      limit?: number;
      rootOnly?: boolean;
      includeCurrentValue?: boolean;
    }) => Promise<unknown>;
    [key: string]: unknown;
  };
}

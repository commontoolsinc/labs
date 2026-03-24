import { App } from "../shared/mod.ts";
import { type RuntimeClient } from "@commonfabric/runtime-client";

declare global {
  var app: App;
  var commonfabric: {
    rt?: RuntimeClient;
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

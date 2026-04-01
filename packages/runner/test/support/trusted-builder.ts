import {
  createBuilder,
  type CreateBuilderOptions,
} from "../../src/builder/factory.ts";
import type { Runtime } from "../../src/runtime.ts";

export function createTrustedBuilder(
  runtime: Runtime,
  options: Omit<CreateBuilderOptions, "unsafeHostTrust"> = {},
) {
  return createBuilder({
    ...options,
    unsafeHostTrust: runtime.createUnsafeHostTrust({
      reason: "unit test fixture",
    }),
  });
}

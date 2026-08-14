import {
  Runtime as DefaultRuntime,
  type RuntimeOptions,
} from "../../src/runtime.ts";
import { LEGACY_CFC_OPTIONS } from "../cfc-test-options.ts";

/** Runtime for tests whose subject predates CFC enforcement. */
export class LegacyRuntime extends DefaultRuntime {
  constructor(options: RuntimeOptions) {
    super({ ...LEGACY_CFC_OPTIONS, ...options });
  }
}

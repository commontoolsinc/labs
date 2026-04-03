/**
 * Entry point for the cf-select component.
 * Re-exports the class and shared style string so that
 * consumers can do:
 *
 *   import { CFSelect } from "@repo/ui/cf-select";
 *   import { selectStyles } from "@repo/ui/cf-select/styles";
 */

import { CFSelect } from "./cf-select.ts";
import { selectStyles } from "./styles.ts";

export { CFSelect, selectStyles };

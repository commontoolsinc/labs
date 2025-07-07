/**
 * Entry point for the ct-select component.
 * Re-exports the class and shared style string so that
 * consumers can do:
 *
 *   import { CTSelect } from "@repo/ui/ct-select";
 *   import { selectStyles } from "@repo/ui/ct-select/styles";
 */

import { CTSelect } from "./ct-select.ts";
import { selectStyles } from "./styles.ts";

export { CTSelect, selectStyles };

/// <cts-enable />
/**
 * Minimal Google Auth Manager - Testing pattern composition
 *
 * ULTRA MINIMAL: Just pass through the wish result directly.
 * No computed, no processing - just wish() and return.
 */

import { pattern, UI, wish, WishState } from "commontools";
import { Auth } from "../google-auth.tsx";

export interface MinimalAuthManagerOutput {
  // deno-lint-ignore no-explicit-any
  wishResult: WishState<{ auth: Auth }>;
  // deno-lint-ignore no-explicit-any
  [UI]: any;
}

export const GoogleAuthManagerMinimal = pattern<
  Record<string, never>,
  MinimalAuthManagerOutput
>(
  () => {
    console.log("[MinimalAuth] Pattern body running");

    const wishResult = wish<{ auth: Auth }>({
      query: "#googleAuth",
      scope: [".", "~"],
    });

    console.log("[MinimalAuth] wish() returned");

    // Just pass through - no computed, no processing
    return {
      wishResult,
      [UI]: <div>Minimal auth manager - check wishResult</div>,
    };
  },
);

export default GoogleAuthManagerMinimal;

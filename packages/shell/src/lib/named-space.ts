import type { DID } from "@commonfabric/identity";
import type { RuntimeInternals } from "@commonfabric/lib-shell";
import type { AppState } from "../../shared/mod.ts";

/** Register a legacy named-space bootstrap key inside the worker before use. */
export async function prepareNamedSpace(
  app: AppState,
  rt: Pick<RuntimeInternals, "resolveSpaceName">,
  space: DID,
): Promise<void> {
  if (!("spaceName" in app.view)) return;
  const resolved = await rt.resolveSpaceName(app.view.spaceName);
  if (resolved !== space) {
    throw new Error(
      `Named space ${app.view.spaceName} resolved inconsistently: ${resolved} != ${space}`,
    );
  }
}

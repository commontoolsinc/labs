import { USE_SHELL_PREFIX } from "./env.ts";

export function getNavigationHref(spaceName: string, charmId: string): string {
  const prefix = USE_SHELL_PREFIX ? `/shell` : "";
  return `${prefix}/${spaceName}/${charmId}`;
}

export function navigateToCharm(spaceName: string, charmId: string) {
  globalThis.dispatchEvent(
    new CustomEvent("navigate-to-charm", {
      detail: { spaceName, charmId },
    }),
  );
}

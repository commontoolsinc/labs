import { USE_SHELL_PREFIX } from "./env.ts";

export function getNavigationHref(spaceName: string, charmId?: string): string {
  const prefix = USE_SHELL_PREFIX ? `/shell` : "";
  const charm = charmId ? `/${charmId}` : "";
  return `${prefix}/${spaceName}${charm}`;
}

export function navigateToCharm(spaceName: string, charmId: string) {
  globalThis.dispatchEvent(
    new CustomEvent("navigate-to-charm", {
      detail: { spaceName, charmId },
    }),
  );
}

import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { BaseView } from "../views/BaseView.ts";
import { navigate } from "../../shared/navigate.ts";
import type { AppState } from "../../shared/mod.ts";

// Reactive controller host is XAppView, define some interfaces
// to avoid a recursive dependency.
type ReactiveAppHost = ReactiveControllerHost & BaseView & { app: AppState };

/**
 * The shell's global keyboard shortcuts:
 *
 * - Cmd/Ctrl+Shift+O opens the quick jump view.
 * - Alt+W navigates to the space the current view addresses.
 *
 * Both are ignored while the key event is aimed at a text-entry element, while
 * the key is auto-repeating, and once something upstream has called
 * `preventDefault()`.
 */
export class GlobalShortcutsController implements ReactiveController {
  private host: ReactiveAppHost;

  // Whether the platform's primary shortcut modifier is Command rather than
  // Control. Read when the host connects, since it depends on `navigator`.
  #usesCommandKey = false;

  constructor(host: ReactiveAppHost) {
    this.host = host;
    this.host.addController(this);
  }

  hostConnected() {
    this.#usesCommandKey = navigator.platform.toLowerCase().includes("mac");
    document.addEventListener("keydown", this.#onKeyDown);
  }

  hostDisconnected() {
    document.removeEventListener("keydown", this.#onKeyDown);
  }

  #onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    if (e.repeat) return;
    if (isEditableTarget(e.target)) return;

    const mod = this.#usesCommandKey
      ? e.metaKey && !e.ctrlKey
      : e.ctrlKey && !e.metaKey;

    if (e.code === "KeyO" && mod && e.shiftKey && !e.altKey) {
      e.preventDefault();
      this.host.command({
        type: "set-config",
        key: "showQuickJumpView",
        value: true,
      });
      return;
    }

    if (
      e.code === "KeyW" && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey
    ) {
      e.preventDefault();
      const app = this.host.app;
      const spaceName = app && "spaceName" in app.view
        ? app.view.spaceName
        : "common-knowledge";
      navigate({ spaceName });
    }
  };
}

function isEditableTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  const tag = (element?.tagName || "").toLowerCase();
  return !!(
    element &&
    (element.isContentEditable ||
      tag === "input" ||
      tag === "textarea" ||
      tag === "select")
  );
}

export type ShortcutSpec = {
  name?: string;
  code?: string;
  key?: string;
  alt?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  ignoreEditable?: boolean;
  allowRepeat?: boolean;
  preventDefault?: boolean;
  stopPropagation?: boolean;
  when?: () => boolean;
  priority?: number;
};

export type ShortcutHandler = (e: KeyboardEvent) => void;

type RegisteredShortcut = {
  spec: Required<ShortcutSpec> & { code?: string; key?: string };
  handler: ShortcutHandler;
};

/**
 * Basic keyboard router for global shortcuts.
 *
 * Goals:
 * - Centralize keydown/keyup handling to avoid conflicts.
 * - Allow simple register()/dispose() lifecycle for shortcuts.
 * - Respect focus context and e.defaultPrevented to play well with others.
 *
 * Not (yet): scopes, modality, capture-phase arbitration. Can be extended.
 */
export class KeyboardRouter {
  #shortcuts: RegisteredShortcut[] = [];
  #alt = false;
  #ctrl = false;
  #meta = false;
  #shift = false;
  #onKeyDown = (e: KeyboardEvent) => {
    this.#updateMods(e, true);

    // If something already handled this, bail.
    if (e.defaultPrevented) return;

    const target = e.target as HTMLElement | null;
    const tag = (target?.tagName || "").toLowerCase();
    const isEditable = !!(
      target &&
      (target.isContentEditable ||
        tag === "input" ||
        tag === "textarea" ||
        tag === "select")
    );

    let best: RegisteredShortcut | undefined;
    for (const entry of this.#shortcuts) {
      const s = entry.spec;
      if (s.ignoreEditable && isEditable) continue;
      if (s.when && !s.when()) continue;
      if (!s.allowRepeat && e.repeat) continue;
      if (!this.#modsMatch(s)) continue;
      if (!this.#keyMatch(s, e)) continue;
      if (!best || s.priority > best.spec.priority) best = entry;
    }

    if (!best) return;

    const s = best.spec;
    if (s.preventDefault) e.preventDefault();
    if (s.stopPropagation) e.stopPropagation();
    best.handler(e);
  };
  #onKeyUp = (e: KeyboardEvent) => {
    this.#updateMods(e, false);
  };

  constructor() {
    document.addEventListener("keydown", this.#onKeyDown);
    document.addEventListener("keyup", this.#onKeyUp);
  }

  dispose() {
    document.removeEventListener("keydown", this.#onKeyDown);
    document.removeEventListener("keyup", this.#onKeyUp);
    this.#shortcuts = [];
  }

  register(spec: ShortcutSpec, handler: ShortcutHandler): () => void {
    const normalized: RegisteredShortcut = {
      spec: {
        name: spec.name,
        code: spec.code,
        key: spec.key,
        alt: !!spec.alt,
        ctrl: !!spec.ctrl,
        meta: !!spec.meta,
        shift: !!spec.shift,
        ignoreEditable: spec.ignoreEditable !== false,
        allowRepeat: !!spec.allowRepeat,
        preventDefault: spec.preventDefault !== false,
        stopPropagation: !!spec.stopPropagation,
        when: spec.when ?? (() => true),
        priority: spec.priority ?? 0,
      },
      handler,
    };
    this.#shortcuts.push(normalized);
    return () => {
      const i = this.#shortcuts.indexOf(normalized);
      if (i >= 0) this.#shortcuts.splice(i, 1);
    };
  }

  #modsMatch(s: Required<ShortcutSpec>) {
    return (
      s.alt === this.#alt &&
      s.ctrl === this.#ctrl &&
      s.meta === this.#meta &&
      s.shift === this.#shift
    );
  }

  #keyMatch(s: ShortcutSpec, e: KeyboardEvent) {
    if (s.code) return e.code === s.code;
    if (s.key) return this.#normKey(e.key) === this.#normKey(s.key);
    return false;
  }

  #normKey(k?: string) {
    if (!k) return undefined;
    return k.length === 1 ? k.toLowerCase() : k;
  }

  #updateMods(e: KeyboardEvent, down: boolean) {
    switch (e.key) {
      case "Alt":
        this.#alt = down;
        break;
      case "Control":
        this.#ctrl = down;
        break;
      case "Meta":
        this.#meta = down;
        break;
      case "Shift":
        this.#shift = down;
        break;
      default:
        // Mirror from event flags too
        this.#alt = e.altKey;
        this.#ctrl = e.ctrlKey;
        this.#meta = e.metaKey;
        this.#shift = e.shiftKey;
    }
  }
}

import * as DOM from "@gozala/co-dom";
import { Task } from "./db.js";

import { Behavior } from "./adapter.js";
import * as DB from "./db.js";
import { MOUNT } from "./ui.js";
import { CharmDebugger, getDebugCharms } from "./debugger.js";
import { CharmCommand } from "./command.js";
import { Reference } from "merkle-reference";

export class Charm extends HTMLElement {
  #root: ShadowRoot;
  #behavior: Behavior | null;
  #entity: Reference | null;
  #vdom: DOM.Node<{}> | null;
  #cell: null | { send(data: string): void };
  #mount: HTMLElement;
  renderMount: HTMLElement;
  animationWrapper: HTMLElement;
  #debugger: CharmDebugger | null = null;
  #command: CharmCommand | null = null;
  #errorDisplay: HTMLElement;

  #invocation: Task.Invocation<{}, Error> | null = null;
  #observer: MutationObserver;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = `
      .charm {
        position: relative;
        transform-origin: center;
        padding: 4px;
      }

      .charm.debug {
        border: 1px solid #4d4dff;
        border-radius: 4px;
        animation: pulse 2s infinite;
        padding: 4px;
      }

      .animation-wrapper.vdom-update {
        animation: grow 0.3s ease-out;
      }

      .placeholder {
        min-width: 64px;
        min-height: 64px;
        border: 2px dashed #808080;
        border-radius: 8px;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .placeholder::before {
        content: "?";
        font-size: 24px;
        color: #808080;
      }

      .error-display {
        border: 2px solid #ff0000;
        border-radius: 4px;
        padding: 12px;
        margin: 8px 0;
        background: #fff0f0;
        display: none;
      }

      .error-display.visible {
        display: block;
      }

      .error-display pre {
        margin: 8px 0;
        white-space: pre-wrap;
        word-wrap: break-word;
        background: #fff;
        padding: 8px;
        border: 1px solid #ffcccc;
      }

      @keyframes pulse {
        0% {
          border-color: rgba(77, 77, 255, 0.4);
          box-shadow: 0 0 0 0 rgba(77, 77, 255, 0.4);
        }
        70% {
          border-color: rgba(77, 77, 255, 0.8);
          box-shadow: 0 0 0 4px rgba(77, 77, 255, 0);
        }
        100% {
          border-color: rgba(77, 77, 255, 0.4);
          box-shadow: 0 0 0 0 rgba(77, 77, 255, 0);
        }
      }

      @keyframes grow {
        0% {
          transform: scale(1);
          opacity: 1;
          border: 0px solid rgba(0, 0, 0, 0);
        }
        33% {
          transform: scale(1.005);
          opacity: 0.98;
          border: 1px solid rgba(0, 0, 0, 0.2);
        }
        66% {
          transform: scale(0.999);
          opacity: 1;
          border: 0px solid rgba(0, 0, 0, 0);
        }
        100% {
          transform: scale(1);
          border: 0px solid rgba(0, 0, 0, 0);
        }
      }
    `;

    this.#mount = document.createElement("div");
    this.renderMount = document.createElement("div");
    this.animationWrapper = document.createElement("div");
    this.#errorDisplay = document.createElement("div");
    this.#errorDisplay.className = "error-display";

    this.#mount.classList.add("charm");
    this.renderMount.classList.add("placeholder", "render-mount");
    this.animationWrapper.classList.add("animation-wrapper");

    this.animationWrapper.appendChild(this.renderMount);
    this.#mount.appendChild(this.animationWrapper);
    this.#mount.appendChild(this.#errorDisplay);

    this.root.appendChild(style);
    this.root.appendChild(this.#mount);

    if (getDebugCharms()) {
      // this.#mount.classList.add("debug");
      this.#debugger = new CharmDebugger();
      this.#command = new CharmCommand();
      this.#mount.appendChild(this.#debugger);
      this.#mount.appendChild(this.#command);
    }

    this.#behavior = null;
    this.#entity = null;
    this.#vdom = null;
    this.#cell = null;

    window.addEventListener("spell-rule-enabled", ((e: CustomEvent) => {
      if (this.#behavior?.id == e.detail.id) {
        this.#behavior?.enableRule(e.detail.name);
        console.log(
          `Enabled rule ${e.detail.name} for behavior ${e.detail.id}`,
        );
      }
    }) as EventListener);

    window.addEventListener("spell-rule-disabled", ((e: CustomEvent) => {
      if (this.#behavior?.id == e.detail.id) {
        this.#behavior?.disableRule(e.detail.name);
        console.log(
          `Disabled rule ${e.detail.name} for behavior ${e.detail.id}`,
        );
      }
    }) as EventListener);

    // Add mutation observer to watch renderMount title changes
    this.#observer = new MutationObserver(() => {
      this.propagate();
    });

    this.#observer.observe(this.renderMount, {
      attributes: true,
      attributeFilter: ["title"],
    });
  }

  #handleError(action: string, error: Error) {
    this.#errorDisplay.classList.add("visible");
    this.#errorDisplay.innerHTML = `
      <h3><code>Error ${action}</code></h3>
      <details>
        <summary><code>${error.message || String(error)}</code></summary>
        <pre><code>${error.stack || ""}</code></pre>
      </details>
    `;
  }

  #clearError() {
    this.#errorDisplay.classList.remove("visible");
  }

  get vdom() {
    return this.#vdom;
  }

  set vdom(vdom) {
    this.#vdom = vdom;
    this.animationWrapper.classList.remove("vdom-update");
    void this.animationWrapper.offsetWidth; // Force reflow
    this.animationWrapper.classList.add("vdom-update");
  }

  set cell(value: any) {
    this.#cell = value;
  }

  async activate() {
    try {
      this.#invocation = Task.perform(this.spell.fork(this.entity));

      // throw new Error("This is a test error");

      await Task.perform(
        DB.transact([{ Upsert: [this.entity, MOUNT, this as any] }]),
      );

      this.propagate();
      this.#clearError();
    } catch (error) {
      this.#handleError("Activating Charm", error);
    }
  }

  deactivate() {
    try {
      if (this.#invocation) {
        this.#invocation.abort(undefined);
      }
      Task.perform(
        DB.transact([{ Retract: [this.entity, MOUNT, this as any] }]),
      );
      this.#clearError();
    } catch (error) {
      this.#handleError("Deactivating Charm", error);
    }
  }

  connectedCallback() {
    this.activate();
  }
  disconnectedCallback() {
    this.deactivate();
    this.#observer.disconnect();
  }

  *dispatch([attribute, event]: [string, Event]) {
    try {
      yield* DB.dispatch([this.entity, attribute, event]);
      this.#clearError();
    } catch (error) {
      this.#handleError("Dispatching Event", error);
    }
  }

  set entity(value: Reference) {
    try {
      this.#entity = (value as any)();
      if (this.#debugger) {
        this.#debugger.entity = this.#entity;
      }
      if (this.#command) {
        this.#command.entity = this.#entity;
      }
      this.#clearError();
    } catch (error) {
      this.#handleError("Setting Entity", error);
    }
  }

  get entity() {
    return this.#entity as Reference;
  }

  get spell() {
    return this.#behavior as Behavior;
  }

  set spell(value: Behavior) {
    try {
      this.#behavior = (value as any)();
      if (this.#debugger) {
        this.#debugger.behavior = this.#behavior;
      }
      if (this.#command) {
        this.#command.behavior = this.#behavior!;
      }
      this.#clearError();
    } catch (error) {
      this.#handleError("Setting Spell", error);
    }
  }

  get root() {
    return this.#root;
  }

  get name() {
    return this.renderMount.title || "untitled";
  }

  propagate() {
    try {
      this.#cell?.send(this.name);
      this.#clearError();
    } catch (error) {
      this.#handleError("Propagating Update", error);
    }
  }
}

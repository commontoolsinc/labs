import * as DOM from "@gozala/co-dom";
import { Reference, Task, transact } from "./db.js";

import { Behavior } from "./adapter.js";
import * as DB from "./db.js";
import { MOUNT } from "./ui.js";

function setDebugCharms(value: boolean) {
  (globalThis as any).DEBUG_CHARMS = value;
}

function getDebugCharms(): boolean {
  return (globalThis as any).DEBUG_CHARMS;
}

setDebugCharms(true);

export class Charm extends HTMLElement {
  #root: ShadowRoot;
  #behavior: Behavior | null;
  #entity: Reference | null;
  #vdom: DOM.Node<{}> | null;
  #cell: null | { send(data: { name: string }): void };
  #mount: HTMLElement;
  renderMount: HTMLElement;
  #debugMount: HTMLElement;

  #invocation: Task.Invocation<{}, Error> | null = null;

  constructor() {
    super();
    // Set up shadow and styles
    this.#root = this.attachShadow({ mode: "closed" });

    const style = document.createElement('style');
    style.textContent = `
      .charm {
        position: relative;
      }

      .charm.debug {
        border: 1px solid #4d4dff;
        border-radius: 4px;
        animation: pulse 2s infinite;
        padding: 4px;
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

      .charm-debugger {
        position: absolute;
        top: 4px;
        right: 4px;
        min-width: 128px;
        width: 33%;
        max-height: 512px;
        overflow-y: auto;
        background: blue;
        padding: 8px;
        font-size: 16px;
        font-family: monospace;
        color: white;

        border: 1px solid #4d4dff;
        border-radius: 4px;
        animation: pulse 2s infinite;
      }

      .charm-debugger ul {
        list-style: none;
      }

      .charm-debuggger summary {
        font-size: 12px;
      }
    `;

    this.#mount = document.createElement("div");
    this.renderMount = document.createElement("div");
    this.#debugMount = document.createElement("div");

    this.#mount.classList.add('charm')
    this.#debugMount.className = "charm-debugger"

    this.root.appendChild(style);
    this.root.appendChild(this.#mount);
    this.#mount.appendChild(this.renderMount);

    if (getDebugCharms()) {
      this.#mount.classList.add('debug')
      this.#mount.appendChild(this.#debugMount);
      this.renderDebug();
    }

    this.#behavior = null;
    this.#entity = null;
    this.#vdom = null;
    this.#cell = null;
  }

  renderDebug() {
    if (!this.#debugMount) return;

    this.#debugMount.innerHTML = '';

    const details = document.createElement('details');
    const summary = document.createElement('summary');

    if (this.entity) {
      summary.innerText = this.entity.toString();
      details.appendChild(summary);
    }

    if (this.#behavior?.rules) {
      const rules = Object.keys(this.#behavior.rules)
      const ul = document.createElement('ul')
      rules.forEach(rule => {
        const li = document.createElement('li')
        li.innerText = rule
        ul.appendChild(li)
      })
      details.appendChild(ul)
    }

    this.#debugMount.appendChild(details);
  }

  get vdom() {
    return this.#vdom;
  }
  set vdom(vdom) {
    this.#vdom = vdom;
  }

  set cell(value: any) {
    this.#cell = value;
  }

  async activate() {
    this.#invocation = Task.perform(this.spell.fork(this.entity));

    // bf: this should not be any at some point later
    await Task.perform(
      DB.transact([{ Upsert: [this.entity, MOUNT, this as any] }]),
    );

    this.propagate();
  }
  deactivate() {
    if (this.#invocation) {
      this.#invocation.abort(undefined);
    }
    // bf: this should not be any at some point later
    Task.perform(DB.transact([{ Retract: [this.entity, MOUNT, this as any] }]));
  }

  connectedCallback() {
    this.activate();
  }
  disconnectedCallback() {
    this.deactivate();
  }

  *dispatch([attribute, event]: [string, Event]) {
    yield* transact([{ Upsert: [this.entity, attribute, event as any] }]);

    // We retract the event right after so that rules will react to event
    // only once.
    yield* transact([{ Retract: [this.entity, attribute, event as any] }]);

    this.propagate();
  }

  set entity(value: Reference) {
    this.#entity = (value as any)();
    if (getDebugCharms()) {
      this.renderDebug();
    }
  }
  get entity() {
    return this.#entity as Reference;
  }

  get spell() {
    return this.#behavior as Behavior;
  }
  set spell(value: Behavior) {
    this.#behavior = (value as any)();
    if (getDebugCharms()) {
      this.renderDebug();
    }
  }

  get root() {
    return this.#root;
  }
  get name() {
    return this.renderMount.title;
  }

  propagate() {
    this.#cell?.send({ name: this.name });
  }
}

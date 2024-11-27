import * as DOM from "@gozala/co-dom";
import { Reference, Task, transact } from "./db.js";

import { Behavior } from "./adapter.js";
import * as DB from "./db.js";
import { MOUNT } from "./ui.js";
import { CharmDebugger, getDebugCharms } from "./debugger.js";

export class Charm extends HTMLElement {
  #root: ShadowRoot;
  #behavior: Behavior | null;
  #entity: Reference | null;
  #vdom: DOM.Node<{}> | null;
  #cell: null | { send(data: string): void };
  #mount: HTMLElement;
  renderMount: HTMLElement;
  #debugger: CharmDebugger | null = null;

  #invocation: Task.Invocation<{}, Error> | null = null;

  constructor() {
    super();
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
    `;

    this.#mount = document.createElement("div");
    this.renderMount = document.createElement("div");

    this.#mount.classList.add('charm')

    this.root.appendChild(style);
    this.root.appendChild(this.#mount);
    this.#mount.appendChild(this.renderMount);

    if (getDebugCharms()) {
      this.#mount.classList.add('debug')
      this.#debugger = new CharmDebugger();
      this.#mount.appendChild(this.#debugger);
    }

    this.#behavior = null;
    this.#entity = null;
    this.#vdom = null;
    this.#cell = null;
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
    if (this.#debugger) {
      this.#debugger.entity = this.#entity;
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
    if (this.#debugger) {
      this.#debugger.behavior = this.#behavior;
    }
  }

  get root() {
    return this.#root;
  }

  get name() {
    return this.renderMount.title || "untitled";
  }

  propagate() {
    this.#cell?.send( this.name );
  }
}

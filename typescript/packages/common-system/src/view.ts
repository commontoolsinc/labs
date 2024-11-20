import * as DOM from "@gozala/co-dom";
import { Reference, Task, transact } from "./db.js";

import { Behavior } from "./adapter.js";
import * as DB from "./db.js";
import { MOUNT } from "./ui.js";

export class Charm extends HTMLElement {
  #root: ShadowRoot;
  #behavior: Behavior | null;
  #entity: Reference | null;
  #vdom: DOM.Node<{}> | null;
  #cell: null | { send(data: { name: string }): void };
  mount: HTMLElement;

  #invocation: Task.Invocation<{}, Error> | null = null;

  constructor() {
    super();
    // Set up shadow and styles
    this.#root = this.attachShadow({ mode: "closed" });
    this.mount = document.createElement("div");

    this.root.appendChild(this.mount);

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
  }
  get entity() {
    return this.#entity as Reference;
  }

  get spell() {
    return this.#behavior as Behavior;
  }
  set spell(value: Behavior) {
    this.#behavior = (value as any)();
  }

  get root() {
    return this.#root;
  }
  get name() {
    return this.mount.title;
  }
  propagate() {
    this.#cell?.send({ name: this.name });
  }
}

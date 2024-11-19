import * as DOM from "@gozala/co-dom";
import { Reference, Task, transact } from "./db.js";

import { Behavior } from "./adapter.js";
import * as DB from "./db.js";

export class Charm extends HTMLElement {
  #root: ShadowRoot;
  #behavior: Behavior | null;
  #entity: Reference | null;
  #vdom: DOM.Node<{}> | null;
  #cell: null | { send(data: { name: string }): void };
  mount: HTMLElement;
  // #changes: Type.Instruction[] = [];

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

  // Here we pretend to be a reference so that database can treat it as such.
  get ["/"]() {
    return this.entity["/"];
  }

  async activate() {
    this.#invocation = Task.perform(this.spell.fork(this.entity));
    Task.perform(DB.transact([{ Upsert: [this.entity, "~/ui/mount", this] }]));
    // Add rerendering effect
    // Task.perform(
    //   Effect.spawn({
    //     effect: Render.rules.render,
    //     entity: this.entity,
    //   }),
    // );

    // for (const [_name, rule] of Object.entries(this.spell.rules)) {
    //   Task.perform(
    //     Effect.spawn({
    //       effect: toEffect(rule),
    //       entity: this.entity,
    //     }),
    //   );
    // }

    // Task.perform(
    //   Effect.spawn({
    //     effect: render,
    //     entity: this.entity,
    //   }),
    // );
  }
  deactivate() {
    if (this.#invocation) {
      this.#invocation.abort(undefined);
    }
    Task.perform(DB.transact([{ Retract: [this.entity, "~/ui/mount", this] }]));
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
    // yield* render(this);
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

import { customElement } from "lit-element/decorators.js";
import { eventProps } from "../hyperscript/schema-helpers.js";
import { view } from "../hyperscript/render.js";
import * as DOM from "@gozala/co-dom";
import * as DB from "synopsys";

let LAST_ID = 0;
let REFS = new Map();

export const box = <T>(local: T) => {
  const id = LAST_ID++;
  REFS.set(id, local);
  return id;
};

export const unbox = (remote: number) => {
  return REFS.get(remote);
};

export const cardContainer = view("common-charm", {
  spell: { type: "object" },
  ...eventProps(),
});

@customElement("common-charm")
export class CommonCharm extends HTMLElement {
  #root: ShadowRoot;
  #spell: Behavior | null;
  #entity: DB.API.Link | null;
  #replica: DB.Type.Replica;
  #vdom: DOM.Node<{}> | null;
  mount: HTMLElement;

  nodes: Map<string, DOM.Node<{}>>;
  constructor() {
    super();
    // Set up shadow and styles
    this.#root = this.attachShadow({ mode: "closed" });
    this.mount = document.createElement("div");

    this.root.appendChild(this.mount);

    this.#spell = null;
    this.#entity = null;
    this.nodes = new Map();
    this.#vdom = null;
  }
  get vdom() {
    return this.#vdom;
  }
  set vdom(vdom) {
    this.#vdom = vdom;
  }

  async activate() {
    const replica = await DB.Task.perform(
      DB.open({
        remote: {
          url: new URL("/api/data/", location.href),

          fetch: ((init, options) => {
            return fetch(init, options);
          }) as typeof fetch,
        },
      }),
    );

    this.#replica = replica;
    for (const [_name, rule] of Object.entries(this.spell)) {
      DB.Task.perform(drive(this, rule));
    }
  }

  connectedCallback() {
    this.activate();
  }

  dispatch([attribute, event]: [string, Event]) {
    const remote = box(event);
    this.replica.transact([
      {
        Assert: [this.entity, attribute, remote] as DB.Fact,
      },
    ]);
  }

  get replica() {
    return this.#replica;
  }

  set spell(value: Behavior) {
    this.#spell = (value as any)();
  }
  set entity(value: DB.API.Link) {
    this.#entity = (value as any)();
  }
  get entity() {
    return this.#entity;
  }

  get spell() {
    return this.#spell;
  }

  get root() {
    return this.#root;
  }
}

/**
 * Rule defines a specific behavior for an entity referenced by the `?`
 * variable. It provides a selector to query entity and relevant relations
 * and provides an update logic that submits new facts to the database when
 * when result of the selector changes.
 */
export interface Rule<Select extends DB.API.Selector = DB.API.Selector> {
  select: Select;
  where: DB.API.Query["where"];
  update: (input: DB.API.InferBindings<Select>) => DB.Transaction;
}

/**
 * Behavior is a collection of rules that define behavior for a specific
 * entity. This roughly corresponds to "spell".
 */
export interface Behavior extends Record<string, Rule> {}

/**
 * This function does not serve any other purpose but to activate TS type
 * inference specifically it ensures that rule `update` functions infer it's
 * arguments from the rules `select`.
 */
export const spell = <Source extends Record<string, any>>(behavior: {
  [K in keyof Source]: Rule<Source[K]>;
}): { [K in keyof Source]: Rule<Source[K]> } => behavior;

const isVDOM = (node: unknown): node is DOM.Node<{}> =>
  typeof node === "object" && node !== null && "nodeType" in node;

export function* drive<Selection extends DB.Selector>(
  charm: CommonCharm,
  rule: Rule<Selection>,
) {
  const { replica } = charm;
  const subscription = yield* replica.subscribe({
    select: rule.select,
    where: rule.where,
  });

  const stream = subscription.fork();
  const reader = stream.getReader();
  while (true) {
    const { value: selection, done } = yield* DB.Task.wait(reader.read());
    if (done) {
      break;
    } else {
      // Selection is an array of frames but charm should be selecting a single
      // match. For now we just discard the rest.
      if (selection.length > 1) {
        throw new RangeError(
          `Expected single match but got ${selection.length}`,
        );
      } else {
        const changes = rule.update(selection[0]);
        const commit = [];
        for (const change of changes) {
          if (change.Assert) {
            const [entity, attribute, value] = change.Assert;
            if (String(attribute).startsWith("~/")) {
              if (isVDOM(value)) {
                charm.nodes.set(String(attribute), value);
              }
              commit.push({ Assert: [entity, attribute, box(value)] } as const);
            } else if (change.Retract) {
              const [entity, attribute, value] = change.Retract;
              if (String(attribute).startsWith("~/")) {
                const remote = box(value as any);
                REFS.delete(remote);
                charm.nodes.delete(String(attribute));
                commit.push({ Retract: [entity, attribute, remote] } as const);
              } else {
                commit.push(change);
              }
            } else {
              commit.push(change);
            }
          }
          yield* replica.transact(commit);
        }
      }
    }
  }
}

export const on = (
  event: DOM.EncodedEvent["type"],
  attribute: string = `~/on/${event}`,
) =>
  DOM.on(event, {
    /**
     *
     * @param {DOM.EncodedEvent} event
     */
    decode(event) {
      return {
        message: /** @type {DB.Fact} */ [
          attribute,
          /** @type {any & DB.Entity} */ event,
        ],
      };
    },
  });

export const UI = "~/common/ui";
/**
 * Renders entities `/common/ui` attribute into the session mount point, wiring
 * event listeners such they will dispatch derived facts onto the session.
 *
 */
export const render = (charm: CommonCharm) => {
  /** @type {DB.Term<UI.Ref<UI.Node<[DB.Entity, string, object]>>>} */
  const ui = charm.nodes.get(UI);
  if (ui) {
    if (charm.vdom === null) {
      charm.vdom = DOM.virtualize(charm.mount);
    } else if (ui !== charm.vdom) {
      const delta = DOM.diff(charm.vdom, ui as DOM.Node<{}>);
      DOM.patch(charm.mount, charm.vdom, delta, {
        send(fact: [attribute: string, event: Event]) {
          charm.dispatch(fact);
        },
      });
    }
  }
};

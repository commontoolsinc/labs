import { customElement } from "lit-element/decorators.js";
import { eventProps } from "../hyperscript/schema-helpers.js";
import { view } from "../hyperscript/render.js";
import * as DOM from "@gozala/co-dom";
import * as DB from "synopsys";

export const cardContainer = view("common-charm", {
  spell: { type: "object" },
  ...eventProps(),
});

export type LocalState = Map<
  string,
  { local: number; remote: number; value: unknown }
>;

@customElement("common-charm")
export class CommonCharm extends HTMLElement {
  #root: ShadowRoot;
  #spell: Behavior | null;
  #entity: DB.API.Link | null;
  #replica: DB.Type.Replica;
  #vdom: DOM.Node<{}> | null;
  #cell: { send(data: { name: string }): void };
  mount: HTMLElement;

  state: LocalState;
  constructor() {
    super();
    // Set up shadow and styles
    this.#root = this.attachShadow({ mode: "closed" });
    this.mount = document.createElement("div");

    this.root.appendChild(this.mount);

    this.#spell = null;
    this.#entity = null;
    this.state = new Map();
    this.#vdom = null;
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
    const replica = await DB.Task.perform(
      DB.open({
        remote: {
          // url: new URL("/api/data/", location.href),
          // url: new URL("http://localhost:8080/"),
          url: new URL("https://komshi.saga-castor.ts.net/"),

          fetch: (async (init: Request) => {
            const { method, headers, url } = init;
            const body =
              method === "GET"
                ? undefined
                : method === "HEAD"
                  ? undefined
                  : new Uint8Array(await init.arrayBuffer());

            while (true) {
              let request = await fetch(url, {
                headers,
                method,
                body,
              });
              if (request.status != 0) {
                return request;
              }
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
          }) as typeof fetch,
        },
      }),
    );

    this.#replica = replica;
    for (const [_name, rule] of Object.entries(this.spell)) {
      DB.Task.perform(spawn(this, rule));
    }
  }

  connectedCallback() {
    this.activate();
  }

  dispatch([attribute, event]: [string, Event]) {
    const changes = this.upsert(attribute, event);
    DB.Task.perform(this.transact(changes));
  }

  upsert(attribute: string, value: unknown) {
    const changes = [] as DB.Instruction[];
    let state = this.state.get(attribute);
    if (state) {
      state.local++;
      state.value = value;
    } else {
      state = { local: 1, remote: 1, value };
      this.state.set(attribute, state);
    }
    state.remote = state.local;

    changes.push({
      Upsert: [this.entity, attribute, `${attribute}@${state.remote}`],
    });
    return changes;
  }
  retract(attribute: string, value: any) {
    const changes = [] as DB.API.Instruction[];
    const state = this.state.get(attribute);
    if (state) {
      changes.push({
        Retract: [this.entity, attribute, `${attribute}@${state.remote}`],
      });
      state.local++;
      state.remote = state.local;
    } else {
      changes.push({ Retract: [this.entity, attribute, value] });
    }
    return changes;
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

  *transact(changes: DB.Transaction) {
    yield* this.replica.transact(changes);
    render(this);

    this.propagate();
  }
  get name() {
    return this.mount.title;
  }
  propagate() {
    this.#cell.send({ name: this.name });
  }
}

export interface Effect<Select extends DB.API.Selector = DB.API.Selector> {
  select: Select;
  where: DB.API.Query["where"];
  perform: (
    input: DB.API.InferBindings<Select>,
  ) => DB.Task.Task<DB.Transaction, never>;
}

/**
 * Rule defines a specific behavior for an entity referenced by the `?`
 * variable. It provides a selector to query entity and relevant relations
 * and provides an update logic that submits new facts to the database when
 * when result of the selector changes.
 */
export interface Rule<Select extends DB.API.Selector = DB.API.Selector>
  extends Effect<Select> {
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

export function* spawn<Selection extends DB.Selector>(
  charm: CommonCharm,
  rule: Effect<Selection>,
) {
  const { replica } = charm;
  const subscription = yield* replica.subscribe({
    select: rule.select,
    where: [
      // TODO: Figure out why `Is` is not working.
      //{ Is: [DB.$.self, charm.entity] },
      { Match: [charm.entity, "==", DB.$.self] },
      // ...
      ...rule.where,
    ],
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
      } else if (selection.length === 1) {
        const match = read(selection[0], charm.state);
        if (match.ok) {
          const changes = yield* rule.perform(match.ok);
          const commit = [];
          for (const change of changes) {
            if (change.Assert) {
              const [_entity, attribute, value] = change.Assert;
              if (String(attribute).startsWith("~/")) {
                commit.push(...charm.upsert(String(attribute), value));
              } else {
                commit.push(change);
              }
            } else if (change.Upsert) {
              const [_entity, attribute, value] = change.Upsert;
              if (String(attribute).startsWith("~/")) {
                commit.push(...charm.upsert(String(attribute), value));
              } else {
                commit.push(change);
              }
            } else if (change.Retract) {
              const [_entity, attribute, value] = change.Retract;
              if (String(attribute).startsWith("~/")) {
                commit.push(...charm.retract(String(attribute), value));
              } else {
                commit.push(change);
              }
            } else {
              commit.push(change);
            }
          }
          yield* charm.transact(commit);
        }
      }
    }
  }
}

const isLocalReference = (input: unknown): input is string =>
  typeof input === "string" && input.startsWith("~/") && input.includes("@");

export const parseReference = (source: unknown) => {
  if (isLocalReference(source)) {
    const [attribute, version] = source.split("@");
    return { attribute, version: Number(version) };
  } else {
    return {};
  }
};

const read = (
  selection: unknown,
  state: LocalState,
): DB.API.Result<any, Error> => {
  if (isLocalReference(selection)) {
    const remote = parseReference(selection);
    const revision = state.get(remote.attribute);
    // We made a round trip so we increment local version to avoid reacting
    // to it again.
    if (revision && revision.local === remote.version) {
      revision.local++;
      delete revision.value;
      return { ok: revision.value };
    } else {
      return { error: new Error("Inconsistent") };
    }
  } else if (selection === null) {
    return { ok: null };
  } else if (ArrayBuffer.isView(selection)) {
    return { ok: selection };
  } else if (Array.isArray(selection)) {
    const members = [];
    for (const element of selection) {
      const member = read(element, state);
      if (member.ok) {
        members.push(member.ok);
      } else {
        return member;
      }
    }
    return { ok: members };
  } else if (
    typeof selection === "object" &&
    (selection as any)["/"] instanceof Uint8Array
  ) {
    return { ok: selection };
  } else if (typeof selection === "object") {
    const result = {} as Record<string, any>;
    for (const [key, value] of Object.entries(selection)) {
      const member = read(value, state);
      if (member.error) {
        return member;
      } else {
        result[key] = member.ok;
      }
    }
    return { ok: result };
  } else {
    return { ok: selection };
  }
};

export const UI = "~/common/ui";
/**
 * Renders entities `/common/ui` attribute into the session mount point, wiring
 * event listeners such they will dispatch derived facts onto the session.
 *
 */
export const render = (charm: CommonCharm) => {
  const local = charm.state.get(UI);
  if (local) {
    const vdom = local.value as DOM.Node<{}>;
    if (charm.vdom === null) {
      charm.vdom = DOM.virtualize(charm.mount);
    }
    if (vdom !== charm.vdom) {
      const delta = DOM.diff(charm.vdom, vdom);
      DOM.patch(charm.mount, charm.vdom, delta, {
        send(fact: [attribute: string, event: Event]) {
          charm.dispatch(fact);
        },
      });
      charm.vdom = vdom;
    }
  }
};

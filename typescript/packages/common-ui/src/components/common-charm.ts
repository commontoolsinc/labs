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

const local: LocalState = new Map();

const upsert = (entity: DB.API.Entity, attribute: string, value: unknown) => {
  const changes = [] as DB.Instruction[];
  const id = `${attribute}@${entity}`;
  let state = local.get(id);
  if (state) {
    state.local++;
    state.value = value;
  } else {
    state = { local: 1, remote: 1, value };
    local.set(id, state);
  }
  state.remote = state.local;

  changes.push({
    Upsert: [entity, attribute, `${id}:${state.remote}`],
  });
  return changes;
};

const retract = (entity: DB.API.Entity, attribute: string, value: any) => {
  const changes = [] as DB.API.Instruction[];
  const id = `${attribute}@${entity}`;
  const state = local.get(id);
  if (state) {
    changes.push({
      Retract: [entity, attribute, `${id}:${state.remote}`],
    });
    state.local++;
    state.remote = state.local;
  } else {
    changes.push({ Retract: [entity, attribute, value] });
  }
  return changes;
};

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
    const changes = upsert(this.entity, attribute, event);
    DB.Task.perform(this.transact(changes));
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
        const match = resolve(selection[0]);
        if (match.ok) {
          const changes = yield* rule.perform(match.ok);
          const commit = [];
          for (const change of changes) {
            if (change.Assert) {
              const [entity, attribute, value] = change.Assert;
              if (String(attribute).startsWith("~/")) {
                commit.push(...upsert(entity, String(attribute), value));
              } else {
                commit.push(change);
              }
            } else if (change.Upsert) {
              const [entity, attribute, value] = change.Upsert;
              if (String(attribute).startsWith("~/")) {
                commit.push(...upsert(entity, String(attribute), value));
              } else {
                commit.push(change);
              }
            } else if (change.Retract) {
              const [entity, attribute, value] = change.Retract;
              if (String(attribute).startsWith("~/")) {
                commit.push(...retract(entity, String(attribute), value));
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
  typeof input === "string" && input.startsWith("~/") && input.includes(":");

export const parseReference = (source: unknown) => {
  if (isLocalReference(source)) {
    const [id, version] = source.split(":");
    return { id, version: Number(version) };
  } else {
    return {};
  }
};

const resolve = (selection: unknown): DB.API.Result<any, Error> => {
  if (isLocalReference(selection)) {
    const remote = parseReference(selection);
    const state = local.get(remote.id);
    // We made a round trip so we increment local version to avoid reacting
    // to it again.
    if (state && state.local === remote.version) {
      const { value } = state;
      state.local++;
      delete state.value;
      return { ok: value };
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
      const member = resolve(element);
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
      const member = resolve(value);
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
  const state = local.get(`${UI}@${charm.entity}`);
  if (state) {
    const vdom = state.value as DOM.Node<{}>;
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

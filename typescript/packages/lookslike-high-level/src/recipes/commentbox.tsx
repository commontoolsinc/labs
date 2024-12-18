import {
  recipe,
  derive,
  stream,
  type OpaqueRef,
  UI,
  ifElse,
} from "@commontools/common-builder";
import { h } from "@commontools/common-html";
import { cell } from "@commontools/common-runner";

/**
 * Plan to rewrite this on top of recipe stack
 *
 * For now assume it won't be sandboxed, so `this` will at runtime refer to the
 * instance of the Spell. Note though that this is all on opaqueref space, but
 * the recipe-opaqueref is a transparent wrapper around life cells, so it should
 * work.
 *
 * .compile() will call `recipe` with a callback that constructs all the opaque
 * refs and so on.
 *
 * E.g. this.set({ ... }) should be possible to do, we look up the cells
 * in our cell table and update them.
 *
 * A few changes:
 * - formulating queries is select(($) => ({ foo: $.foo }))
 *   - would be nicer if we'd instead have this.<state> instead of $.foo?
 *     that's a bunch more work though.
 *   - we could also allow a shortcut like { foo, bar: ["bar", "baz"] }
 * - addEventHandler just gets the whole state
 * - addRule needs the builder syntax:
 *   - `event(name)` adds a stream of that name to parameters
 *   - `select(($) => ({ foo: $.foo }))` adds a query to the rule
 *   - `with(schema)` gets all keys from the schema
 *   - `match(condition)` adds a condition to the rule
 *   - First step: Just assume `select`.
 * - handlers just get values
 * - event handlers use this.set() without self to update the state
 * - derive rules just return new values
 */

// $ is a proxy that just collect paths, so that one can call [getPath] on it
// and get an array. For example for `q = $.foo.bar[0]` `q[getPath]` yields
// `["foo", "bar", 0]`. This is used to generate queries.

type PathSegment = PropertyKey | { fn: string; args: any[] };
const getPath = Symbol("getPath");

// Create the path collector proxy
function createPathCollector(path: PathSegment[] = []): any {
  return new Proxy(
    function () {}, // Base target is a function to support function calls
    {
      get(_target, prop) {
        if (prop === getPath) return path;
        // Continue collecting path for property access
        return createPathCollector([...path, prop]);
      },

      // Catch any function calls
      apply(_target, _thisArg, args) {
        // Get the last segment which should be the function name
        const lastSegment = path[path.length - 1];
        if (typeof lastSegment !== "string") {
          throw new Error("Invalid function call");
        }

        // Remove the function name from the path and add it as a function call
        const newPath = path.slice(0, -1);
        return createPathCollector([...newPath, { fn: lastSegment, args }]);
      },
    },
  );
}

// Create the root $ proxy
const $ = createPathCollector();

// Resolve $ to a paths on `self`
// TODO: Also for non-top-level ones
function resolve$(self: OpaqueRef<any>, query: any) {
  const entries = Object.entries(query);
  const result: Record<string, any> = {};

  for (const [key, value] of entries) {
    if (value && typeof value === "object" && getPath in value) {
      const path = value[getPath] as PathSegment[];

      let current = self;
      for (const segment of path) {
        if (typeof segment === "object" && "fn" in segment) {
          // Execute any function with its arguments
          current = current[segment.fn].apply(current, segment.args);
        } else {
          current = current[segment as PropertyKey];
        }
      }

      result[key] = current;
    } else {
      result[key] = value;
    }
  }

  return result;
}

function select(query: any) {
  const generateQuery = (self: OpaqueRef<any>) => resolve$(self, query);
  Object.assign(generateQuery, {
    with: (schema: any) =>
      select({
        ...resolve$(self, query),
        ...Object.fromEntries(
          Object.keys(schema.properties ?? {}).map(key => [
            key,
            self[key as any],
          ]),
        ),
      }),
  });
  return generateQuery;
}

// addRule(event("update"), ({ $event }) => { ... })
function event(name: string) {
  // .compile() will replace $event with actual stream
  return select({ $event: name });
}

export abstract class Spell<T extends Record<string, any>> {
  private eventListeners: Array<{
    type: string;
    handlerFn: (self: any, ev: any) => any;
  }> = [];
  private rules: Array<{
    condition: any;
    handlerFn: (ctx: any) => any;
  }> = [];

  private streams: Record<string, OpaqueRef<any>> = {};

  constructor() {}

  // `self` is what is passed to the handler, so for now a query result proxy
  set(self: any, values: Partial<T>) {
    Object.entries(values).forEach(([key, value]) => {
      self[key] = value;
    });
  }

  // Is this being called when an event happens?
  /*
  dispatch(self: any, event: string, detail: any) {
    return [
      { Upsert: [self, appendOnPrefix(event), detail] }
    ]
  }
  */

  // Use this in JSX, e.g. onClick={this.dispatch('random')}
  // TODO: Add details bound to event
  dispatch(event: string) {
    console.log("dispatch", event, this.streams[event]);
    return this.streams[event];
  }

  addEventListener(type: string, handlerFn: (self: any, ev: any) => any) {
    this.eventListeners.push({ type, handlerFn });
  }

  addRule(condition: any, handlerFn: (ctx: any) => any) {
    this.rules.push({ condition, handlerFn });
  }

  abstract init(): T;

  abstract render(state: T): any;

  // Used when chaining the query, e.g. `with(this.get('meta', ""))`
  /*
  get<S extends string>(field: S, defaultValue?: any) {
    if (defaultValue) {
      return select({ [field]: $[field] } as const).clause(defaultTo($.self, field, $[field], defaultValue));
    }
    return select({ [field]: $[field] } as const).match($.self, field, $[field])
  }
  */

  compile(title: string = "Spell") {
    return recipe(title, (self: OpaqueRef<any>) => {
      const initialState = this.init() ?? {};
      const state: Record<string, OpaqueRef<any>> = {};

      Object.entries(initialState).forEach(([key, value]) => {
        self[key].setDefault(value);
        state[key] = self[key];
      });

      this.eventListeners.forEach(({ type, handlerFn }) => {
        this.streams[type] ??= stream();
        derive({ self, $event: this.streams[type] }, ({ self, $event }) =>
          handlerFn(self, $event),
        );
      });

      this.rules.forEach(rule => {
        // condition:
        //  ($) => { foo: $.foo }
        //  select({ foo: $.foo })
        //  select({ foo: $.foo, bar: $.bar.map(item => item.foo) })
        //     .filter(fn), count(), take(n), skip(n),
        //     .sortBy(fn, dir?), groupBy(key), distinct(key),
        //     .join(ref, key?)
        //  event("update")
        //  ["foo", "bar"]

        let condition = rule.condition(self);

        if (Array.isArray(condition))
          condition = Object.fromEntries(
            condition.map(key => [key, self[key]]),
          );
        else if (
          condition &&
          typeof condition === "object" &&
          condition !== null &&
          "$event" in condition
        )
          condition["$event"] = this.streams[condition["$event"]];

        derive(condition, rule.handlerFn);
      });

      return {
        [UI]: this.render(self),
        ...this.streams,
        ...state,
      };
    });
  }
}

function doc<T = any>(value: any) {
  return cell<T>(value).getAsQueryResult();
}

type CommentsState = {
  title: string;
  description: string;
  meta: Meta | null;
};

type Meta = {
  category: string;
  submittedAt: string;
};

class MetadataSpell extends Spell<Meta> {
  constructor() {
    super();

    this.addEventListener("update", (self, ev) => {
      console.log("update", ev);
      this.set(
        self,
        doc({
          category: ev.detail.value,
          submittedAt: new Date().toISOString(),
        }),
      );
    });
  }

  override init() {
    return {
      category: "Default category",
      submittedAt: "n/a",
    };
  }

  override render({ category, submittedAt }: OpaqueRef<Meta>) {
    console.log("Metadata render", category, submittedAt);
    return (
      <div>
        <h2>Metadata</h2>
        <common-input
          type="text"
          name="category"
          value={category}
          oncommon-blur={this.dispatch("update")}
        />
        <small>{submittedAt}</small>
      </div>
    );
  }
}

const metadata = new MetadataSpell().compile("Metadata");

function Metadata({ meta }: { meta: Meta }, _children: any) {
  return metadata(meta ?? {})[UI];
}

export class CommentBoxSpell extends Spell<CommentsState> {
  constructor() {
    super();

    this.addEventListener("random", self => {
      console.log("random", self);

      const metadata: Meta = doc({
        category: "Demo category " + Math.random(),
        submittedAt: new Date().toISOString(),
      });

      this.set(self, { meta: metadata });
    });

    this.addEventListener("submit", self => {
      console.log("submit", self);
    });
  }

  override init() {
    return {
      title: "Class Syntax Demo",
      description: "It has an embedded doc!",
      meta: null,
    };
  }

  override render({ description, title, meta }: OpaqueRef<CommentsState>) {
    return (
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
        <pre>{derive(meta, meta => JSON.stringify(meta, null, 2))}</pre>
        {ifElse(
          meta,
          <div>
            <Metadata meta={meta!} />
          </div>,
          <div>No meta</div>,
        )}
        <common-form onsubmit={this.dispatch("submit")}>
          <common-input type="text" name="message" />
        </common-form>
        <common-button onclick={this.dispatch("random")}>Random</common-button>
      </div>
    );
  }

  /*
  override render({ description, title, meta }: CommentsState) {
    return (
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
        <pre>{JSON.stringify(meta, null, 2)}</pre>
        {meta && (
          <div>
            <Metadata meta={{ category: "test", submittedAt: "test" }} />
          </div>
        )}
        <common-form onsubmit={this.dispatch("submit")}>
          <common-input type="text" name="message" />
        </common-form>
        <common-button onclick={this.dispatch("random")}>Random</common-button>
      </div>
    );
  }*/
}

const commentBox = new CommentBoxSpell().compile("Comment Box");

(window as any).metadata = metadata;
(window as any).commentBox = commentBox;

export default commentBox;

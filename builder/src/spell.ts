import { derive, type OpaqueRef, recipe, stream, UI } from "./index.ts";

// $ is a proxy that just collect paths, so that one can call [getPath] on it
// and get an array. For example for `q = $.foo.bar[0]` `q[getPath]` yields
// `["foo", "bar", 0]`. This is used to generate queries.

type PathSegment = PropertyKey | { fn: string; args: any[] };
const getPath = Symbol("getPath");
type PathCollector = ((this: any, ...args: any[]) => any) & {
  [getPath]: PathSegment[];
  [key: string]: PathCollector;
};

// Create the path collector proxy
function createPathCollector(path: PathSegment[] = []): PathCollector {
  return new Proxy(
    function () {} as unknown as PathCollector, // Base target is a function to support function calls
    {
      get(target, prop) {
        if (prop === getPath) return path;
        if (typeof prop === "symbol") return (target as any)[prop];

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

// // Create the root $ proxy
export const $ = createPathCollector();

// Resolve $ to a paths on `self`
// TODO(seefeld): Also for non-top-level ones
function resolve$(self: OpaqueRef<any>, query: PathCollector) {
  const entries = Object.entries(query);
  const result: Record<string, any> = {};

  for (const [key, value] of entries) {
    if (value && typeof value === "function" && value[getPath]) {
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

export function select(query: any) {
  const generateQuery = (self: OpaqueRef<any>) => resolve$(self, query);
  Object.assign(generateQuery, {
    with: (schema: any) =>
      select({
        ...resolve$(self, query),
        ...Object.fromEntries(
          Object.keys(schema.properties ?? {}).map((
            key,
          ) => [key, (self as any)[key]]),
        ),
      }),
  });
  return generateQuery;
}

// addRule(event("update"), ({ $event }) => { ... })
export function event(name: string) {
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

  /**
   * Merges existing state with new values
   * @param self The current state proxy object
   * @param values Partial state updates to apply
   */
  update(self: any, values: Partial<T>) {
    Object.entries(values).forEach(([key, value]) => {
      self[key] = value;
    });
  }

  /**
   * Returns a stream reference for the given event type
   * Used in JSX event handlers, e.g. onClick={this.dispatch('click')}
   * @param event The event type to dispatch
   * @returns An OpaqueRef stream for the event
   */
  dispatch(event: string) {
    return this.streams[event];
  }

  /**
   * Registers an event listener that will be called when events are dispatched
   * @param type The event type to listen for
   * @param handlerFn Function called when event occurs, receives (state, event)
   */
  addEventListener(type: string, handlerFn: (self: any, ev: any) => any) {
    this.eventListeners.push({ type, handlerFn });
  }

  /**
   * Adds a reactive rule that runs when its conditions are met
   * @param condition Query condition that determines when rule runs
   * @param handlerFn Function called when condition is met, receives query context
   */
  addRule(condition: any, handlerFn: (ctx: any) => any) {
    this.rules.push({ condition, handlerFn });
  }

  /**
   * Initializes the spell's state
   * Must be implemented by subclasses
   * @returns Initial state object
   */
  abstract init(): T;

  /**
   * Renders the spell's UI
   * Must be implemented by subclasses
   * @param state Current spell state
   * @returns JSX element or other render output
   */
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
        derive(
          { self, $event: this.streams[type] },
          ({ self, $event }) => handlerFn(self, $event),
        );
      });

      this.rules.forEach((rule) => {
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

        if (Array.isArray(condition)) {
          condition = Object.fromEntries(
            condition.map((key) => [key, self[key]]),
          );
        } else if (
          condition &&
          typeof condition === "object" &&
          condition !== null &&
          "$event" in condition
        ) {
          condition["$event"] = this.streams[condition["$event"]];
        }

        condition.self = self;

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

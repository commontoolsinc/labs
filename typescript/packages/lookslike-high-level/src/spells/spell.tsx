import { Reference } from "merkle-reference";
import { defaultTo, event, Transact } from "../sugar.js";
import { h, $, Behavior, behavior, Instruction, refer, Rule, Scope, Select, select, Selector, Session } from "@commontools/common-system";

export function appendOnPrefix(path: string): string {
  if (!path.startsWith('~/on/')) {
    return `~/on/${path}`;
  }
  return path;
}

export const changes = (...instructions: (Instruction | Instruction[])[]) => {
  return instructions.reduce<Instruction[]>((acc, curr) =>
    acc.concat(Array.isArray(curr) ? curr : [curr]), []);
};

export class Embed<T extends any> {
  constructor(public value: T) { }

  static decode<T>(txt: string): T {
    return JSON.parse(txt) as T;
  }

  id() {
    const txt = JSON.stringify(this.value);
    return refer(txt);
  }

  save() {
    const txt = JSON.stringify(this.value);
    return txt;
  }
}

export class Doc<T extends Record<string, string | number | boolean>> {
  constructor(public value: T) { }

  id() {
    return refer(this.value);
  }

  save() {
    const self = this.id();
    return [
      ...Transact.set(self, this.value)
    ];
  }

  dispatch(event: string, detail: any) {
    const self = this.id();
    return [
      { Assert: [self, appendOnPrefix(event), detail] }
    ]
  }
}

export function execute<T extends Record<string, any>, S extends Spell<T>>(id: Reference, SpellClass: new () => S) {
  const spell = new SpellClass().compile()
  return spell.spawn(id);
}

export function Charm<T extends Record<string, Rule<Selector>>>({ spell, self }: { spell: Behavior<T>, self: Reference }) {
  return <common-charm id={self.toString()} key={self.toString()} spell={() => spell} entity={() => self} />
}

export abstract class Spell<T extends Record<string, any>> {
  private eventListeners: Array<{
    type: string;
    handler: (self: Reference, ev: any) => any;
  }> = [];

  private rules: Array<{
    condition: any;
    handler: (ctx: any) => any;
  }> = [];

  constructor() { }

  set(self: Reference, values: Partial<T>) {
    return [
      ...Transact.set(self, values)
    ];
  }

  dispatch(self: Reference, event: string, detail: any) {
    return [
      { Upsert: [self, appendOnPrefix(event), detail] }
    ]
  }

  addEventListener(type: string, handler: (self: Reference, ev: any) => any) {
    this.eventListeners.push({ type, handler });
  }

  addRule(condition: any, handler: (ctx: any) => any) {
    this.rules.push({ condition, handler });
  }

  abstract init(): T;
  abstract render(state: T): any;

  get<S extends string>(field: S, defaultValue?: any) {
    if (defaultValue) {
      return select({ [field]: $[field] } as const).clause(defaultTo($.self, field, $[field], defaultValue));
    }
    return select({ [field]: $[field] } as const).match($.self, field, $[field])
  }

  compile(): Behavior<Record<string, Rule<Selector>>> {
    const initialState = this.init();
    const stateKeys = Object.keys(initialState) as Array<keyof T>;

    const behaviorDef: Record<string, any> = {};

    // Transform event listeners into behavior events
    this.eventListeners.forEach(({ type, handler }, index) => {
      behaviorDef[`on${type.charAt(0).toUpperCase()}${type.slice(1)}${index}`] =
        event(type)
          .update(({ self, event }) => {
            const ev = Session.resolve(event);
            return handler(self, ev);
          })
          .commit();
    });

    // Transform rules into behavior rules
    this.rules.forEach((rule, index) => {
      behaviorDef[`rule${index}`] =
        rule.condition
          .update(rule.handler)
          .commit();
    });
    behaviorDef.init = select({ self: $.self }).not(q => q.match($.self, '_init', $._)).update(({ self }) => {
      let initValues: any = { '_init': true };
      let changes: Instruction[] = [];
      for (const [key, value] of Object.entries(initialState)) {
        if (value !== null && typeof value !== 'object') {
          initValues[key] = value;
        } else if (value?.collection) {
          changes.push(...initialState[key].new({ [key]: self }));
        }
      }
      changes.push(...this.set(self, { _init: true }));
      return changes;
    }).commit();

    // Transform render method with its state dependencies
    behaviorDef.render = select({
      self: $.self,
      ...Object.fromEntries(stateKeys.map(key => [key, $[key]]))
    });
    // Add defaultTo clauses for each primitive state value
    stateKeys.forEach(key => {
      if (initialState[key] !== null && (typeof initialState[key] !== 'object')) {
        behaviorDef.render = behaviorDef.render
          .clause(defaultTo($.self, key as string, $[key], initialState[key]));
      } else if (initialState[key]?.collection) {
        behaviorDef.render = behaviorDef.render
          .clause(initialState[key].match($[key]));
      } else if (typeof initialState[key] === 'object') {
        behaviorDef.render = behaviorDef.render
          .clause(defaultTo($.self, key as string, $[key], null));
      }
    });

    // Add the actual render implementation
    behaviorDef.render = behaviorDef.render
      .match($.self, '_init', $._)
      .render(this.render)
      .commit();

    return behavior(behaviorDef) as any;
  }
}

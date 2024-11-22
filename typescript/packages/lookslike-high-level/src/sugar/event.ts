import { $, select, Select, Reference } from "@commontools/common-system";
import { Variable } from 'datalogia'

export type Events = Record<string, `~/on${string}`>;

export const event = <T extends Record<string, any>, D extends (name: string) => `~/on/${string}`>(name: Parameters<D>[0], additionalTerms?: T) => {
  const eventPath = name.startsWith('~/on/') ? name : `~/on/${name}`;
  return (select({
    self: $.self,
    event: $.event,
    ...additionalTerms || {}
  }) as Select<{
    self: Variable<Reference>,
    event: Variable<Reference>
  } & {
    [K in keyof T]: Variable<any>
  }>).match($.self, eventPath, $.event);
};


class EventDeclaration {
  name: string;

  constructor(name: string) {
    this.name = name;
  }

  subscribe() {
    return event(this.name);
  }

  dispatch() {
    return this.name.startsWith('~/on/') ? this.name : `~/on/${this.name}`;
  }
}

export function declareEvents<T extends Record<string, string>>(events: T): { [K in keyof T]: EventDeclaration } {
  const declarations = {} as { [K in keyof T]: EventDeclaration };
  for (const [name, path] of Object.entries(events)) {
    declarations[name as keyof T] = new EventDeclaration(path);
  }
  return declarations;
}

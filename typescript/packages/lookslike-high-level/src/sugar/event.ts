import { $, select, Select} from "@commontools/common-system";
import { Variable } from 'datalogia'
import { Reference } from "merkle-reference";

export type Events = Record<string, `~/on${string}`>;

export function events<T extends Events>(events: T): T {
  return events
}

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

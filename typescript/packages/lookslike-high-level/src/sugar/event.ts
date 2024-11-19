import { $, select, Select } from "@commontools/common-system";
import { Variable } from 'datalogia'

export const event = <T extends Record<string, any>, D extends (name: string) => `~/on/${string}`>(name: Parameters<D>[0], additionalTerms?: T) => {
  return (select({
    self: $.self,
    event: $.event,
    ...additionalTerms || {}
  }) as Select<{
    self: Variable<any>,
    event: Variable<any>
  } & {
    [K in keyof T]: Variable<any>
  }>).match($.self, `~/on/${name}`, $.event);
};
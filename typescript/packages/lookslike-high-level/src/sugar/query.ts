import { $, select, Select } from "@commontools/common-system";
import { Selector, Variable } from 'datalogia'
import { Constant } from "synopsys";
import { defaultTo } from "./default.js";

export const query = <M extends Record<string, string | number | boolean | null | any[]>, T extends keyof M>(model: M, ...fields: T[]) => {
  const selection = { self: $.self, ...Object.fromEntries(fields.map(name => [name, $[name]])) };
  type Bindings = {
    self: Variable<any>;
  } & {
    [K in T]: Variable<any>;
  };
  const selectParams = select(selection) as Select<Bindings>;
  return fields.reduce((acc, field) => {
    return acc.match($.self, field as any, $[field]);
  }, selectParams);
};

export function getOrDefault<T extends Constant, S extends Selector>(
  select: Select<S>,
  attribute: string,
  field: Variable,
  fallback: T
) {
  return select.or(w => {
    return w
      .match($.self, attribute, field)
      .and(w => {
        return w
          .not(q => q.match($.self, attribute, $._))
          .formula(fallback, '==', field);
      });
  })
}

export const queryDefault = <M extends Record<string, any>, T extends keyof M>(model: M, ...fields: T[]) => {
  const selection = {
    self: $.self,
    ...Object.fromEntries(fields.map(name => [name, $[name]]))
  };

  type Bindings = {
    self: Variable<any>;
  } & {
    [K in T]: Variable<M[K]>;
  };
  const selectParams = select(selection) as Select<Bindings>;
  return fields.reduce((acc, field) => {
    if (Array.isArray(model[field])) {
      return acc.match($.self, field as any, $[field]);
    }
    return getOrDefault(acc, field as string, $[field], model[field]);
  }, selectParams);
};

export function field<T extends string, U extends Constant>(name: T, defaultVal?: U, overrideName?: string) {
  const fieldName = overrideName || name;
  const sel = select<{ self: any } & { [K in T]: U }>({ self: $.self, [fieldName]: $[name] } as any);
  return defaultVal !== undefined
    ? sel.clause(defaultTo($.self, name, $[name], defaultVal))
    : sel.match($.self, name, $[name]);
}

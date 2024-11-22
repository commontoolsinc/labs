import { $, select, Select, Where } from "@commontools/common-system";
import { Clause, Selector, Variable } from 'datalogia'
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

function getOrDefault2(attribute: string, field: Variable<any>, defaultValue: Constant): Clause {
  return {
    Or: [
      {
        And: [
          { Not: { Case: [$.self, attribute, $._] } },
          { Match: [defaultValue, "==", field] }
        ]
      },
      { Case: [$.self, attribute, field] },
    ]
  }
}

export const queryDefault2 = <M extends Record<string, any>, T extends keyof M>(model: M, ...fields: T[]) => {
  const selection = {
    self: $.self,
    ...Object.fromEntries(fields.map(name => [name, $[name]]))
  };

  type Bindings = {
    self: Variable<any>;
  } & {
    [K in T]: Variable<M[K]>;
  };
  const where = fields.reduce<Clause[]>((acc, field) => {
    if (Array.isArray(model[field])) {
      return [...acc, { Case: [$.self, field as any, $[field]] }];
    }
    return [...acc, getOrDefault2(field as string, $[field], model[field])];
  }, []);

  return new Select(selection as Bindings, new Where(...where))
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
  const sel = select<{ self: any } & { [K in T]: U }>({ self: $.self, [fieldName]: $[name] });
  return defaultVal !== undefined
    ? sel.clause(defaultTo($.self, name, $[name], defaultVal))
    : sel.match($.self, name, $[name]);
}

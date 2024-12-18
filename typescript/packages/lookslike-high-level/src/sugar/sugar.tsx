import {
  h,
  $,
  Instruction,
  Select,
  select,
  refer,
  Rule,
} from "@commontools/common-system";
import { z } from "zod";
import { field } from "./query.js";
import { Reference } from "merkle-reference";
import { defaultTo } from "./default.js";

// zod schema -> query
export function resolve<T extends z.ZodObject<any>>(
  schema: T,
  root = true
): Select<z.infer<T> & { self: Reference }> {
  let aggregator: Select<z.infer<T> & { self: Reference }> = root ? select({
    self: $.self,
  }) : select({}) as any;

  if (!schema.shape) {
    const defaultValue = (schema as any)._def.defaultValue?.();
    const resolver = defaultValue !== undefined
      ? field('value', defaultValue)
      : field('value');

    if (!aggregator) {
      aggregator = resolver as any;
    } else {
      aggregator = aggregator.with(resolver);
    }
  } else {
    for (const [fieldName, fieldData] of Object.entries(schema.shape)) {
      if ((fieldData as any)._def.typeName === 'ZodArray') {
        const innerType = (fieldData as any)._def.type;
        const subresolver = resolve(innerType as z.ZodObject<any>, false)
        const subselector = subresolver.selector
        // @ts-ignore
        delete subselector['self']

        let arrayResolver = select({
          [fieldName]: [{
            this: $[fieldName],
            ...subselector
          }]
        });

        // Match each key in subselector
        for (const key of Object.keys(subselector)) {
          const defaultValue = (innerType.shape[key] as any)?._def?.defaultValue?.();
          if (defaultValue !== undefined) {
            arrayResolver = arrayResolver.clause(defaultTo($[fieldName], key, $[key], defaultValue));
          } else {
            arrayResolver = arrayResolver.match($[fieldName], key, $[key]);
          }
        }

        if (!aggregator) {
          aggregator = arrayResolver as any;
        } else {
          aggregator = aggregator.with(arrayResolver);
        }
      } else {
        const defaultValue = (fieldData as any)._def.defaultValue?.();
        const resolver = defaultValue !== undefined
          ? field(fieldName, defaultValue)
          : field(fieldName);

        if (!aggregator) {
          aggregator = resolver as any;
        } else {
          aggregator = aggregator.with(resolver);
        }
      }
    }
  }

  return aggregator;
}

export const collection = (membership: string): Rule => {
  return {
    select: {
      self: $.self,
      cause: $.cause,
      new: $["instance/new"],
    },
    where: [
      { Case: [$.self, "instance/new", $["instance/new"]] },
      {
        Or: [
          { Case: [$.self, "instance/cause", $.cause] },
          {
            And: [
              { Not: { Case: [$.self, "instance/cause", $._] } },
              { Match: [null, "==", $.cause] },
            ],
          },
        ],
      },
    ],
    update: ({
      cause,
      self,
      new: old,
    }: {
      cause: Reference;
      self: Reference;
      new: Reference;
    }) => {
      const entity = refer({ last: cause, of: self });
      return [
        { Upsert: [self, "instance/cause", entity] },
        { Assert: [self, membership, entity] },
        { Retract: [self, "instance/new", old] },
      ];
    },
  };
};

export const make = (self, member): Instruction => ({
  Upsert: [self, "instance/new", member],
});

export function createQuery(keys: string[]) {
  // Build the select object with all properties
  const selectObj = keys.reduce(
    (acc, key) => {
      return { ...acc, [key]: $[key] };
    },
    { self: $.self } as const,
  );

  // Create the base select
  let queryBuilder = select(selectObj);

  // Add match for each property
  keys.forEach(key => {
    queryBuilder = queryBuilder.match($.self, key, $[key]);
  });

  return queryBuilder;
}

// Type to track property accesses
type PropertyAccess = {
  path: string[];
};

class SchemaCollector {
  private accesses: PropertyAccess[] = [];

  collect(access: PropertyAccess) {
    this.accesses.push(access);
  }

  getKeys() {
    return this.accesses
      .filter(access => access.path.length === 1 && access.path[0] !== "self")
      .map(access => access.path[0]);
  }
}

function createPropertyProxy(
  collector: SchemaCollector,
  path: string[] = [],
): any {
  return new Proxy(
    {},
    {
      get(target, prop: string) {
        if (path.length === 0 && prop === "self") {
          return $.self;
        }

        const newPath = [...path, prop];
        collector.collect({ path: newPath });
        return $[path[0] || prop];
      },
    },
  );
}

export function view(templateFn: (q: any) => any) {
  // Create collector and magic object
  const collector = new SchemaCollector();
  const q = createPropertyProxy(collector);

  // Run template to collect accesses
  templateFn(q);

  // Get keys from collected accesses
  const keys = collector.getKeys();

  // Create query and return its render result
  return createQuery(keys).render(templateFn);
}

import {
  h,
  $,
  Instruction,
  Select,
  select,
  refer,
  Term,
  Rule,
  Variable,
  WhereBuilder,
  Clause,
} from "@commontools/common-system";
import { z } from "zod";
import { field } from "./query.js";
import { fromString, Reference } from "merkle-reference";
import { defaultTo } from "./default.js";
import { Transact } from "../sugar.js";
import { log } from "./activity.js";

export function list<T extends z.ZodObject<any>, U extends z.ZodObject<any>>(
  schema: T,
  selection?: U,
) {
  let base = resolve(selection ?? schema);
  const item = base.selector.self;
  const newVar = $.listItem;
  let selector = base.selector as any;
  (selector as any).self = newVar;

  const constraints: Clause[] = base.clauses.map(constraint => {
    if (constraint.Case) {
      return {
        Case: [newVar, constraint.Case[1], constraint.Case[2]],
      } as Clause;
    }

    return constraint;
  });

  constraints.push(conforms(newVar, schema));

  selector = new Select(
    { self: $.self, items: [selector] },
    new WhereBuilder(...constraints),
  ) as any;
  console.log("selector", selector);

  return selector as Select<{ self: Reference; items: T }>;
}

export function listByRef<T extends z.ZodObject<any>>(
  schemaRef: Term,
  resultShape: z.ZodObject<any>,
) {
  const base = resolve(resultShape);
  const item = base.selector.self;
  const newVar = $.listItem;
  let selector = base.selector;
  (selector as any).self = newVar;

  const constraints: Clause[] = base.clauses.map(constraint => {
    if (constraint.Case) {
      return {
        Case: [newVar, constraint.Case[1], constraint.Case[2]],
      } as Clause;
    }

    return constraint;
  });

  constraints.push(conformsByRef(newVar, schemaRef));

  selector = new Select(
    { self: $.self, items: [selector] },
    new WhereBuilder(...constraints),
  ) as any;
  console.log("selector", selector);

  return selector as Select<{ self: Reference; items: T }>;
}

// zod schema -> query
export function resolve<T extends z.ZodObject<any>>(
  schema: T,
  root = true,
  self: Variable<Reference> = $.self,
  namespace = "",
): Select<z.infer<T> & { self: Reference }> {
  let aggregator: Select<z.infer<T> & { self: Reference }> = root
    ? select({
        self,
      })
    : (select({}) as any);

  console.log("schema", root, schema.shape);

  if (!schema.shape) {
    const defaultValue = (schema as any)._def.defaultValue?.();
    const resolver =
      defaultValue !== undefined
        ? field("value", defaultValue)
        : field("value");

    if (!aggregator) {
      aggregator = resolver as any;
    } else {
      aggregator = aggregator.with(resolver);
    }
  } else {
    for (const [fieldName, fieldData] of Object.entries(schema.shape)) {
      if ((fieldData as any)._def.typeName === "ZodArray") {
        const innerType = (fieldData as any)._def.type;
        const subresolver = resolve(
          innerType as z.ZodObject<any>,
          false,
          $[namespace + fieldName],
          fieldName,
        );
        const subselector = subresolver.selector;

        let arrayResolver = select({
          [fieldName]: [
            {
              ...subresolver.selector,
              self: $[namespace + fieldName],
            },
          ],
        }).match(self, fieldName, $[namespace + fieldName]);

        // Match each key in subselector and include subresolver clauses
        console.log(fieldName, "subselector", subselector);

        // First add the subresolver clauses
        if (subresolver.clauses) {
          arrayResolver = subresolver.clauses.reduce((resolver, clause) => {
            return resolver.clause(clause);
          }, arrayResolver);
        }

        if (!aggregator) {
          aggregator = arrayResolver as any;
        } else {
          aggregator = aggregator.with(arrayResolver);
        }
      } else if ((fieldData as any)._def.typeName === "ZodObject") {
        const subresolver = resolve(
          fieldData as z.ZodObject<any>,
          false,
          $[namespace + fieldName],
          fieldName,
        );

        let objectResolver = select({
          [fieldName]: {
            ...subresolver.selector,
            self: $[namespace + fieldName],
          },
        });

        if (subresolver.clauses) {
          objectResolver = subresolver.clauses.reduce((resolver, clause) => {
            return resolver.clause(clause);
          }, objectResolver);
        }

        if (!aggregator) {
          aggregator = objectResolver as any;
        } else {
          aggregator = aggregator.with(objectResolver);
        }
      } else {
        const defaultValue = (fieldData as any)._def.defaultValue?.();
        const resolver =
          defaultValue !== undefined
            ? select({ [fieldName]: $[namespace + fieldName] }).clause(
                defaultTo(
                  self,
                  fieldName,
                  $[namespace + fieldName],
                  defaultValue,
                ),
              )
            : select({ [fieldName]: $[namespace + fieldName] }).clause({
                Case: [self, fieldName, $[namespace + fieldName]],
              });

        if (!aggregator) {
          aggregator = resolver as any;
        } else {
          aggregator = aggregator.with(resolver);
        }
      }
    }
  }

  if (root) {
    console.log("aggregator", aggregator);
  }

  return aggregator;
}

export const StoredSchema = z.object({
  name: z.string().describe("The name of the schema"),
  schema: z.string().describe("The sourcecode of the schema"),
  selection: z
    .string()
    .describe(
      "Serialized JSON of the selection shape that will retrieve this schema",
    ),
});

export function conforms<T extends z.ZodObject<any>>(
  entity: Term,
  schema: T,
): Clause {
  return conformsByRef(entity, refer(JSON.stringify(schema.shape)));
}

export function conformsByRef(entity: Term, schemaRef: Term): Clause {
  return {
    Case: [entity, "common/schema", schemaRef],
  };
}

export function tagWithSchema<T extends z.ZodObject<any>>(
  entity: Term,
  schema: T,
): Instruction[] {
  const id = refer(JSON.stringify(schema.shape));
  const metaSchema = refer(JSON.stringify(StoredSchema.shape));

  return [
    { Assert: [entity, "common/schema", id] },
    ...Transact.set(id, {
      name: schema.description || "<unknown>",
      schema: JSON.stringify(schema.shape),
      "common/schema": metaSchema,
      selection: JSON.stringify(resolve(schema).commit()),
    }),
    ...Transact.set(metaSchema, {
      name: "Schema",
      schema: JSON.stringify(StoredSchema.shape),
    }),
  ];
}

export function importEntity<T extends z.ZodObject<any>>(
  value: any,
  schema: T,
  createRelationships = true,
) {
  // Get reference fields from schema
  const refFields = Object.entries(schema.shape)
    .filter(
      ([_, field]) =>
        field instanceof z.ZodArray || field instanceof z.ZodObject,
    )
    .map(([key]) => key);

  // Split data and references
  const { refs, data } = Object.entries(value).reduce(
    (acc, [key, val]) => {
      if (refFields.includes(key)) {
        acc.refs[key] = val;
      } else {
        acc.data[key] = val;
      }
      return acc;
    },
    { refs: {}, data: {} } as {
      refs: Record<string, any>;
      data: Record<string, any>;
    },
  );

  let instructions: Instruction[] = [{ Import: data }];

  const self = refer(data);

  if (createRelationships) {
    Object.entries(refs).forEach(([field, refValue]) => {
      instructions.push(...associate(self, field, refValue));
    });
  }

  instructions = instructions.concat(tagWithSchema(self, schema));

  return { self, instructions };
}

/**
 * Creates a relationship between two entities
 */
export function associate(
  source: Reference,
  relationshipField: string,
  targetRefs: string | string[] | Reference | Reference[],
): Instruction[] {
  const refs = Array.isArray(targetRefs) ? targetRefs : [targetRefs];
  return refs
    .map(ref =>
      Transact.assert(source, {
        [relationshipField]: typeof ref === "string" ? fromString(ref) : ref,
      }),
    )
    .flat();
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

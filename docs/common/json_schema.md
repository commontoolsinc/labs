# JSON Schema

Our system uses the JSON Schema standard, specifically the 2020-12
[core](https://json-schema.org/draft/2020-12/json-schema-core) and
[validation](https://json-schema.org/draft/2020-12/draft-bhutton-json-schema-validation-01)
specifications.

Many cells are linked together in complex graphs. Since clients typically don't
need all reachable cells, schemas serve as filters to limit what data is
returned.

We also automatically convert TypeScript types to JSON Schema as part of our
recipe compilation workflow.

Due to its specialized role in our system, we handle these schemas differently
from standard implementations in several ways.

## Extensions

We add several custom fields to the schema that are meaningful to our system:

- **`asCell`**: Indicates that instead of storing data directly in the object,
  the containing object will have a link to a cell, and that linked cell will
  contain the actual data
- **`asStream`**: Creates a special cell that can be used to easily connect
  events to their listeners
- **`ifc`**: Allows us to specify additional properties, such as the list of
  `classification` properties associated with the data

## Special Handling of additionalProperties

The `additionalProperties` field in JSON Schema objects defaults to `true`, but
our system treats this field as having three distinct states:

- **`true`**: Follow additional properties (those not explicitly defined in the
  schema) to find other linked cells
- **`false`**: Don't follow additional properties and don't include linked cells
  from the current object
- **undefined** (not specified): Follow only the properties explicitly defined
  in the schema

### Example

Consider a cell with the following contents:

```json
{
  "country": "United States",
  "postalCode": { "/": "baed...0002" }, // link to cell2
  "state": { "/": "baed...0003" } // link to cell3
}
```

**When `additionalProperties` is `false`:**

```json
{
  "type": "object",
  "properties": {
    "country": { "type": "string" },
    "postalCode": { "type": "string" }
  },
  "additionalProperties": false
}
```

Result: We include the queried node but exclude cell2 and cell3.

**When `additionalProperties` is `true`:**

```json
{
  "type": "object",
  "properties": {
    "country": { "type": "string" },
    "postalCode": { "type": "string" }
  },
  "additionalProperties": true
}
```

Result: We include the queried node plus both cell2 and cell3.

**When `additionalProperties` is not specified:**

```json
{
  "type": "object",
  "properties": {
    "country": { "type": "string" },
    "postalCode": { "type": "string" }
  }
}
```

Result: We include the queried node plus cell2, but exclude cell3.

## Unsupported Features

We currently don't support a significant subset of JSON Schema validation
features. While this list isn't exhaustive, here are some key limitations:

The `anyOf` field has limited support. Some parts of our codebase handle `anyOf`
well, while others are restricted to matching only primitives.

The following operations have minimal or no support:

- Core logic: `allOf`, `anyOf`, `oneOf`, `not`
- Core conditionals: `if`, `then`, `else`
- Validation: `enum`

Generally, these limitations make our system more permissive than standard JSON
Schema implementations.

## TypeScript Type Mappings

TypeScript includes `never`, `void`, and `undefined` types that don't map
directly to JSON Schema.

### Handling of `undefined`

- In objects: Properties with `undefined` values are removed entirely (both key
  and value)
- In arrays: `undefined` values are replaced with `null`

### Handling of `void`

The `void` type is only used for function return types and shouldn't appear
where we use JSON Schema.

### Handling of `never`

The `never` type is commonly used in scenarios like rejecting invalid
properties:

```typescript
type User = {
  id: number;
  name: string;
  email?: string;
  // This property should never exist
  password?: never;
};
```

We express this pattern in JSON Schema as:

```json
{
  "type": "object",
  "properties": {
    "id": { "type": "number" },
    "name": { "type": "string" },
    "email": { "type": "string" },
    "password": false
  },
  "required": ["id", "name"]
}
```

The `never` type is also used for ensuring objects have no properties:

```typescript
type EmptyObj = Record<string | number | symbol, never>;
```

This translates to:

```json
{
  "type": "object",
  "additionalProperties": false
}
```

## Schema Narrowing

We sometimes derive schemas from larger schemas, such as when accessing a field
of one cell as another cell.

### Example

Starting with a contact entry schema:

```json
{
  "type": "object",
  "properties": {
    "address": {
      "type": "object",
      "properties": {
        "postOfficeBox": { "type": "string" },
        "extendedAddress": { "type": "string" },
        "streetAddress": { "type": "string" },
        "locality": { "type": "string" },
        "region": { "type": "string" },
        "postalCode": { "type": "string" },
        "countryName": { "type": "string" }
      },
      "required": ["locality", "region", "countryName"]
    },
    "name": { "type": "string" },
    "phoneNumber": { "type": "string" }
  }
}
```

When accessing the cell's `address` field, we narrow the schema to just that
portion:

```json
{
  "type": "object",
  "properties": {
    "postOfficeBox": { "type": "string" },
    "extendedAddress": { "type": "string" },
    "streetAddress": { "type": "string" },
    "locality": { "type": "string" },
    "region": { "type": "string" },
    "postalCode": { "type": "string" },
    "countryName": { "type": "string" }
  },
  "required": ["locality", "region", "countryName"]
}
```

### Complications with Core Logic

Schema narrowing becomes complex when using operations like `anyOf`. For
example, if you want to ensure every contact has either an address with a
`streetAddress` OR a `phoneNumber` on the main contact, you might use `anyOf`
where the first clause requires `phoneNumber` but not `streetAddress`, and the
second clause requires `streetAddress` but not `phoneNumber`.

However, when narrowing to just the address portion, we lose the context of how
fields outside the narrowed schema affect the validation logic. The resulting
narrowed schema may be more permissive than intended.

This isn't problematic for our design since the schema still fulfills its
primary role of limiting linked cells and field access, even when more
permissive than expected.

### Complex Example

**Top-level schema:**

```json
{
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "address": {
          "type": "object",
          "properties": {
            "streetAddress": { "type": "string" },
            "locality": { "type": "string" },
            "region": { "type": "string" },
            "countryName": { "type": "string" }
          },
          "required": ["locality", "region", "countryName"]
        },
        "name": { "type": "string" },
        "phoneNumber": { "type": "string" }
      },
      "required": ["name", "phoneNumber", "address"]
    },
    {
      "type": "object",
      "properties": {
        "address": {
          "type": "object",
          "properties": {
            "streetAddress": { "type": "string" },
            "locality": { "type": "string" },
            "region": { "type": "string" },
            "countryName": { "type": "string" }
          },
          "required": ["streetAddress", "locality", "region", "countryName"]
        },
        "name": { "type": "string" },
        "phoneNumber": { "type": "string" }
      },
      "required": ["name", "address"]
    }
  ]
}
```

**Derived narrowed schema for the `address` field:**

```json
{
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "streetAddress": { "type": "string" },
        "locality": { "type": "string" },
        "region": { "type": "string" },
        "countryName": { "type": "string" }
      },
      "required": ["locality", "region", "countryName"]
    },
    {
      "type": "object",
      "properties": {
        "streetAddress": { "type": "string" },
        "locality": { "type": "string" },
        "region": { "type": "string" },
        "countryName": { "type": "string" }
      },
      "required": ["streetAddress", "locality", "region", "countryName"]
    }
  ]
}
```

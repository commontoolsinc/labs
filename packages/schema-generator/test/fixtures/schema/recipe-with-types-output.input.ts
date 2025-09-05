// Mirrors js-runtime fixture: recipe-with-types (outputSchema)
// Root type must be named SchemaRoot for the fixtures runner.

import { Default } from "commontools";

interface Item {
  text: Default<string, "">;
}

interface InputSchemaInterface {
  title: Default<string, "untitled">;
  items: Default<Item[], []>;
}

interface OutputSchemaInterface extends InputSchemaInterface {
  items_count: number;
}

type SchemaRoot = OutputSchemaInterface;

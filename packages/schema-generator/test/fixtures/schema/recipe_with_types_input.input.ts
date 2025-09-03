// Mirrors js-runtime fixture: recipe-with-types (inputSchema)
// Root type must be named SchemaRoot for the fixtures runner.

import { Default } from "commontools";

interface Item {
  text: Default<string, "">;
}

interface InputSchemaInterface {
  title: Default<string, "untitled">;
  items: Default<Item[], []>;
}

type SchemaRoot = InputSchemaInterface;


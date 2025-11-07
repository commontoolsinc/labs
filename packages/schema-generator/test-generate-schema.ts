#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env
// Quick script to generate schema from a fixture input file

import { createSchemaTransformerV2 } from "./src/plugin.ts";
import { getTypeFromCode, normalizeSchema } from "./test/utils.ts";

const inputPath = Deno.args[0];
if (!inputPath) {
  console.error("Usage: ./test-generate-schema.ts <input-file.ts>");
  Deno.exit(1);
}

const code = await Deno.readTextFile(inputPath);
const { type, checker, typeNode } = await getTypeFromCode(code, "SchemaRoot");
const transformer = createSchemaTransformerV2();
const normalized = normalizeSchema(
  transformer.generateSchema(type, checker, typeNode),
);
const serialized = JSON.stringify(normalized, null, 2) + "\n";
console.log(serialized);

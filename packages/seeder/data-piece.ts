import {
  compileAndSavePattern,
  createJsonSchema,
  type JSONSchema,
} from "@commonfabric/runner";
import type { PieceManager } from "@commonfabric/piece";

export const createDataPiece = (
  pieceManager: PieceManager,
  data: Record<string, unknown>,
  schema?: JSONSchema,
  name?: string,
) => {
  const argumentSchema = schema ?? createJsonSchema(data);

  const schemaString = JSON.stringify(argumentSchema, null, 2);
  const properties = typeof argumentSchema === "boolean"
    ? undefined
    : argumentSchema.properties;
  const result = Object.keys(properties ?? {}).map((key) =>
    `    ${key}: data.${key},\n`
  ).join("\n");

  const dataPatternSrc = `import { h } from "@commonfabric/html";
  import { pattern, UI, NAME, derive, type JSONSchema } from "@commonfabric/runner";

  const schema = ${schemaString};

  export default pattern((data) => ({
    [NAME]: "${name ?? "Data Import"}",
    [UI]: <div><h2>Your data has this schema</h2><pre>${
    schemaString.replaceAll("{", "&#123;")
      .replaceAll("}", "&#125;")
      .replaceAll("\n", "<br/>")
  }</pre></div>,
    ${result}
  }), schema, schema);`;

  return compileAndSavePattern(pieceManager.runtime, dataPatternSrc, {
    spec: name ?? "Data Import",
    space: pieceManager.getSpace(),
  }).then((pattern) => pieceManager.runPersistent(pattern, data));
};

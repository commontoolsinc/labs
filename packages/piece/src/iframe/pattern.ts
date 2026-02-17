import { Cell, type JSONSchema, type Runtime } from "@commontools/runner";
import { getPatternIdFromPiece } from "../manager.ts";

export type IFramePattern = {
  src: string;
  argumentSchema: JSONSchema;
  resultSchema: JSONSchema;
  spec: string;
  plan?: string;
  goal?: string;
  name: string;
};

export const buildFullPattern = (iframe: IFramePattern) => {
  const properties = typeof iframe.resultSchema === "boolean"
    ? undefined
    : iframe.resultSchema.properties;
  const result = Object.keys(properties ?? {}).map((key) =>
    `    ${key}: data.${key},\n`
  ).join("\n");

  return `import { h, pattern, type JSONSchema, UI, NAME } from "commontools";

  type IFramePattern = {
    src: string,
    argumentSchema: JSONSchema,
    resultSchema: JSONSchema,
    spec: string,
    plan?: string,
    goal?: string,
    name: string,
  }

  const inst: IFramePattern = /* IFRAME-V0 */ ${
    JSON.stringify(iframe, null, 2)
  } /* IFRAME-V0 */

  const runIframePattern = ({ argumentSchema, resultSchema, src, name }: IFramePattern) =>
  pattern(argumentSchema, resultSchema, (data) => ({
    [NAME]: name,
    [UI]: (
      <ct-iframe src={src} $context={data}></ct-iframe>
    ),
${result}
  }));

  export default runIframePattern(inst);
  `;
};

function parseIframePattern(source: string): IFramePattern {
  // Extract content between IFRAME-V0 comments
  const match = source.match(
    /\/\* IFRAME-V0 \*\/([\s\S]*?)\/\* IFRAME-V0 \*\//,
  );

  if (!match || !match[1]) {
    throw new Error("Could not find IFRAME-V0 pattern content in source");
  }

  return JSON.parse(match[1]) as IFramePattern;
}

export const getIframePattern = (
  piece: Cell<unknown>,
  runtime: Runtime,
): {
  patternId: string;
  // `src` is either a single file string source, or the entry
  // file source code in a pattern.
  src?: string;
  iframe?: IFramePattern;
} => {
  const patternId = getPatternIdFromPiece(piece);
  if (!patternId) {
    console.warn("No patternId found for piece", piece.entityId);
    return { patternId, src: "", iframe: undefined };
  }
  const meta = runtime.patternManager.getPatternMeta({ patternId });
  const src = meta
    ? (meta.src ??
      meta.program?.files.find((file) => file.name === meta.program?.main)
        ?.contents)
    : undefined;
  if (!src) {
    return { patternId };
  }
  try {
    return { patternId, src, iframe: parseIframePattern(src) };
  } catch (_) {
    return { patternId, src };
  }
};

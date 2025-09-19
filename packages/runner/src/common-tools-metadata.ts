const KNOWN_COMMONTOOLS_EXPORTS = [
  "derive",
  "ifElse",
  "toSchema",
  "navigateTo",
  "lift",
  "str",
  "handler",
  "recipe",
  "h",
  "cell",
  "createCell",
  "compute",
  "render",
  "llm",
  "llmDialog",
  "generateObject",
  "fetchData",
  "streamData",
  "compileAndRun",
  "byRef",
  "getRecipeEnvironment",
  "ID",
  "ID_FIELD",
  "TYPE",
  "NAME",
  "UI",
  "schema",
  "AuthSchema",
  "Default",
  "Cell",
  "Stream",
] as const;

export type CommonToolsMetadata = {
  helpers: string[];
  aliases: string[];
};

const ALIAS_PROPERTY_REGEX =
  /commontools_(\w+)\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/g;
const BASE_ALIAS_PROPERTY_REGEX =
  /commontools\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/g;

export function extractCommonToolsMetadata(
  source: string,
): CommonToolsMetadata {
  const helperSet = new Set<string>();
  const aliasSet = new Set<string>();

  let match: RegExpExecArray | null;
  while ((match = ALIAS_PROPERTY_REGEX.exec(source)) !== null) {
    const [, aliasSuffix, property] = match;
    aliasSet.add(`commontools_${aliasSuffix}`);
    helperSet.add(property);
  }

  while ((match = BASE_ALIAS_PROPERTY_REGEX.exec(source)) !== null) {
    const [, property] = match;
    aliasSet.add("commontools");
    helperSet.add(property);
  }

  for (const exportName of KNOWN_COMMONTOOLS_EXPORTS) {
    const pattern = new RegExp(
      `\\b${exportName.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`,
    );
    if (pattern.test(source)) {
      helperSet.add(exportName);
    }
  }

  return {
    helpers: Array.from(helperSet).sort(),
    aliases: Array.from(aliasSet).sort(),
  };
}

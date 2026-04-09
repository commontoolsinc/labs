import type { JSONSchema } from "@commonfabric/api";
import { cliCommand } from "./cli-name.ts";

export interface ExecCommandSpec {
  callableKind: "handler" | "tool";
  defaultVerb: "invoke" | "run";
  inputSchema: JSONSchema;
  outputSchemaSummary?: JSONSchema;
}

export interface ParsedExecArgs {
  verb: "invoke" | "run";
  input: unknown;
  showHelp: boolean;
  showHelpJson: boolean;
  readJsonFromStdin: boolean;
  readTextFromStdin: boolean;
  inputFile?: {
    format: "json" | "text";
    path: string;
  };
  usedJsonInput: boolean;
}

export interface RenderExecHelpOptions {
  commandPrefix?: string;
  invocationStyle?: "cf" | "direct";
}

export interface ExecInputResolverDeps {
  readJsonInput?: () => Promise<unknown>;
  readTextInput?: () => Promise<string>;
  readTextFile?: (path: string) => Promise<string>;
  isStdinTerminal?: () => boolean;
}

export interface ResolvedExecInvocation {
  parsed: ParsedExecArgs;
  input?: unknown;
}

interface FlagDescriptor {
  key: string;
  flagName: string;
  schema: JSONSchema;
}

interface ParsedInputMode {
  input: unknown;
  readJsonFromStdin: boolean;
  readTextFromStdin: boolean;
  inputFile?: {
    format: "json" | "text";
    path: string;
  };
  usedJsonInput: boolean;
}

function isSchemaObject(schema: JSONSchema): schema is Record<string, unknown> {
  return typeof schema === "object" && schema !== null &&
    !Array.isArray(schema);
}

function objectProperties(
  schema: JSONSchema,
): Record<string, JSONSchema> | null {
  if (!isSchemaObject(schema)) return null;
  if (schema.type !== "object" && !schema.properties) return null;
  const properties = schema.properties;
  if (
    typeof properties !== "object" || properties === null ||
    Array.isArray(properties)
  ) {
    return {};
  }
  return properties as Record<string, JSONSchema>;
}

function requiredFlags(schema: JSONSchema): Set<string> {
  if (!isSchemaObject(schema) || !Array.isArray(schema.required)) {
    return new Set();
  }
  return new Set(schema.required as string[]);
}

function schemaType(schema: JSONSchema): string | undefined {
  return isSchemaObject(schema) ? schema.type as string | undefined : undefined;
}

function flagNameForKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function displayCommandPath(path: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(path) ? path : shellQuote(path);
}

function parseBoolean(value: string, flagName: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Invalid value for ${flagName}: expected true or false`);
}

function parseJson(value: string, flagName: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Invalid JSON for ${flagName}`);
  }
}

function parseInlineOrStdinJson(
  args: string[],
  index: number,
): { inlineValue?: string; consumeNext: boolean } {
  const candidate = args[index + 1];
  if (candidate === undefined) {
    return { consumeNext: false };
  }
  if (candidate.startsWith("--")) {
    throw new Error("--json cannot be combined with generated flags");
  }
  return { inlineValue: candidate, consumeNext: true };
}

function parseFilePathArg(
  args: string[],
  index: number,
  flagName: string,
): string {
  const candidate = args[index + 1];
  if (candidate === undefined || candidate.startsWith("--")) {
    throw new Error(`Missing value for ${flagName}`);
  }
  return candidate;
}

function validateEnum(
  value: unknown,
  schema: JSONSchema,
  flagName: string,
): void {
  if (!isSchemaObject(schema) || !Array.isArray(schema.enum)) return;
  if (!schema.enum.some((candidate) => Object.is(candidate, value))) {
    throw new Error(`Invalid value for ${flagName}`);
  }
}

function parseValueForSchema(
  rawValue: string,
  schema: JSONSchema,
  flagName: string,
): unknown {
  const type = schemaType(schema);

  if (type === "boolean") {
    const value = parseBoolean(rawValue, flagName);
    validateEnum(value, schema, flagName);
    return value;
  }

  if (type === "number" || type === "integer") {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) {
      throw new Error(`Invalid value for ${flagName}: expected ${type}`);
    }
    if (type === "integer" && !Number.isInteger(value)) {
      throw new Error(`Invalid value for ${flagName}: expected integer`);
    }
    validateEnum(value, schema, flagName);
    return value;
  }

  if (type === "array" || type === "object") {
    const value = parseJson(rawValue, flagName);
    if (type === "array" && !Array.isArray(value)) {
      throw new Error(`Invalid value for ${flagName}: expected array JSON`);
    }
    if (
      type === "object" &&
      (typeof value !== "object" || value === null || Array.isArray(value))
    ) {
      throw new Error(`Invalid value for ${flagName}: expected object JSON`);
    }
    validateEnum(value, schema, flagName);
    return value;
  }

  if (type === "null") {
    const value = parseJson(rawValue, flagName);
    if (value !== null) {
      throw new Error(`Invalid value for ${flagName}: expected null`);
    }
    return value;
  }

  validateEnum(rawValue, schema, flagName);
  return rawValue;
}

function parseObjectInput(
  schema: JSONSchema,
  args: string[],
): ParsedInputMode {
  const properties = objectProperties(schema) ?? {};
  const descriptors = new Map<string, FlagDescriptor>();
  for (const [key, propertySchema] of Object.entries(properties)) {
    const flagName = flagNameForKey(key);
    descriptors.set(flagName, { key, flagName, schema: propertySchema });
  }

  const input: Record<string, unknown> = {};
  let directJsonInput: unknown;
  let usedJson = false;
  let usedGeneratedFlags = false;
  let readJsonFromStdin = false;
  let inputFile: ParsedInputMode["inputFile"];

  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument ${token}`);
    }

    if (token === "--json") {
      if (usedGeneratedFlags) {
        throw new Error("--json cannot be combined with generated flags");
      }
      if (usedJson) {
        throw new Error("--json can only be provided once");
      }
      const { inlineValue, consumeNext } = parseInlineOrStdinJson(args, i);
      usedJson = true;
      if (inlineValue === undefined) {
        readJsonFromStdin = true;
        continue;
      }
      directJsonInput = parseJson(inlineValue, "--json");
      if (consumeNext) {
        i++;
      }
      continue;
    }

    if (token === "--json-file") {
      if (usedGeneratedFlags) {
        throw new Error("--json-file cannot be combined with generated flags");
      }
      if (usedJson) {
        throw new Error("--json can only be provided once");
      }
      usedJson = true;
      const filePath = parseFilePathArg(args, i, "--json-file");
      if (filePath === "-") {
        readJsonFromStdin = true;
      } else {
        inputFile = { format: "json", path: filePath };
      }
      i++;
      continue;
    }

    if (usedJson) {
      throw new Error("--json cannot be combined with generated flags");
    }

    const inlineSplit = token.slice(2).split("=", 2);
    const rawFlag = inlineSplit[0];
    const inlineValue = inlineSplit.length === 2 ? inlineSplit[1] : undefined;

    let negated = false;
    let descriptor = descriptors.get(rawFlag);
    if (!descriptor && rawFlag.startsWith("no-")) {
      descriptor = descriptors.get(rawFlag.slice(3));
      negated = descriptor !== undefined;
    }
    if (!descriptor) {
      throw new Error(`Unknown flag --${rawFlag}`);
    }

    const flagName = `--${descriptor.flagName}`;
    const type = schemaType(descriptor.schema);
    if (negated) {
      if (type !== "boolean") {
        throw new Error(`Unknown flag --${rawFlag}`);
      }
      input[descriptor.key] = false;
      usedGeneratedFlags = true;
      continue;
    }

    if (type === "boolean") {
      if (inlineValue !== undefined) {
        input[descriptor.key] = parseBoolean(inlineValue, flagName);
      } else {
        input[descriptor.key] = true;
      }
      usedGeneratedFlags = true;
      continue;
    }

    const rawValue = inlineValue ?? args[i + 1];
    if (rawValue === undefined) {
      throw new Error(`Missing value for ${flagName}`);
    }
    input[descriptor.key] = parseValueForSchema(
      rawValue,
      descriptor.schema,
      flagName,
    );
    usedGeneratedFlags = true;
    if (inlineValue === undefined) {
      i++;
    }
  }

  if (readJsonFromStdin) {
    return {
      input: undefined,
      readJsonFromStdin: true,
      readTextFromStdin: false,
      usedJsonInput: true,
    };
  }

  if (inputFile) {
    return {
      input: undefined,
      readJsonFromStdin: false,
      readTextFromStdin: false,
      inputFile,
      usedJsonInput: true,
    };
  }

  // Only enforce required fields for schema-derived flags.
  // JSON input validation is deferred to the runner.
  if (!usedJson) {
    for (const key of requiredFlags(schema)) {
      if (!(key in input)) {
        throw new Error(`Missing required flag --${flagNameForKey(key)}`);
      }
    }
  }

  return {
    input: usedJson ? directJsonInput : input,
    readJsonFromStdin: false,
    readTextFromStdin: false,
    usedJsonInput: usedJson,
  };
}

function parseNonObjectInput(
  schema: JSONSchema,
  args: string[],
): ParsedInputMode {
  if (args.length === 0) {
    return {
      input: undefined,
      readJsonFromStdin: false,
      readTextFromStdin: false,
      usedJsonInput: false,
    };
  }
  if (args.length > 2) {
    throw new Error(`Unexpected argument ${args[2]}`);
  }

  const [flag, rawValue] = args;
  if (
    flag !== "--value" && flag !== "--json" && flag !== "--value-file" &&
    flag !== "--json-file"
  ) {
    throw new Error(`Unknown flag ${flag}`);
  }
  if (flag === "--json" && rawValue === undefined) {
    return {
      input: undefined,
      readJsonFromStdin: true,
      readTextFromStdin: false,
      usedJsonInput: true,
    };
  }
  if (rawValue === undefined) {
    throw new Error(`Missing value for ${flag}`);
  }
  if (flag === "--json-file") {
    if (rawValue === "-") {
      return {
        input: undefined,
        readJsonFromStdin: true,
        readTextFromStdin: false,
        usedJsonInput: true,
      };
    }
    return {
      input: undefined,
      readJsonFromStdin: false,
      readTextFromStdin: false,
      inputFile: { format: "json", path: rawValue },
      usedJsonInput: true,
    };
  }
  if (flag === "--value-file") {
    if (rawValue === "-") {
      return {
        input: undefined,
        readJsonFromStdin: false,
        readTextFromStdin: true,
        usedJsonInput: false,
      };
    }
    return {
      input: undefined,
      readJsonFromStdin: false,
      readTextFromStdin: false,
      inputFile: { format: "text", path: rawValue },
      usedJsonInput: false,
    };
  }
  if (flag === "--json") {
    if (rawValue.startsWith("--")) {
      throw new Error("--json cannot be combined with generated flags");
    }
    return {
      input: parseJson(rawValue, flag),
      readJsonFromStdin: false,
      readTextFromStdin: false,
      usedJsonInput: true,
    };
  }
  return {
    input: parseValueForSchema(rawValue, schema, flag),
    readJsonFromStdin: false,
    readTextFromStdin: false,
    usedJsonInput: false,
  };
}

function hasHelpField(schema: JSONSchema): boolean {
  const properties = objectProperties(schema);
  return properties ? "help" in properties : false;
}

function isSchemaLessHandlerInput(schema: JSONSchema): boolean {
  if (schema === true) {
    return true;
  }
  if (!isSchemaObject(schema)) {
    return false;
  }
  if (schema.type !== undefined || schema.properties !== undefined) {
    return false;
  }
  return (schema.asStream === true ||
    (Array.isArray(schema.asCell) && schema.asCell.at(0) === "stream"));
}

export function normalizeCallableInputForExecution(
  spec: ExecCommandSpec,
  input: unknown,
): unknown {
  if (spec.callableKind !== "tool") {
    return input;
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return input;
  }

  const properties = objectProperties(spec.inputSchema);
  const helpSchema = properties?.help;
  if (!helpSchema || schemaType(helpSchema) !== "string") {
    return input;
  }
  if ("help" in (input as Record<string, unknown>)) {
    return input;
  }

  return {
    ...(input as Record<string, unknown>),
    help: "",
  };
}

async function defaultReadTextInput(): Promise<string> {
  return await new Response(Deno.stdin.readable).text();
}

async function defaultReadTextFile(path: string): Promise<string> {
  return await Deno.readTextFile(path);
}

function parseJsonText(text: string, source: string): unknown {
  if (text.trim().length === 0) {
    throw new Error(`Expected JSON from ${source}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from ${source}`);
  }
}

export async function resolveParsedExecInput(
  spec: ExecCommandSpec,
  parsed: ParsedExecArgs,
  deps: ExecInputResolverDeps = {},
): Promise<unknown> {
  if (parsed.readJsonFromStdin) {
    if (deps.readJsonInput) {
      return await deps.readJsonInput();
    }
    const text = await (deps.readTextInput ?? defaultReadTextInput)();
    return parseJsonText(text, "stdin for --json");
  }

  if (parsed.readTextFromStdin) {
    const text = await (deps.readTextInput ?? defaultReadTextInput)();
    return parseValueForSchema(text, spec.inputSchema, "--value-file");
  }

  if (parsed.inputFile) {
    const text = await (deps.readTextFile ?? defaultReadTextFile)(
      parsed.inputFile.path,
    );
    if (parsed.inputFile.format === "json") {
      return parseJsonText(
        text,
        `${parsed.inputFile.path} for --json-file`,
      );
    }
    return parseValueForSchema(text, spec.inputSchema, "--value-file");
  }

  return parsed.input;
}

async function resolveImplicitPipedHandlerInput(
  spec: ExecCommandSpec,
  rawArgs: string[],
  deps: ExecInputResolverDeps = {},
): Promise<ResolvedExecInvocation | null> {
  if (spec.callableKind !== "handler" || rawArgs.length > 0) {
    return null;
  }

  const isTerminal = deps.isStdinTerminal?.() ?? Deno.stdin.isTerminal();
  if (isTerminal) {
    return null;
  }

  const text = await (deps.readTextInput ?? defaultReadTextInput)();
  if (text.length === 0) {
    return null;
  }

  const properties = objectProperties(spec.inputSchema);
  const input = properties
    ? parseJsonText(text, "stdin")
    : parseValueForSchema(text, spec.inputSchema, "--value-file");

  return {
    parsed: {
      verb: spec.defaultVerb,
      input,
      showHelp: false,
      showHelpJson: false,
      readJsonFromStdin: false,
      readTextFromStdin: false,
      usedJsonInput: properties !== null,
    },
    input,
  };
}

export async function resolveExecInvocation(
  spec: ExecCommandSpec,
  rawArgs: string[],
  deps: ExecInputResolverDeps = {},
): Promise<ResolvedExecInvocation> {
  const implicit = await resolveImplicitPipedHandlerInput(spec, rawArgs, deps);
  if (implicit) {
    return implicit;
  }

  const parsed = parseExecArgs(spec, rawArgs);
  if (parsed.showHelp) {
    return { parsed };
  }

  return {
    parsed,
    input: await resolveParsedExecInput(spec, parsed, deps),
  };
}

function schemaDescription(schema: JSONSchema): string | undefined {
  return isSchemaObject(schema) && typeof schema.description === "string"
    ? schema.description
    : undefined;
}

function schemaEnumSummary(schema: JSONSchema): string | undefined {
  if (!isSchemaObject(schema) || !Array.isArray(schema.enum)) return undefined;
  return (schema.enum as unknown[]).map((value) => JSON.stringify(value)).join(
    " | ",
  );
}

function schemaDefaultSummary(schema: JSONSchema): string | undefined {
  if (!isSchemaObject(schema) || !("default" in schema)) return undefined;
  return JSON.stringify(schema.default);
}

function valuePlaceholder(schema: JSONSchema): string {
  const type = schemaType(schema);
  switch (type) {
    case "boolean":
      return "<boolean>";
    case "integer":
      return "<integer>";
    case "number":
      return "<number>";
    case "string":
      return "<string>";
    case "object":
      return "<json-object>";
    case "array":
      return "<json-array>";
    case "null":
      return "<null>";
    default:
      return "<json>";
  }
}

function primaryFlagUsage(flagName: string, schema: JSONSchema): string {
  const type = schemaType(schema);
  if (type === "boolean") {
    return `--${flagName}`;
  }
  return `--${flagName} ${valuePlaceholder(schema)}`;
}

function fullFlagUsage(flagName: string, schema: JSONSchema): string {
  const type = schemaType(schema);
  if (flagName === "help" && type === "boolean") {
    return "--help=<boolean> | --no-help";
  }
  if (type === "boolean") {
    return `--${flagName} | --no-${flagName}`;
  }
  return primaryFlagUsage(flagName, schema);
}

function specificFlagLines(schema: JSONSchema): string[] {
  if (isSchemaLessHandlerInput(schema)) {
    return [];
  }

  const properties = objectProperties(schema);
  if (!properties) {
    return [
      `  ${`--value ${valuePlaceholder(schema)}`.padEnd(20)}  Required.`,
      `  ${
        "--value-file <path>".padEnd(20)
      }  Read the value from a UTF-8 file. Use - for stdin.`,
    ];
  }

  const required = requiredFlags(schema);
  const descriptors = Object.entries(properties).map(
    ([key, propertySchema]) => {
      const flagName = flagNameForKey(key);
      const parts: string[] = [];
      if (key === "help") {
        parts.push('Optional input field named "help".');
      } else {
        parts.push(required.has(key) ? "Required." : "Optional.");
      }
      const type = schemaType(propertySchema);
      if (key === "help" && type === "boolean") {
        parts.push("Boolean. Use --help=true or --no-help.");
      } else if (type === "boolean") {
        parts.push(
          `Boolean. Use --${flagName} for true or --no-${flagName} for false.`,
        );
      }
      const enumSummary = schemaEnumSummary(propertySchema);
      if (enumSummary) {
        parts.push(`Allowed: ${enumSummary}.`);
      }
      const defaultSummary = schemaDefaultSummary(propertySchema);
      if (defaultSummary !== undefined) {
        parts.push(`Default: ${defaultSummary}.`);
      }
      const description = schemaDescription(propertySchema);
      if (description) {
        parts.push(description);
      }
      return {
        usage: fullFlagUsage(flagName, propertySchema),
        detail: parts.join(" "),
      };
    },
  );

  const maxUsage = descriptors.reduce(
    (width, descriptor) => Math.max(width, descriptor.usage.length),
    0,
  );

  return descriptors.map((descriptor) =>
    `  ${descriptor.usage.padEnd(maxUsage)}  ${descriptor.detail}`
  );
}

function genericFlagLines(schema: JSONSchema): string[] {
  const jsonLabel = "--json";
  const jsonDescription = objectProperties(schema)
    ? "Read the full input object from stdin. Cannot be combined with other input flags."
    : "Read the full input value as JSON from stdin. Cannot be combined with other input flags.";
  const descriptors = [
    { usage: jsonLabel, detail: jsonDescription },
    {
      usage: "--json-file <path>",
      detail: objectProperties(schema)
        ? "Read the full input object from a JSON file. Use - for stdin."
        : "Read the full input value as JSON from a file. Use - for stdin.",
    },
    { usage: "--help", detail: "Show this help." },
    { usage: "--help --json", detail: "Show full schema details as JSON." },
  ];
  const maxUsage = descriptors.reduce(
    (width, descriptor) => Math.max(width, descriptor.usage.length),
    0,
  );

  return descriptors.map((descriptor) =>
    `  ${descriptor.usage.padEnd(maxUsage)}  ${descriptor.detail}`
  );
}

function outputPropertyLines(schema: JSONSchema): string[] {
  const properties = objectProperties(schema);
  if (!properties || Object.keys(properties).length === 0) {
    return ["  JSON on success."];
  }

  return [
    "  JSON on success:",
    ...Object.entries(properties).map(([key, propertySchema]) =>
      `    ${key} ${valuePlaceholder(propertySchema)}`
    ),
  ];
}

function usageCommandPrefix(
  mountedFilePath: string,
  invocationStyle: "cf" | "direct",
  commandPrefix?: string,
): string {
  if (commandPrefix) {
    return commandPrefix;
  }
  const displayedPath = displayCommandPath(mountedFilePath);
  return invocationStyle === "direct"
    ? displayedPath
    : cliCommand(["exec", displayedPath]);
}

function optionalVerbUsage(spec: ExecCommandSpec): string {
  return `[${spec.defaultVerb}]`;
}

function usageLine(
  mountedFilePath: string,
  spec: ExecCommandSpec,
  invocationStyle: "cf" | "direct",
  commandPrefix?: string,
): string {
  const prefix = usageCommandPrefix(
    mountedFilePath,
    invocationStyle,
    commandPrefix,
  );
  const verb = optionalVerbUsage(spec);
  const properties = objectProperties(spec.inputSchema);

  if (!properties) {
    return `${prefix} ${verb} --value ${valuePlaceholder(spec.inputSchema)}`;
  }

  const required = requiredFlags(spec.inputSchema);
  const requiredUsages = Object.entries(properties)
    .filter(([key]) => required.has(key))
    .map(([key, propertySchema]) =>
      primaryFlagUsage(flagNameForKey(key), propertySchema)
    );
  if (
    spec.callableKind === "handler" &&
    handlerAllowsInvokeWithoutInputs(spec.inputSchema) &&
    requiredUsages.length === 0
  ) {
    return `${prefix} ${spec.defaultVerb}`;
  }
  const suffix = requiredUsages.length > 0
    ? ` ${requiredUsages.join(" ")}`
    : "";
  return `${prefix} ${verb}${suffix}`;
}

function helpUsageLines(
  mountedFilePath: string,
  spec: ExecCommandSpec,
  invocationStyle: "cf" | "direct",
  commandPrefix?: string,
): string[] {
  const prefix = usageCommandPrefix(
    mountedFilePath,
    invocationStyle,
    commandPrefix,
  );
  const verb = optionalVerbUsage(spec);
  const properties = objectProperties(spec.inputSchema);
  return [
    `  ${usageLine(mountedFilePath, spec, invocationStyle, commandPrefix)}`,
    ...(!properties ? [`  ${prefix} ${verb} --value-file <path>`] : []),
    `  ${prefix} ${verb} --json`,
    `  ${prefix} ${verb} --json-file <path>`,
    `  ${prefix} ${verb} --help`,
    `  ${prefix} ${verb} --help --json`,
  ];
}

function handlerAllowsInvokeWithoutInputs(schema: JSONSchema): boolean {
  if (isSchemaLessHandlerInput(schema)) {
    return true;
  }
  const properties = objectProperties(schema);
  return properties !== null && requiredFlags(schema).size === 0;
}

export function parseExecArgs(
  spec: ExecCommandSpec,
  rawArgs: string[],
): ParsedExecArgs {
  const args = [...rawArgs];
  let verb = spec.defaultVerb;
  const helpField = hasHelpField(spec.inputSchema);
  let explicitVerb = false;

  if (rawArgs[0] === "--help") {
    if (rawArgs.length === 1) {
      return {
        verb,
        input: {},
        showHelp: true,
        showHelpJson: false,
        readJsonFromStdin: false,
        readTextFromStdin: false,
        usedJsonInput: false,
      };
    }
    if (rawArgs.length === 2 && rawArgs[1] === "--json") {
      return {
        verb,
        input: {},
        showHelp: true,
        showHelpJson: true,
        readJsonFromStdin: false,
        readTextFromStdin: false,
        usedJsonInput: false,
      };
    }
    if (!helpField) {
      throw new Error("Unknown flag --help");
    }
  }

  if (args[0] === "invoke" || args[0] === "run") {
    if (args[0] !== spec.defaultVerb) {
      throw new Error(
        `Invalid verb ${
          args[0]
        } for ${spec.callableKind}; use ${spec.defaultVerb}`,
      );
    }
    verb = args.shift() as "invoke" | "run";
    explicitVerb = true;
  }

  if (args[0] === "--help") {
    if (args.length === 1) {
      return {
        verb,
        input: {},
        showHelp: true,
        showHelpJson: false,
        readJsonFromStdin: false,
        readTextFromStdin: false,
        usedJsonInput: false,
      };
    }
    if (args.length === 2 && args[1] === "--json") {
      return {
        verb,
        input: {},
        showHelp: true,
        showHelpJson: true,
        readJsonFromStdin: false,
        readTextFromStdin: false,
        usedJsonInput: false,
      };
    }
    if (!helpField) {
      throw new Error("Unknown flag --help");
    }
  }

  if (
    spec.callableKind === "handler" && !explicitVerb && args.length === 0 &&
    !handlerAllowsInvokeWithoutInputs(spec.inputSchema)
  ) {
    const typeShape = schemaShapeString(spec.inputSchema);
    throw new Error(
      `Handler requires input. Expected type: ${typeShape}\nRun --help for full usage.`,
    );
  }

  const properties = objectProperties(spec.inputSchema);
  const parsedInput = properties
    ? parseObjectInput(spec.inputSchema, args)
    : parseNonObjectInput(spec.inputSchema, args);

  return {
    verb,
    input:
      properties && !parsedInput.readJsonFromStdin && !parsedInput.inputFile &&
        !parsedInput.usedJsonInput
        ? parsedInput.input ?? {}
        : parsedInput.input,
    showHelp: false,
    showHelpJson: false,
    readJsonFromStdin: parsedInput.readJsonFromStdin,
    readTextFromStdin: parsedInput.readTextFromStdin,
    inputFile: parsedInput.inputFile,
    usedJsonInput: parsedInput.usedJsonInput,
  };
}

export function renderExecHelpJson(spec: ExecCommandSpec): string {
  const value: Record<string, unknown> = {
    callableKind: spec.callableKind,
    inputSchema: spec.inputSchema,
  };
  if (spec.outputSchemaSummary !== undefined) {
    value.outputSchema = spec.outputSchemaSummary;
  }
  return JSON.stringify(value, null, 2);
}

export function renderExecHelp(
  mountedFilePath: string,
  spec: ExecCommandSpec,
  options: RenderExecHelpOptions = {},
): string {
  const commandPrefix = options.commandPrefix;
  const invocationStyle = options.invocationStyle ?? "cf";
  const specificFlags = specificFlagLines(spec.inputSchema);
  const genericFlags = genericFlagLines(spec.inputSchema);
  const typeShape = schemaShapeString(spec.inputSchema);

  const lines = [
    "Usage:",
    ...helpUsageLines(mountedFilePath, spec, invocationStyle, commandPrefix),
    "",
    "Input type:",
    ...typeShape.split("\n").map((line) => `  ${line}`),
    "",
    "Flags:",
    ...specificFlags,
    ...(specificFlags.length > 0 ? [""] : []),
    ...genericFlags,
  ];

  if (spec.callableKind === "handler") {
    lines.push("");
    lines.push("Output:");
    lines.push("  No output on success.");
    lines.push("");
    lines.push("Alternatively, write JSON to this file to invoke the handler.");
    if (handlerAllowsInvokeWithoutInputs(spec.inputSchema)) {
      lines.push("Invoke alone will call the handler without any inputs.");
    }
  } else if (spec.outputSchemaSummary !== undefined) {
    lines.push("");
    lines.push("Output:");
    lines.push(...outputPropertyLines(spec.outputSchemaSummary));
  } else if (spec.callableKind === "tool") {
    lines.push("");
    lines.push("Output:");
    lines.push("  JSON on success.");
  }

  return lines.join("\n");
}

function schemaShapeString(
  schema: JSONSchema,
  depth = 0,
): string {
  if (isSchemaLessHandlerInput(schema)) {
    return "void";
  }

  if (depth >= 4) {
    return "{...}";
  }

  if (!isSchemaObject(schema)) {
    return "unknown";
  }

  if (Array.isArray(schema.enum)) {
    return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  }

  const unionSchemas = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
    ? schema.oneOf
    : null;
  if (unionSchemas) {
    return unionSchemas.map((variant) =>
      schemaShapeString(variant as JSONSchema, depth + 1)
    ).join(" | ");
  }

  const type = schemaType(schema);
  if (type === "string") return "string";
  if (type === "number" || type === "integer") return "number";
  if (type === "boolean") return "boolean";
  if (type === "null") return "null";

  if (type === "array") {
    // We don't handle tuples here (prefixItems)
    const items = isSchemaObject(schema)
      ? schema.items as JSONSchema
      : undefined;
    return `${items ? schemaShapeString(items, depth + 1) : "unknown"}[]`;
  }

  const properties = objectProperties(schema);
  if (!properties) {
    return "unknown";
  }

  const keys = Object.keys(properties).filter((key) => !key.startsWith("$"));
  if (keys.length === 0) {
    return "{}";
  }

  const required = requiredFlags(schema);
  const lines = keys.map((key) => {
    const propSchema = properties[key];
    return `${"  ".repeat(depth + 1)}${key}${required.has(key) ? "" : "?"}: ${
      schemaShapeString(propSchema, depth + 1)
    }`;
  });

  return `{\n${lines.join("\n")}\n${"  ".repeat(depth)}}`;
}

function pieceJsonUsageLine(commandPrefix: string): string {
  return `${commandPrefix} <json>`;
}

function pieceFlagUsageLine(
  commandPrefix: string,
  spec: ExecCommandSpec,
): string {
  return usageLine(commandPrefix, spec, "cf", `${commandPrefix} --`);
}

function pieceUsageLines(
  commandPrefix: string,
  spec: ExecCommandSpec,
): string[] {
  const properties = objectProperties(spec.inputSchema);
  return [
    `  ${commandPrefix} --help`,
    `  ${commandPrefix} --help --json`,
    ...(spec.callableKind === "handler" &&
        handlerAllowsInvokeWithoutInputs(spec.inputSchema)
      ? [`  ${commandPrefix}`, `  ${commandPrefix} -- invoke`]
      : []),
    `  ${pieceJsonUsageLine(commandPrefix)}`,
    `  ${commandPrefix} -- --json-file <path>`,
    `  ${pieceFlagUsageLine(commandPrefix, spec)}`,
    ...(!properties ? [`  ${commandPrefix} -- --value-file <path>`] : []),
  ];
}

function pieceJsonInputLines(schema: JSONSchema): string[] {
  return [
    "  Pass inline JSON as the next argument, use `-- --json-file <path>`, or pipe JSON on stdin with `-- --json`.",
    ...schemaShapeString(schema).split("\n").map((line) => `  ${line}`),
  ];
}

export function renderPieceCallHelp(
  commandPrefix: string,
  spec: ExecCommandSpec,
): string {
  const specificFlags = specificFlagLines(spec.inputSchema);
  const lines = [
    "Usage:",
    ...pieceUsageLines(commandPrefix, spec),
    "",
    "JSON input:",
    ...pieceJsonInputLines(spec.inputSchema),
  ];

  if (specificFlags.length > 0) {
    lines.push("");
    lines.push("Flags after `--`:");
    lines.push(...specificFlags);
  }

  if (spec.callableKind === "handler") {
    lines.push("");
    lines.push("Output:");
    lines.push("  No output on success.");
    lines.push("");
    lines.push("Alternatively, write JSON to this file to invoke the handler.");
    if (handlerAllowsInvokeWithoutInputs(spec.inputSchema)) {
      lines.push("Invoke alone will call the handler without any inputs.");
    }
  } else if (spec.outputSchemaSummary !== undefined) {
    lines.push("");
    lines.push("Output:");
    lines.push(...outputPropertyLines(spec.outputSchemaSummary));
  } else if (spec.callableKind === "tool") {
    lines.push("");
    lines.push("Output:");
    lines.push("  JSON on success.");
  }

  return lines.join("\n");
}

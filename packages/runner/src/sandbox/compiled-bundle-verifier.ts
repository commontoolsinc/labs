import {
  collectIdentifierTokens,
  CompiledJsParseError,
  containsDynamicImport,
  findTopLevelEquals,
  locationFromOffset,
  parseCompiledBundleSource,
  type ParsedDefineCall,
  parseFunctionText,
  splitTopLevelCommaList,
  type StatementChunk,
  stripJsTrivia,
  stripWholeParentheses,
  trimRange,
  tryParseCallExpression,
} from "./compiled-js-parser.ts";
import { ModuleVerificationError } from "./module-verification-error.ts";
import {
  isAllowedCompiledDependencySpecifier,
  isRuntimeModuleIdentifier,
} from "./runtime-module-policy.ts";

type BindingKind = "builder" | "data" | "function" | "import" | "unknown";

interface BindingInfo {
  kind: BindingKind;
  trustedRuntimeName?: string;
  namespaceImport?: boolean;
  hardeningHelper?: boolean;
  captureSafe?: boolean;
  functionRange?: { start: number; end: number };
}

const TRUSTED_BUILDERS = new Set([
  "action",
  "computed",
  "derive",
  "handler",
  "lift",
  "pattern",
]);

const TRUSTED_DATA_HELPERS = new Set([
  "__ct_data",
  "nonPrivateRandom",
  "safeDateNow",
  "schema",
]);

const CANONICAL_HARDENING_HELPER = stripJsTrivia(
  `function __ctHardenFn(fn) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
      Object.freeze(prototype);
    }
    return fn;
  }`,
);

const SIMPLE_IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;
const SAFE_GLOBAL_IDENTIFIERS = new Set([
  "Array",
  "BigInt",
  "Boolean",
  "Date",
  "Error",
  "Headers",
  "Infinity",
  "JSON",
  "Map",
  "Math",
  "NaN",
  "Number",
  "Object",
  "Promise",
  "Request",
  "RegExp",
  "Response",
  "Set",
  "String",
  "Symbol",
  "TextDecoder",
  "TextEncoder",
  "Uint8Array",
  "URL",
  "URLSearchParams",
  "atob",
  "btoa",
  "console",
  "decodeURIComponent",
  "encodeURIComponent",
  "fetch",
  "globalThis",
  "isFinite",
  "isNaN",
  "parseFloat",
  "parseInt",
  "structuredClone",
  "undefined",
]);
const RESERVED_IDENTIFIERS = new Set([
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);
const DECLARATION_KEYWORDS = new Set([
  "const",
  "let",
  "var",
  "function",
  "class",
  "catch",
]);

export function verifyCompiledBundleModuleFactoriesWithParser(
  source: string,
  filename = "<bundle>",
): void {
  try {
    const bundle = parseCompiledBundleSource(source);
    const compiledModuleIds = new Set(
      bundle.defineCalls.map(({ moduleId }) => moduleId),
    );

    for (const defineCall of bundle.defineCalls) {
      verifyDefineCall(source, filename, defineCall, compiledModuleIds);
    }
  } catch (error) {
    if (error instanceof ModuleVerificationError) {
      throw error;
    }
    if (error instanceof CompiledJsParseError) {
      throw verificationErrorAt(
        source,
        filename,
        error.offset,
        error.message,
      );
    }
    throw error;
  }
}

function verifyDefineCall(
  source: string,
  filename: string,
  defineCall: ParsedDefineCall,
  compiledModuleIds: ReadonlySet<string>,
): void {
  for (const dependency of defineCall.dependencies) {
    if (
      !isAllowedCompiledDependencySpecifier(dependency) &&
      !compiledModuleIds.has(dependency)
    ) {
      throw verificationErrorAt(
        source,
        filename,
        defineCall.statement.start,
        `Compiled AMD dependency '${dependency}' is not allowed in SES mode`,
      );
    }
  }

  if (defineCall.moduleId === "index") {
    verifyIndexFactory(source, filename, defineCall);
    return;
  }

  verifyAuthoredFactory(source, filename, defineCall);
}

function verifyAuthoredFactory(
  source: string,
  filename: string,
  defineCall: ParsedDefineCall,
): void {
  if (
    containsDynamicImport(
      source,
      defineCall.factory.body.start,
      defineCall.factory.body.end,
    )
  ) {
    throw verificationErrorAt(
      source,
      filename,
      defineCall.factory.start,
      "Dynamic import() is not allowed in SES mode",
    );
  }

  const env = new Map<string, BindingInfo>();
  predeclareFactoryDependencies(defineCall, env);
  predeclareTopLevelBindings(source, defineCall, env);

  for (const statement of defineCall.factory.body.statements) {
    if (isStringDirective(statement.text)) continue;
    if (isCompiledEsModuleMarker(statement.text)) continue;
    if (isCompiledImportNormalizationRebinding(statement.text, env)) continue;

    const reexport = tryParseCompiledReexport(statement.text);
    if (reexport) {
      if (reexport.exportedName === "__esModule") {
        continue;
      }
      if (reexport.exportedName !== "default") {
        const binding = classifyReferenceText(
          source,
          filename,
          statement.start,
          reexport.target,
          env,
        );
        if (binding.kind !== "import") {
          throw verificationErrorAt(
            source,
            filename,
            statement.start,
            "Compiled reexport getters must return imported bindings",
          );
        }
        env.set(reexport.exportedName, cloneBindingInfo(binding));
      }
      continue;
    }

    if (isCompiledExportStarStatement(statement.text)) continue;

    if (isCompiledExportAssignment(statement.text)) {
      verifyCompiledExportAssignment(source, filename, statement, env);
      continue;
    }

    if (isFunctionDeclarationStatement(statement.text)) {
      registerFunctionStatement(statement, env);
      continue;
    }

    if (isClassDeclarationStatement(statement.text)) {
      throw verificationErrorAt(
        source,
        filename,
        statement.start,
        "Top-level class declarations are not allowed in SES mode",
      );
    }

    if (isVariableStatement(statement.text)) {
      verifyVariableStatement(source, filename, statement, env);
      continue;
    }

    if (isAllowedFunctionHardeningStatement(statement.text, env)) {
      continue;
    }

    throw verificationErrorAt(
      source,
      filename,
      statement.start,
      "Compiled AMD module contains unsupported top-level executable code",
    );
  }
}

function verifyIndexFactory(
  source: string,
  filename: string,
  defineCall: ParsedDefineCall,
): void {
  for (const statement of defineCall.factory.body.statements) {
    if (isStringDirective(statement.text)) continue;
    if (isCompiledEsModuleMarker(statement.text)) continue;
    if (isCompiledExportStarStatement(statement.text)) continue;
    if (isCompiledExportAssignment(statement.text)) continue;
    if (tryParseCompiledReexport(statement.text)) continue;

    throw verificationErrorAt(
      source,
      filename,
      statement.start,
      "Compiled index module contains unsupported top-level executable code",
    );
  }
}

function predeclareFactoryDependencies(
  defineCall: ParsedDefineCall,
  env: Map<string, BindingInfo>,
): void {
  for (
    let index = 0;
    index < Math.min(
      defineCall.factory.params.length,
      defineCall.dependencies.length,
    );
    index++
  ) {
    const parameter = defineCall.factory.params[index];
    const dependency = defineCall.dependencies[index];
    env.set(parameter, {
      kind: "import",
      namespaceImport: true,
      trustedRuntimeName: isRuntimeModuleIdentifier(dependency)
        ? dependency
        : undefined,
    });
  }
}

function predeclareTopLevelBindings(
  source: string,
  defineCall: ParsedDefineCall,
  env: Map<string, BindingInfo>,
): void {
  for (const statement of defineCall.factory.body.statements) {
    if (isFunctionDeclarationStatement(statement.text)) {
      const name = getFunctionDeclarationName(statement.text);
      if (name) {
        env.set(name, {
          kind: "function",
          captureSafe: isJsxHelperWrapperDeclaration(statement.text),
          hardeningHelper: isFunctionHardeningHelperDeclaration(statement.text),
          functionRange: { start: statement.start, end: statement.end },
        });
      }
      continue;
    }

    if (!isVariableStatement(statement.text)) continue;
    for (const { name } of parseVariableDeclarators(source, statement)) {
      if (!env.has(name)) {
        env.set(name, { kind: "unknown" });
      }
    }
  }
}

function verifyVariableStatement(
  source: string,
  filename: string,
  statement: StatementChunk,
  env: Map<string, BindingInfo>,
): void {
  const kind = getVariableStatementKind(statement.text);
  if (kind !== "const") {
    throw verificationErrorAt(
      source,
      filename,
      statement.start,
      "Top-level mutable bindings are not allowed in SES mode",
    );
  }

  for (const declarator of parseVariableDeclarators(source, statement)) {
    const binding = classifyExpressionText(
      source,
      filename,
      declarator.initializer.start,
      declarator.initializer.end,
      env,
    );
    env.set(declarator.name, binding);
  }
}

function verifyCompiledExportAssignment(
  source: string,
  filename: string,
  statement: StatementChunk,
  env: Map<string, BindingInfo>,
): void {
  const chain = parseExportAssignmentChain(source, statement);
  if (chain.valueIsVoidZero) {
    for (const name of chain.exportedNames) {
      env.set(name, { kind: "unknown" });
    }
    return;
  }

  const binding = classifyExpressionText(
    source,
    filename,
    chain.value.start,
    chain.value.end,
    env,
  );
  for (const name of chain.exportedNames) {
    env.set(name, cloneBindingInfo(binding));
  }
}

function classifyExpressionText(
  source: string,
  filename: string,
  start: number,
  end: number,
  env: Map<string, BindingInfo>,
): BindingInfo {
  const trimmed = trimRange(source, start, end);
  const inner = stripWholeParentheses(source, trimmed.start, trimmed.end);
  const text = source.slice(inner.start, inner.end);
  const normalized = stripJsTrivia(text);

  if (isPrimitiveLikeExpression(normalized) || normalized === "void0") {
    return { kind: "data", captureSafe: true };
  }

  if (isRawMutableExpression(normalized)) {
    throw verificationErrorAt(
      source,
      filename,
      inner.start,
      "Mutable top-level data must be wrapped in __ct_data() in SES mode",
    );
  }

  if (isIifeExpression(normalized)) {
    throw verificationErrorAt(
      source,
      filename,
      inner.start,
      "Only trusted builder calls, schema(), and canonical function hardening are allowed at module scope in SES mode",
    );
  }

  const directFunction = tryParseDirectFunction(source, inner.start, inner.end);
  if (directFunction) {
    return {
      kind: "function",
      functionRange: { start: directFunction.start, end: directFunction.end },
    };
  }

  const call = tryParseCallExpression(source, inner.start, inner.end);
  if (call) {
    const normalizedCallee = stripJsTrivia(call.callee);
    if (normalizedCallee === "require") {
      throw verificationErrorAt(
        source,
        filename,
        call.start,
        "Authored AMD require() is not allowed in SES mode",
      );
    }

    const trustedCall = resolveTrustedCallName(normalizedCallee, env);
    if (trustedCall) {
      if (TRUSTED_BUILDERS.has(trustedCall)) {
        verifyTrustedBuilderCall(
          source,
          filename,
          trustedCall,
          call.args,
          env,
        );
        return { kind: "builder", captureSafe: true };
      }
      verifyTrustedDataCall(
        source,
        filename,
        call.start,
        trustedCall,
        call.args.length,
      );
      return {
        kind: "data",
        captureSafe: trustedCall !== "schema",
      };
    }

    const hardeningBinding = env.get(normalizedCallee);
    if (hardeningBinding?.hardeningHelper) {
      if (call.args.length !== 1) {
        throw verificationErrorAt(
          source,
          filename,
          call.start,
          "Function hardening helpers accept exactly one argument",
        );
      }
      const argBinding = classifyExpressionText(
        source,
        filename,
        call.args[0].start,
        call.args[0].end,
        env,
      );
      if (argBinding.kind !== "function") {
        throw verificationErrorAt(
          source,
          filename,
          call.args[0].start,
          "Function hardening must target direct function values",
        );
      }
      return cloneBindingInfo(argBinding);
    }

    if (isLocalCallableExpression(normalizedCallee, env)) {
      verifyLocalTopLevelCall(source, filename, call.args, env);
      return {
        kind: "data",
        captureSafe: false,
      };
    }

    throw verificationErrorAt(
      source,
      filename,
      call.start,
      "Only trusted builder calls, schema(), and canonical function hardening are allowed at module scope in SES mode",
    );
  }

  if (SIMPLE_IDENTIFIER_RE.test(text)) {
    if (text === "undefined" || text === "NaN" || text === "Infinity") {
      return { kind: "data", captureSafe: true };
    }
    const binding = env.get(text);
    if (!binding || binding.kind === "unknown") {
      throw verificationErrorAt(
        source,
        filename,
        inner.start,
        `Unknown top-level identifier '${text}' in SES mode`,
      );
    }
    return cloneBindingInfo(binding);
  }

  return classifyReferenceText(source, filename, inner.start, text, env);
}

function classifyReferenceText(
  source: string,
  filename: string,
  offset: number,
  text: string,
  env: Map<string, BindingInfo>,
): BindingInfo {
  const ref = parseMemberReference(text);
  if (!ref) {
    throw verificationErrorAt(
      source,
      filename,
      offset,
      "Top-level value is not allowed in SES mode",
    );
  }

  if (ref.root === "exports" && ref.property) {
    const binding = env.get(ref.property);
    if (!binding || binding.kind === "unknown") {
      throw verificationErrorAt(
        source,
        filename,
        offset,
        `Unknown exported binding '${ref.property}' in SES mode`,
      );
    }
    return cloneBindingInfo(binding);
  }

  const binding = env.get(ref.root);
  if (!binding || binding.kind === "unknown") {
    throw verificationErrorAt(
      source,
      filename,
      offset,
      `Unknown top-level identifier '${ref.root}' in SES mode`,
    );
  }
  return cloneBindingInfo(binding);
}

function verifyTrustedDataCall(
  source: string,
  filename: string,
  offset: number,
  trustedName: string,
  argCount: number,
): void {
  if (trustedName === "__ct_data" && argCount === 1) {
    return;
  }

  if (
    (trustedName === "safeDateNow" || trustedName === "nonPrivateRandom") &&
    argCount === 0
  ) {
    return;
  }

  if (trustedName === "schema" && argCount >= 1) {
    return;
  }

  throw verificationErrorAt(
    source,
    filename,
    offset,
    `Trusted helper '${trustedName}' received an unsupported argument shape`,
  );
}

function verifyTrustedBuilderCall(
  source: string,
  filename: string,
  builderName: string,
  args: Array<{ start: number; end: number }>,
  env: Map<string, BindingInfo>,
): void {
  const callbackIndexes = callbackIndexesForBuilder(
    source,
    builderName,
    args,
    env,
  );
  if (callbackIndexes.length === 0) {
    throw verificationErrorAt(
      source,
      filename,
      args[0]?.start ?? 0,
      `Trusted builder '${builderName}' must receive a direct callback in SES mode`,
    );
  }

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (callbackIndexes.includes(index)) {
      const callback = resolveTrustedBuilderCallback(source, argument, env);
      if (!callback) {
        throw verificationErrorAt(
          source,
          filename,
          argument.start,
          `Trusted builder '${builderName}' must receive a direct callback, not an indirect reference`,
        );
      }
      rejectUnsafeCaptures(
        source,
        filename,
        callback.start,
        callback.end,
        argument.start,
        env,
      );
      continue;
    }
    verifyTrustedValueExpression(
      source,
      filename,
      argument.start,
      argument.end,
      env,
    );
  }
}

function callbackIndexesForBuilder(
  source: string,
  builderName: string,
  args: Array<{ start: number; end: number }>,
  env: Map<string, BindingInfo>,
): number[] {
  switch (builderName) {
    case "pattern":
    case "action":
    case "computed":
      return args.length >= 1 ? [0] : [];
    case "lift":
      return args.length >= 3 ? [2] : args.length >= 1 ? [0] : [];
    case "handler":
      if (
        args.length >= 1 &&
        !!resolveTrustedBuilderCallback(source, args[0], env)
      ) {
        return [0];
      }
      return args.length >= 3 ? [2] : [];
    case "derive":
      return args.length >= 4 ? [3] : args.length >= 2 ? [1] : [];
    default:
      return [];
  }
}

function verifyLocalTopLevelCall(
  source: string,
  filename: string,
  args: Array<{ start: number; end: number }>,
  env: Map<string, BindingInfo>,
): void {
  for (const argument of args) {
    verifyTrustedValueExpression(
      source,
      filename,
      argument.start,
      argument.end,
      env,
    );
  }
}

function verifyTrustedValueExpression(
  source: string,
  filename: string,
  start: number,
  end: number,
  env: Map<string, BindingInfo>,
): void {
  const trimmed = trimRange(source, start, end);
  const inner = stripWholeParentheses(source, trimmed.start, trimmed.end);
  const text = source.slice(inner.start, inner.end);
  const normalized = stripJsTrivia(text);

  if (
    isPrimitiveLikeExpression(normalized) ||
    normalized === "void0" ||
    isRegexLiteral(normalized) ||
    normalized.startsWith("{") ||
    normalized.startsWith("[")
  ) {
    return;
  }

  if (SIMPLE_IDENTIFIER_RE.test(text)) {
    if (SAFE_GLOBAL_IDENTIFIERS.has(text)) {
      return;
    }
    const binding = env.get(text);
    if (!binding || binding.kind === "unknown") {
      throw verificationErrorAt(
        source,
        filename,
        inner.start,
        `Unknown identifier '${text}' in SES-verified module scope`,
      );
    }
    return;
  }

  if (parseMemberReference(text)) {
    classifyReferenceText(source, filename, inner.start, text, env);
    return;
  }

  const call = tryParseCallExpression(source, inner.start, inner.end);
  if (call) {
    const trustedName = resolveTrustedCallName(stripJsTrivia(call.callee), env);
    if (trustedName) {
      verifyTrustedDataCall(
        source,
        filename,
        call.start,
        trustedName,
        call.args.length,
      );
      return;
    }
  }

  throw verificationErrorAt(
    source,
    filename,
    inner.start,
    "Only verified plain data and references to verified top-level bindings are allowed here in SES mode",
  );
}

function isLocalCallableExpression(
  normalizedCallee: string,
  env: Map<string, BindingInfo>,
): boolean {
  if (SIMPLE_IDENTIFIER_RE.test(normalizedCallee)) {
    const binding = env.get(normalizedCallee);
    return !!binding &&
      (
        binding.kind === "function" ||
        (binding.kind === "import" && !binding.trustedRuntimeName)
      );
  }

  const commaCall = normalizedCallee.match(
    /^\(0,([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\)$/,
  );
  if (commaCall) {
    const binding = env.get(commaCall[1]);
    return !!binding && binding.kind === "import" &&
      !binding.trustedRuntimeName;
  }

  const memberCall = normalizedCallee.match(
    /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/,
  );
  if (memberCall) {
    const binding = env.get(memberCall[1]);
    return !!binding && binding.kind === "import" &&
      !binding.trustedRuntimeName;
  }

  return false;
}

function resolveTrustedBuilderCallback(
  source: string,
  argument: { start: number; end: number },
  env: Map<string, BindingInfo>,
): { start: number; end: number } | undefined {
  const trimmed = trimRange(source, argument.start, argument.end);
  const inner = stripWholeParentheses(source, trimmed.start, trimmed.end);
  const directFunction = tryParseDirectFunction(source, inner.start, inner.end);
  if (directFunction) {
    return { start: directFunction.start, end: directFunction.end };
  }

  const text = source.slice(inner.start, inner.end);
  if (!SIMPLE_IDENTIFIER_RE.test(text)) {
    return undefined;
  }

  const binding = env.get(text);
  if (
    binding?.kind !== "function" || !binding.functionRange ||
    binding.hardeningHelper
  ) {
    return undefined;
  }

  return binding.functionRange;
}

function rejectUnsafeCaptures(
  source: string,
  filename: string,
  fnStart: number,
  fnEnd: number,
  errorOffset: number,
  env: Map<string, BindingInfo>,
): void {
  const unsafe = findUnsafeCapture(
    source,
    fnStart,
    fnEnd,
    env,
    new Set(),
  );
  if (!unsafe) {
    return;
  }

  throw verificationErrorAt(
    source,
    filename,
    errorOffset,
    unsafe.message,
  );
}

function findUnsafeCapture(
  source: string,
  fnStart: number,
  fnEnd: number,
  env: Map<string, BindingInfo>,
  visiting: Set<string>,
): { identifier: string; message: string } | undefined {
  const freeIdentifiers = collectFreeIdentifiers(source, fnStart, fnEnd);
  for (const identifier of freeIdentifiers) {
    if (SAFE_GLOBAL_IDENTIFIERS.has(identifier)) {
      continue;
    }

    const binding = env.get(identifier);
    if (!binding || binding.kind === "unknown") {
      return {
        identifier,
        message:
          `Callback captures unknown top-level identifier '${identifier}' in SES mode`,
      };
    }

    if (
      binding.kind === "data" &&
      !isBindingCaptureSafe(source, identifier, env, visiting)
    ) {
      return {
        identifier,
        message:
          `Callback captures top-level data binding '${identifier}', which is disallowed in SES mode`,
      };
    }

    if (
      binding.kind === "function" &&
      !isBindingCaptureSafe(source, identifier, env, visiting)
    ) {
      return {
        identifier,
        message:
          `Callback captures top-level function binding '${identifier}', which closes over unsafe state in SES mode`,
      };
    }
  }

  return undefined;
}

function isBindingCaptureSafe(
  source: string,
  identifier: string,
  env: Map<string, BindingInfo>,
  visiting: Set<string>,
): boolean {
  const binding = env.get(identifier);
  if (!binding) {
    return false;
  }

  if (binding.kind === "import" || binding.kind === "builder") {
    return true;
  }

  if (binding.kind === "data") {
    return binding.captureSafe ?? false;
  }

  if (binding.kind !== "function" || !binding.functionRange) {
    return false;
  }

  if (binding.captureSafe !== undefined) {
    return binding.captureSafe;
  }

  if (visiting.has(identifier)) {
    return true;
  }

  visiting.add(identifier);
  const unsafe = findUnsafeCapture(
    source,
    binding.functionRange.start,
    binding.functionRange.end,
    env,
    visiting,
  );
  visiting.delete(identifier);
  binding.captureSafe = !unsafe;
  return binding.captureSafe;
}

function collectFreeIdentifiers(
  source: string,
  fnStart: number,
  fnEnd: number,
): Set<string> {
  const signature = resolveFunctionSignature(source, fnStart, fnEnd);
  const locals = new Set<string>(signature.params);
  for (
    const local of collectLocalBindings(
      source,
      signature.bodyStart,
      signature.bodyEnd,
    )
  ) {
    locals.add(local);
  }

  const free = new Set<string>();
  for (
    const token of collectIdentifierTokens(
      source,
      signature.bodyStart,
      signature.bodyEnd,
    )
  ) {
    if (locals.has(token.text) || RESERVED_IDENTIFIERS.has(token.text)) {
      continue;
    }
    const prev = previousSignificantChar(
      source,
      signature.bodyStart,
      token.start,
    );
    if (prev === ".") {
      continue;
    }
    const next = nextSignificantChar(source, token.end, signature.bodyEnd);
    if (next === ":" && (prev === "{" || prev === ",")) {
      continue;
    }
    free.add(token.text);
  }

  return free;
}

function resolveFunctionSignature(
  source: string,
  fnStart: number,
  fnEnd: number,
): { params: string[]; bodyStart: number; bodyEnd: number } {
  const trimmed = trimRange(source, fnStart, fnEnd);
  const inner = stripWholeParentheses(source, trimmed.start, trimmed.end);

  try {
    const parsed = parseFunctionText(source, inner.start, inner.end);
    return {
      params: parsed.params,
      bodyStart: parsed.body.start,
      bodyEnd: parsed.body.end,
    };
  } catch {
    const innerText = source.slice(inner.start, inner.end).trimStart();
    if (innerText.startsWith("function")) {
      const openParen = source.indexOf("(", inner.start);
      const closeParen = source.indexOf(")", openParen + 1);
      const openBrace = source.indexOf("{", closeParen + 1);
      if (
        openParen === -1 || closeParen === -1 || openBrace === -1 ||
        openBrace >= inner.end || source[inner.end - 1] !== "}"
      ) {
        throw new CompiledJsParseError(
          inner.start,
          "Expected a direct function expression",
        );
      }
      const nameMatch = innerText.match(/^function\s+([A-Za-z_$][\w$]*)\s*\(/);
      const params = parseParameterList(source, openParen + 1, closeParen);
      if (nameMatch) {
        params.push(nameMatch[1]);
      }
      return {
        params,
        bodyStart: openBrace + 1,
        bodyEnd: inner.end - 1,
      };
    }

    const arrowIndex = source.indexOf("=>", inner.start);
    if (arrowIndex === -1 || arrowIndex >= inner.end) {
      throw new CompiledJsParseError(
        inner.start,
        "Expected a direct function expression",
      );
    }
    const params = parseArrowFunctionParameters(
      source,
      inner.start,
      arrowIndex,
    );
    const body = trimRange(source, arrowIndex + 2, inner.end);
    return {
      params,
      bodyStart: body.start,
      bodyEnd: body.end,
    };
  }
}

function parseArrowFunctionParameters(
  source: string,
  start: number,
  arrowIndex: number,
): string[] {
  const paramsRange = trimRange(source, start, arrowIndex);
  const stripped = stripWholeParentheses(
    source,
    paramsRange.start,
    paramsRange.end,
  );
  return parseParameterList(source, stripped.start, stripped.end);
}

function parseParameterList(
  source: string,
  start: number,
  end: number,
): string[] {
  const raw = source.slice(start, end).trim();
  if (!raw) {
    return [];
  }
  if (SIMPLE_IDENTIFIER_RE.test(raw)) {
    return [raw];
  }

  const bindings = new Set<string>();
  for (const token of collectIdentifierTokens(source, start, end)) {
    if (RESERVED_IDENTIFIERS.has(token.text)) {
      continue;
    }
    const prev = previousSignificantChar(source, start, token.start);
    const next = nextSignificantChar(source, token.end, end);
    if (prev === ".") {
      continue;
    }
    if (next === ":" && (prev === "{" || prev === ",")) {
      continue;
    }
    bindings.add(token.text);
  }
  return [...bindings];
}

function collectLocalBindings(
  source: string,
  start: number,
  end: number,
): Set<string> {
  const locals = new Set<string>();
  const tokens = collectIdentifierTokens(source, start, end);
  for (let index = 0; index < tokens.length - 1; index++) {
    if (!DECLARATION_KEYWORDS.has(tokens[index].text)) {
      continue;
    }
    locals.add(tokens[index + 1].text);
  }
  return locals;
}

function previousSignificantChar(
  source: string,
  start: number,
  end: number,
): string | undefined {
  for (let cursor = end - 1; cursor >= start; cursor--) {
    if (!/\s/.test(source[cursor])) {
      return source[cursor];
    }
  }
  return undefined;
}

function nextSignificantChar(
  source: string,
  start: number,
  end: number,
): string | undefined {
  for (let cursor = start; cursor < end; cursor++) {
    if (!/\s/.test(source[cursor])) {
      return source[cursor];
    }
  }
  return undefined;
}

function resolveTrustedCallName(
  normalizedCallee: string,
  env: Map<string, BindingInfo>,
): string | undefined {
  if (SIMPLE_IDENTIFIER_RE.test(normalizedCallee)) {
    const binding = env.get(normalizedCallee);
    if (
      binding?.trustedRuntimeName &&
      (TRUSTED_BUILDERS.has(binding.trustedRuntimeName) ||
        TRUSTED_DATA_HELPERS.has(binding.trustedRuntimeName))
    ) {
      return binding.trustedRuntimeName;
    }
    return undefined;
  }

  const commaCall = normalizedCallee.match(
    /^\(0,([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\)$/,
  );
  if (commaCall) {
    const binding = env.get(commaCall[1]);
    if (
      binding?.namespaceImport &&
      binding.trustedRuntimeName &&
      (TRUSTED_BUILDERS.has(commaCall[2]) ||
        TRUSTED_DATA_HELPERS.has(commaCall[2]))
    ) {
      return commaCall[2];
    }
  }

  const memberCall = normalizedCallee.match(
    /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/,
  );
  if (memberCall) {
    const binding = env.get(memberCall[1]);
    if (
      binding?.namespaceImport &&
      binding.trustedRuntimeName &&
      (TRUSTED_BUILDERS.has(memberCall[2]) ||
        TRUSTED_DATA_HELPERS.has(memberCall[2]))
    ) {
      return memberCall[2];
    }
  }

  return undefined;
}

function parseVariableDeclarators(
  source: string,
  statement: StatementChunk,
): Array<{ name: string; initializer: { start: number; end: number } }> {
  const trimmed = trimRange(source, statement.start, statement.end);
  const keyword = getVariableStatementKind(statement.text);
  const keywordStart = statement.text.indexOf(keyword);
  const listStart = trimmed.start + keywordStart + keyword.length;
  const listEnd =
    stripTrailingSemicolonRange(source, trimmed.start, trimmed.end)
      .end;
  return splitTopLevelCommaList(source, listStart, listEnd).map((range) => {
    const equals = findTopLevelEquals(source, range.start, range.end);
    if (equals === undefined) {
      throw new CompiledJsParseError(
        range.start,
        "Top-level declarations must initialize their bindings",
      );
    }
    const nameRange = trimRange(source, range.start, equals);
    const name = source.slice(nameRange.start, nameRange.end);
    if (!SIMPLE_IDENTIFIER_RE.test(name)) {
      throw new CompiledJsParseError(
        nameRange.start,
        "Top-level declarations must bind simple identifiers",
      );
    }
    const initializer = trimRange(source, equals + 1, range.end);
    return {
      name,
      initializer,
    };
  });
}

function parseExportAssignmentChain(
  source: string,
  statement: StatementChunk,
): {
  exportedNames: string[];
  value: { start: number; end: number };
  valueIsVoidZero: boolean;
} {
  const trimmed = stripTrailingSemicolonRange(
    source,
    statement.start,
    statement.end,
  );
  const equals = findTopLevelEquals(source, trimmed.start, trimmed.end);
  if (equals === undefined) {
    throw new CompiledJsParseError(
      trimmed.start,
      "Compiled exports must use direct assignment",
    );
  }

  const exportedName = getExportsPropertyName(
    source,
    trimmed.start,
    equals,
  );
  if (!exportedName) {
    throw new CompiledJsParseError(
      trimmed.start,
      "Compiled exports must use direct assignment",
    );
  }

  const rhs = trimRange(source, equals + 1, trimmed.end);
  const nestedEquals = findTopLevelEquals(source, rhs.start, rhs.end);
  if (
    nestedEquals !== undefined &&
    getExportsPropertyName(source, rhs.start, nestedEquals)
  ) {
    const nested = parseExportAssignmentChain(source, {
      start: rhs.start,
      end: rhs.end,
      text: source.slice(rhs.start, rhs.end),
    });
    return {
      exportedNames: [exportedName, ...nested.exportedNames],
      value: nested.value,
      valueIsVoidZero: nested.valueIsVoidZero,
    };
  }

  return {
    exportedNames: [exportedName],
    value: rhs,
    valueIsVoidZero: stripJsTrivia(source, rhs.start, rhs.end) === "void0",
  };
}

function tryParseCompiledReexport(
  source: string,
): { exportedName: string; target: string } | undefined {
  const normalized = stripJsTrivia(source);
  const match = normalized.match(
    /^Object\.defineProperty\(exports,(["'])([^"']+)\1,\{enumerable:true,get:function\(\)\{return(.+);\}\}\);?$/,
  );
  if (!match) return undefined;
  return {
    exportedName: match[2],
    target: match[3],
  };
}

function isCompiledExportStarStatement(source: string): boolean {
  return /^__exportStar\([A-Za-z_$][\w$]*,exports\);?$/.test(
    stripJsTrivia(source),
  );
}

function isCompiledExportAssignment(source: string): boolean {
  return stripJsTrivia(source).startsWith("exports.");
}

function isCompiledEsModuleMarker(source: string): boolean {
  return stripJsTrivia(source) ===
    `Object.defineProperty(exports,"__esModule",{value:true});`;
}

function isCompiledImportNormalizationRebinding(
  source: string,
  env: Map<string, BindingInfo>,
): boolean {
  const normalized = stripJsTrivia(source);
  const match = normalized.match(
    /^([A-Za-z_$][\w$]*)=__(importDefault|importStar)\(\1\);?$/,
  );
  if (!match) return false;
  return env.get(match[1])?.kind === "import";
}

function isAllowedFunctionHardeningStatement(
  source: string,
  env: Map<string, BindingInfo>,
): boolean {
  const normalized = stripJsTrivia(source);
  const match = normalized.match(
    /^([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\);?$/,
  );
  if (!match) return false;

  const callee = env.get(match[1]);
  const target = env.get(match[2]);
  return callee?.hardeningHelper === true && target?.kind === "function";
}

function isFunctionHardeningHelperDeclaration(source: string): boolean {
  return stripJsTrivia(source) === CANONICAL_HARDENING_HELPER;
}

function isJsxHelperWrapperDeclaration(source: string): boolean {
  return /^function[A-Za-z_$][\w$]*\(\.\.\.[A-Za-z_$][\w$]*\)\{return__ctHelpers\.h\.apply\(null,[A-Za-z_$][\w$]*\);\}$/
    .test(stripJsTrivia(source));
}

function registerFunctionStatement(
  statement: StatementChunk,
  env: Map<string, BindingInfo>,
): void {
  const name = getFunctionDeclarationName(statement.text);
  if (!name) return;
  env.set(name, {
    kind: "function",
    captureSafe: isJsxHelperWrapperDeclaration(statement.text),
    hardeningHelper: isFunctionHardeningHelperDeclaration(statement.text),
    functionRange: { start: statement.start, end: statement.end },
  });
}

function getFunctionDeclarationName(source: string): string | undefined {
  const trimmed = source.trimStart();
  const match = trimmed.match(/^function\s+([A-Za-z_$][\w$]*)\s*\(/);
  return match?.[1];
}

function tryParseDirectFunction(
  source: string,
  start: number,
  end: number,
): ParsedDefineCall["factory"] | undefined {
  const normalized = stripJsTrivia(source, start, end);
  if (
    /^function(?:[A-Za-z_$][\w$]*)?\(/.test(normalized) ||
    /^(?:async)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)=>/.test(normalized)
  ) {
    return {
      start,
      end,
      text: source.slice(start, end),
      params: [],
      body: {
        start,
        end,
        statements: [],
      },
    };
  }
  try {
    return parseFunctionText(source, start, end);
  } catch {
    return undefined;
  }
}

function parseMemberReference(
  source: string,
): { root: string; property?: string } | undefined {
  const normalized = stripJsTrivia(source);
  const property = normalized.match(
    /^([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*)|\[(["'])([^"']+)\3\])+$/,
  );
  if (!property) return undefined;
  const lastDot = property[2];
  const lastBracket = property[4];
  return {
    root: property[1],
    property: lastBracket ?? lastDot,
  };
}

function getExportsPropertyName(
  source: string,
  start: number,
  end: number,
): string | undefined {
  const normalized = stripJsTrivia(source, start, end);
  const dotMatch = normalized.match(/^exports\.([A-Za-z_$][\w$]*)$/);
  if (dotMatch) return dotMatch[1];
  const bracketMatch = normalized.match(/^exports\[(["'])([^"']+)\1\]$/);
  return bracketMatch?.[2];
}

function isStringDirective(source: string): boolean {
  return /^(['"]).*\1;?$/.test(source.trim());
}

function isFunctionDeclarationStatement(source: string): boolean {
  return source.trimStart().startsWith("function ");
}

function isClassDeclarationStatement(source: string): boolean {
  return source.trimStart().startsWith("class ");
}

function isVariableStatement(source: string): boolean {
  return /^(const|let|var)\b/.test(source.trimStart());
}

function getVariableStatementKind(source: string): "const" | "let" | "var" {
  const match = source.trimStart().match(/^(const|let|var)\b/);
  if (!match) {
    throw new Error("Expected a variable statement");
  }
  return match[1] as "const" | "let" | "var";
}

function isPrimitiveLikeExpression(normalized: string): boolean {
  return normalized === "null" ||
    normalized === "true" ||
    normalized === "false" ||
    /^-?\d/.test(normalized) ||
    /^(['"]).*\1$/.test(normalized) ||
    /^\d+n$/.test(normalized);
}

function isRegexLiteral(normalized: string): boolean {
  return /^\/(?:\\.|[^/])+\/[A-Za-z]*$/.test(normalized);
}

function isIifeExpression(normalized: string): boolean {
  return /^\((?:async)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)=>.*\)\([^)]*\)$/.test(
    normalized,
  ) ||
    /^\(function.*\)\([^)]*\)$/.test(normalized);
}

function isRawMutableExpression(normalized: string): boolean {
  return normalized.startsWith("{") ||
    normalized.startsWith("[") ||
    normalized.startsWith("/") ||
    normalized.startsWith("new");
}

function stripTrailingSemicolonRange(
  source: string,
  start: number,
  end: number,
): { start: number; end: number } {
  const trimmed = trimRange(source, start, end);
  if (source[trimmed.end - 1] === ";") {
    return trimRange(source, trimmed.start, trimmed.end - 1);
  }
  return trimmed;
}

function cloneBindingInfo(binding: BindingInfo): BindingInfo {
  return { ...binding };
}

function verificationErrorAt(
  source: string,
  file: string,
  offset: number,
  message: string,
): ModuleVerificationError {
  const { line, column } = locationFromOffset(source, offset);
  return new ModuleVerificationError(file, line, column, message);
}

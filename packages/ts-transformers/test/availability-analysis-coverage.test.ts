import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import ts from "typescript";

import {
  canonicalizeResultOfCaptures,
  guardOperandExposesAvailability,
  parseAvailabilityObservation,
  resolveAvailabilityObservation,
  resolveAvailabilityValueProvenance,
  resolveResultOfSource,
  rewriteResultOfAliasReferences,
  typeContainsAvailabilityVariant,
} from "../src/availability/analysis.ts";
import {
  type AvailabilityCaptureOverride,
  collectAvailabilityGuardCaptures,
  collectExplicitAvailabilityGuardCaptures,
  collectObservedAvailabilityCaptures,
  collectObservedAvailabilityInputPaths,
  mapGuardCapturesToCallbackInput,
  mergeAvailabilityCaptureOverrides,
  partitionGuardCapturesByCallbackInput,
  renameAvailabilityCapturePaths,
} from "../src/availability/captures.ts";
import { getStableConstAliasInitializer } from "../src/ast/stable-const-alias.ts";
import { TransformationContext } from "../src/core/context.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";

interface TestContext {
  context: TransformationContext;
  sourceFile: ts.SourceFile;
  transformation: ts.TransformationContext;
}

function withContext(source: string, run: (test: TestContext) => void): void {
  const files: Record<string, string> = {
    "/test.ts": source,
    "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"],
  };
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noLib: true,
  };
  const host: ts.CompilerHost = {
    fileExists: (name) => files[name] !== undefined,
    readFile: (name) => files[name],
    directoryExists: () => true,
    getDirectories: () => [],
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => "/",
    getNewLine: () => "\n",
    getDefaultLibFileName: () => "lib.d.ts",
    useCaseSensitiveFileNames: () => true,
    writeFile: () => {},
    getSourceFile: (name, languageVersion) =>
      files[name] !== undefined
        ? ts.createSourceFile(name, files[name]!, languageVersion, true)
        : undefined,
    resolveModuleNames: (moduleNames) =>
      moduleNames.map((name) =>
        name === "commonfabric"
          ? {
            resolvedFileName: "/commonfabric.d.ts",
            extension: ts.Extension.Dts,
            isExternalLibraryImport: false,
          }
          : undefined
      ),
  };
  const program = ts.createProgram(["/test.ts"], options, host);
  const sourceFile = program.getSourceFile("/test.ts")!;
  let transformation!: ts.TransformationContext;
  const transformed = ts.transform(sourceFile, [
    (context) => {
      transformation = context;
      return (node) => node;
    },
  ]);
  try {
    run({
      context: new TransformationContext({
        program,
        sourceFile,
        tsContext: transformation,
      }),
      sourceFile,
      transformation,
    });
  } finally {
    transformed.dispose();
  }
}

function variable(
  sourceFile: ts.SourceFile,
  name: string,
): ts.VariableDeclaration {
  let result: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      result = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!result) throw new Error(`Missing variable ${name}`);
  return result;
}

function initializer(sourceFile: ts.SourceFile, name: string): ts.Expression {
  const result = variable(sourceFile, name).initializer;
  if (!result) throw new Error(`Missing initializer ${name}`);
  return result;
}

function functionDeclaration(
  sourceFile: ts.SourceFile,
  name: string,
): ts.FunctionDeclaration {
  let result: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) && node.name?.text === name
    ) {
      result = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!result) throw new Error(`Missing function ${name}`);
  return result;
}

function identifierIn(
  node: ts.Node,
  name: string,
): ts.Identifier {
  let result: ts.Identifier | undefined;
  const visit = (current: ts.Node): void => {
    if (ts.isIdentifier(current) && current.text === name) {
      result = current;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  if (!result) throw new Error(`Missing identifier ${name}`);
  return result;
}

Deno.test("availability provenance and observations cover retained and invalid forms", () => {
  withContext(
    `
      import {
        AsyncResult,
        HasError,
        fetchJsonUnchecked,
        fetchText,
        generateObject,
        generateObjectStream,
        generateText,
        generateTextStream,
        observeAvailability,
        resultOf,
      } from "commonfabric";

      type Repo = { name: string };
      declare function ordinary(value: unknown): unknown;
      const fetched = fetchText({ url: "/repo" });
      const fetchedAny = fetchJsonUnchecked({ url: "/repo" });
      const textGenerated = generateText({ prompt: "repo" });
      const objectGenerated = generateObject<Repo>({ prompt: "repo" });
      const objectStream = generateObjectStream<Repo>({ prompt: "repo" });
      const objectStreamAlias = objectStream;
      const objectStreamResult = objectStreamAlias.result;
      const textStreamResult = generateTextStream({ prompt: "repo" }).result;
      const projected = resultOf(fetched);
      const nestedProjected = resultOf(projected);
      const emptyProjection = resultOf();
      const ordinaryCall = ordinary(fetched);
      const allObserved = observeAvailability(fetched);
      const selective = observeAvailability(fetched, "error", "error", "pending");
      const invalid = observeAvailability(fetched, "not-a-reason");
      const missing = observeAvailability();
      const observedAlias = selective;
      declare const plainAny: any;
      declare const plainUnknown: unknown;
      declare const unavailable: HasError;
      declare const asyncString: AsyncResult<string>;
      function constrained<T extends HasError>(value: T) { return value; }
    `,
    ({ context, sourceFile }) => {
      assertEquals(
        resolveAvailabilityValueProvenance(
          initializer(sourceFile, "fetched"),
          context,
        )?.kind,
        "async-result",
      );
      assertEquals(
        resolveAvailabilityValueProvenance(
          initializer(sourceFile, "textGenerated"),
          context,
        )?.kind,
        "async-result",
      );
      assertEquals(
        resolveAvailabilityValueProvenance(
          initializer(sourceFile, "objectGenerated"),
          context,
        )?.kind,
        "async-result",
      );
      assertEquals(
        resolveAvailabilityValueProvenance(
          initializer(sourceFile, "objectStream"),
          context,
        ),
        undefined,
      );
      assertEquals(
        resolveAvailabilityValueProvenance(
          initializer(sourceFile, "objectStreamResult"),
          context,
        )?.kind,
        "async-result",
      );
      assertEquals(
        resolveAvailabilityValueProvenance(
          initializer(sourceFile, "textStreamResult"),
          context,
        )?.kind,
        "async-result",
      );
      assertEquals(
        resolveAvailabilityValueProvenance(
          initializer(sourceFile, "nestedProjected"),
          context,
        )?.kind,
        "result-projection",
      );
      assertEquals(
        resolveAvailabilityValueProvenance(
          initializer(sourceFile, "emptyProjection"),
          context,
        ),
        undefined,
      );
      assertEquals(
        resolveAvailabilityValueProvenance(
          initializer(sourceFile, "ordinaryCall"),
          context,
        ),
        undefined,
      );

      const nestedSource = resolveResultOfSource(
        initializer(sourceFile, "nestedProjected"),
        context,
      );
      assertEquals(nestedSource?.getText(sourceFile), "fetched");
      assertEquals(
        resolveResultOfSource(initializer(sourceFile, "ordinaryCall"), context),
        undefined,
      );
      assertEquals(
        resolveResultOfSource(
          initializer(sourceFile, "emptyProjection"),
          context,
        ),
        undefined,
      );

      const all = parseAvailabilityObservation(
        initializer(sourceFile, "allObserved") as ts.CallExpression,
        context,
        true,
      );
      assertEquals(all?.reasons, [
        "pending",
        "error",
        "syncing",
        "schema-mismatch",
      ]);
      const selected = parseAvailabilityObservation(
        initializer(sourceFile, "selective") as ts.CallExpression,
        context,
        true,
      );
      assertEquals(selected?.reasons, ["error", "pending"]);
      assertEquals(
        parseAvailabilityObservation(
          initializer(sourceFile, "invalid") as ts.CallExpression,
          context,
          true,
        ),
        undefined,
      );
      assertEquals(
        parseAvailabilityObservation(
          initializer(sourceFile, "missing") as ts.CallExpression,
          context,
          true,
        ),
        undefined,
      );
      assertEquals(
        parseAvailabilityObservation(
          initializer(sourceFile, "ordinaryCall") as ts.CallExpression,
          context,
          true,
        ),
        undefined,
      );
      assertEquals(
        context.diagnostics.map((diagnostic) => diagnostic.type),
        [
          "availability:invalid-observation",
          "availability:invalid-observation",
        ],
      );

      const observedAlias = initializer(sourceFile, "observedAlias");
      assertEquals(
        resolveAvailabilityObservation(observedAlias, context)?.reasons,
        ["error", "pending"],
      );
      context.recordAvailabilityObservation(observedAlias, all!);
      assertEquals(
        resolveAvailabilityObservation(observedAlias, context)?.reasons,
        all?.reasons,
      );

      const checker = context.checker;
      const variant = checker.getTypeAtLocation(
        variable(sourceFile, "unavailable").name,
      );
      const asyncType = checker.getTypeAtLocation(
        variable(sourceFile, "asyncString").name,
      );
      const anyType = checker.getTypeAtLocation(
        variable(sourceFile, "plainAny").name,
      );
      const unknownType = checker.getTypeAtLocation(
        variable(sourceFile, "plainUnknown").name,
      );
      const constrained = functionDeclaration(sourceFile, "constrained");
      const constrainedType = checker.getTypeAtLocation(
        constrained.typeParameters![0]!,
      );
      assert(typeContainsAvailabilityVariant(asyncType, variant, checker));
      assert(
        typeContainsAvailabilityVariant(constrainedType, variant, checker),
      );
      assertEquals(
        typeContainsAvailabilityVariant(anyType, variant, checker),
        false,
      );
      assertEquals(
        typeContainsAvailabilityVariant(unknownType, variant, checker),
        false,
      );
      assertEquals(
        typeContainsAvailabilityVariant(
          asyncType,
          variant,
          checker,
          new Set([asyncType]),
        ),
        false,
      );
      assert(
        guardOperandExposesAvailability(
          initializer(sourceFile, "fetchedAny"),
          variant,
          context,
        ),
      );
      assertEquals(
        guardOperandExposesAvailability(
          variable(sourceFile, "plainAny").name as ts.Identifier,
          variant,
          context,
        ),
        false,
      );
    },
  );
});

Deno.test("resultOf canonicalization rewrites stable property and element paths", () => {
  withContext(
    `
      import { AsyncResult, fetchJson, resultOf } from "commonfabric";
      type Repo = { name: string };
      declare const input: { requests: AsyncResult<Repo>[] };
      const projected = resultOf(input.requests[0]);
      const direct = resultOf(fetchJson<Repo>({ url: "/repo" }));
      const view = () => ({ projected, name: projected.name });
    `,
    ({ context, sourceFile, transformation }) => {
      const view = initializer(sourceFile, "view") as ts.ArrowFunction;
      const projectedUse = identifierIn(view.body, "projected");
      const canonical = canonicalizeResultOfCaptures(
        [projectedUse],
        context,
      );
      assertEquals(canonical.captures.size, 1);
      assertEquals(canonical.aliases.size, 1);

      const rewritten = rewriteResultOfAliasReferences(
        view.body,
        canonical.aliases,
        context,
        transformation,
      );
      const printed = ts.createPrinter().printNode(
        ts.EmitHint.Unspecified,
        rewritten,
        sourceFile,
      );
      assertStringIncludes(printed, "projected: input.requests[0]");
      assertStringIncludes(printed, "input.requests[0].name");

      const directSymbol = context.checker.getSymbolAtLocation(
        variable(sourceFile, "direct").name,
      )!;
      const directAliases = new Map([
        [
          directSymbol,
          (initializer(sourceFile, "direct") as ts.CallExpression)
            .arguments[0]!,
        ],
      ]);
      const directIdentifier = variable(sourceFile, "direct").name;
      const rewrittenDirect = rewriteResultOfAliasReferences(
        directIdentifier,
        directAliases,
        context,
        transformation,
      );
      assertStringIncludes(
        ts.createPrinter().printNode(
          ts.EmitHint.Expression,
          rewrittenDirect,
          sourceFile,
        ),
        "fetchJson",
      );
      assertEquals(
        rewriteResultOfAliasReferences(
          view.body,
          new Map(),
          context,
          transformation,
        ),
        view.body,
      );
    },
  );
});

Deno.test("availability capture utilities cover composite and callback paths", () => {
  withContext(
    `
      import {
        AsyncResult,
        hasError,
        isPending,
        observeAvailability,
      } from "commonfabric";
      type Repo = { name: string };
      declare const input: { request: AsyncResult<Repo> };
      declare function make(): AsyncResult<Repo>;
      const observed = observeAvailability(input.request, "error");
      const wrapped = (((observed as typeof observed)!) satisfies AsyncResult<Repo>);
      const composite = {
        first: wrapped,
        observed,
        "literal-name": observed,
        [input.request.reason]: observed,
      };
      const list = [observed, , wrapped];
      const guards = () =>
        hasError(input["request"]) || isPending(input.request) || hasError(make());
      const noArgGuard = () => hasError();
      const arrayCallback = ([head, ...rest]: [string, ...AsyncResult<Repo>[]]) =>
        hasError(rest[0]);
      const noParameter = () => true;
    `,
    ({ context, sourceFile }) => {
      const observedCaptures = collectObservedAvailabilityCaptures(
        [initializer(sourceFile, "wrapped")],
        context,
      );
      assertEquals(observedCaptures.length, 1);
      assertEquals(observedCaptures[0]?.path, ["observed"]);

      assertEquals(
        collectObservedAvailabilityInputPaths(
          initializer(sourceFile, "composite"),
          context,
        ).map((entry) => entry.path),
        [["first"], ["observed"], ["literal-name"]],
      );
      assertEquals(
        collectObservedAvailabilityInputPaths(
          initializer(sourceFile, "list"),
          context,
        ).map((entry) => entry.path),
        [["0"], ["2"]],
      );

      const guards = initializer(sourceFile, "guards") as ts.ArrowFunction;
      assert(!ts.isBlock(guards.body));
      const direct = collectAvailabilityGuardCaptures(guards.body, context);
      assertEquals(direct[0]?.path, ["input", "request"]);
      assertEquals(direct[0]?.reasons, ["error", "pending"]);
      assert(
        context.diagnostics.some((diagnostic) =>
          diagnostic.type === "availability:unsupported-guard-operand"
        ),
      );
      const noArg = initializer(sourceFile, "noArgGuard") as ts.ArrowFunction;
      assert(!ts.isBlock(noArg.body));
      collectAvailabilityGuardCaptures(noArg.body, context);

      const explicit = collectExplicitAvailabilityGuardCaptures(
        guards.body,
        context,
      );
      assertEquals(explicit[0]?.path, ["input", "request"]);
      assertEquals(explicit[0]?.reasons, ["error", "pending"]);

      const variants = direct[0]!.variants;
      const entries: AvailabilityCaptureOverride[] = [
        { path: [], reasons: ["pending"], variants: [] },
        { path: ["rest", "0"], reasons: ["error"], variants },
        { path: ["rest", "bad"], reasons: ["syncing"], variants: [] },
        { path: ["outside"], reasons: ["schema-mismatch"], variants: [] },
      ];
      const arrayCallback = initializer(
        sourceFile,
        "arrayCallback",
      ) as ts.ArrowFunction;
      const partitioned = partitionGuardCapturesByCallbackInput(
        entries,
        arrayCallback,
      );
      assertEquals(
        partitioned.callbackInput.map((entry) => entry.path),
        [[], ["1"]],
      );
      assertEquals(
        partitioned.captures.map((entry) => entry.path),
        [["rest", "bad"], ["outside"]],
      );
      assertEquals(
        mapGuardCapturesToCallbackInput(entries, arrayCallback).map((entry) =>
          entry.path
        ),
        [[], ["1"], ["rest", "bad"], ["outside"]],
      );
      const noParameter = initializer(
        sourceFile,
        "noParameter",
      ) as ts.ArrowFunction;
      assertEquals(
        partitionGuardCapturesByCallbackInput(entries, noParameter).captures,
        entries,
      );

      const renamed = renameAvailabilityCapturePaths(
        entries,
        new Map([
          ["outside", "renamed"],
        ]),
      );
      assertEquals(renamed[0], entries[0]);
      assertEquals(renamed[3]?.path, ["renamed"]);
      const merged = mergeAvailabilityCaptureOverrides([
        { path: ["same"], reasons: ["pending"], variants: [] },
        {
          path: ["same"],
          source: initializer(sourceFile, "observed"),
          reasons: ["pending", "error"],
          variants,
        },
      ]);
      assertEquals(merged[0]?.reasons, ["pending", "error"]);
      assertEquals(merged[0]?.variants.length, variants.length);
      assert(merged[0]?.source);
    },
  );
});

Deno.test("stable const aliases reconstruct destructured static access paths", () => {
  withContext(
    `
      const source = {
        regular: 1,
        "dash-key": 2,
        0: 3,
        nested: [4],
      };
      const {
        regular,
        "dash-key": dashed,
        0: numeric,
        nested: [first],
      } = source;
      const defaulted = regular;
      let mutable = source;
    `,
    ({ context, sourceFile }) => {
      const printer = ts.createPrinter();
      const resolved = (name: string): string | undefined => {
        const symbol = context.checker.getSymbolAtLocation(
          identifierIn(sourceFile, name),
        );
        const expression = getStableConstAliasInitializer(symbol);
        return expression
          ? printer.printNode(ts.EmitHint.Expression, expression, sourceFile)
          : undefined;
      };
      assertEquals(resolved("regular"), "source.regular");
      assertEquals(resolved("dashed"), 'source["dash-key"]');
      assertEquals(resolved("numeric"), "source[0]");
      assertEquals(resolved("first"), "source.nested[0]");
      assertEquals(resolved("defaulted"), "regular");
      assertEquals(resolved("mutable"), undefined);
    },
  );
});

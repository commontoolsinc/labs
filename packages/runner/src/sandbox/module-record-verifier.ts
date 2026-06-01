import type { VirtualModuleRecord } from "./esm-module-loader.ts";
import {
  type BindingInfo,
  classifyModuleItems,
} from "./compiled-bundle-verifier.ts";
import { parseFunctionText } from "./compiled-js-parser.ts";
import {
  isAllowedAuthoredImportSpecifier,
  isRuntimeModuleIdentifier,
} from "./runtime-module-policy.ts";
import {
  isAllowedTsLibHelperDeclaration,
  normalizeExact,
} from "./bundle-preflight.ts";

/**
 * Structural pre-flight verification for a module-record graph (Phase 3 of
 * docs/specs/module-loading.md).
 *
 * This is the record-path analogue of the AMD bundle pre-flight
 * (`bundle-preflight.ts`): it validates the *shape and wiring* of the graph
 * before any module executes — every specifier is content-addressed, every
 * record is well-formed, and every resolved import points at a present record.
 *
 * The deep SES_SANDBOXING module-item classification is provided by
 * {@link verifyCompiledModuleBody}, which reuses the shared `classifyModuleItems`
 * core extracted from the AMD verifier. The `esmModuleLoader` flag stays off and
 * the AMD verifier remains the enforcement path until the differential parity
 * oracle confirms ESM and AMD verdicts match across the corpus.
 */

const VALID_SPECIFIER = /^cf:(module|runtime)\//;

const EMPTY_BINDING_SET: ReadonlySet<string> = new Set<string>();

// A compiled-CommonJS import preamble statement, e.g.
//   const util_ts_1 = require("./util.ts");
//   const cf_1 = __importDefault(require("commonfabric"));
//   const ns_1 = __importStar(require("./ns.ts"));
// Captures the local binding name and the imported specifier.
const REQUIRE_IMPORT = new RegExp(
  "^const\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*" +
    "(?:__importDefault|__importStar)?\\s*\\(?\\s*" +
    "require\\(\\s*[\"']([^\"']+)[\"']\\s*\\)\\s*\\)?\\s*;?$",
);

// A bare side-effect import preamble statement, e.g. `require("./styles.ts");`
// (compiled from `import "./styles.ts"`). It binds nothing; AMD treats this as
// a plain dependency, so for parity it is allowed (when the specifier is) and
// skipped rather than classified as executable code.
const SIDE_EFFECT_REQUIRE = /^require\(\s*["']([^"']+)["']\s*\)\s*;?$/;

// `export * from "./m"` compiles to `__exportStar(require("./m"), exports);`
// (require inline, unlike AMD where the dep is a param). This re-export form
// binds nothing; allow it when the specifier is allowed, otherwise let it fall
// through to classification (which rejects it).
const EXPORT_STAR_REQUIRE =
  /^__exportStar\(\s*require\(\s*["']([^"']+)["']\s*\)\s*,\s*exports\s*\)\s*;?$/;

/**
 * Security-classify a module's compiled-CommonJS body (Phase D2). It recognizes
 * the `const x = require("…")` import preamble — seeding `env` with import
 * bindings (marking runtime modules as trusted) — and hands the remaining
 * top-level items to the shared {@link classifyModuleItems} core with empty
 * shadow-guard / reserved-binding sets (ESM modules have no AMD wrapper to
 * shadow). Throws on any violation; the byte-level rules are identical to the
 * AMD path, so a malicious module is rejected the same way under either loader.
 */
export function verifyCompiledModuleBody(
  compiled: string,
  filename = "<module>",
): void {
  // Wrap so the AMD parser can extract the top-level statements as a function
  // body; offsets stay consistent with `wrapped` for classification.
  const wrapped = `function () {\n${compiled}\n}`;
  const parsed = parseFunctionText(wrapped, 0, wrapped.length);
  const statementTexts = parsed.body.statements.map((s) =>
    wrapped.slice(s.start, s.end).trim()
  );

  // If the body declares its own top-level binding for one of the identifiers a
  // fast-path trusts (`require`, or the TS interop helpers `__exportStar` /
  // `__importDefault` / `__importStar`), the corresponding fast-path would
  // mis-trust a call into attacker-controlled code (e.g. a local
  // `function __exportStar(m){ globalThis.steal = m; }` invoked by an
  // `__exportStar(require("./m"), exports)` re-export). Detect such shadows and
  // disable the affected fast-path so the statement falls through to
  // classifyModuleItems, which rejects the call as a local-callable result —
  // matching AMD, where a non-canonical helper has no special treatment.
  //
  // Canonical TS interop helper declarations (`var __exportStar = (this && …)`)
  // are the trusted helpers themselves, not shadows, so they are excluded.
  const declaresLocalBinding = (name: string): boolean =>
    statementTexts.some((t) => {
      if (isAllowedTsLibHelperDeclaration(normalizeExact(t))) return false;
      return (
        new RegExp(`^(?:const|let|var)\\s+${name}\\b`).test(t) ||
        new RegExp(`^(?:async\\s+)?function\\s*\\*?\\s*${name}\\b`).test(t) ||
        new RegExp(`^class\\s+${name}\\b`).test(t)
      );
    });

  const requireShadowed = declaresLocalBinding("require");
  const exportStarShadowed = declaresLocalBinding("__exportStar");
  const importHelperShadowed = declaresLocalBinding("__importDefault") ||
    declaresLocalBinding("__importStar");

  const env = new Map<string, BindingInfo>();
  const classifiable: typeof parsed.body.statements = [];
  parsed.body.statements.forEach((statement, index) => {
    const text = statementTexts[index];
    // Only fast-path imports whose specifier is allowed (runtime module or a
    // local path); arbitrary specifiers (e.g. "node:fs") fall through and are
    // rejected by classification, matching the AMD dependency allowlist. The
    // fast-path is disabled entirely when `require` is shadowed.
    // Inline TS interop helper declarations (`var __importDefault = …`, etc.)
    // are emitted per-module for default/namespace imports and re-exports. They
    // are canonical compiler output (byte-matched), trusted, and `var` — skip
    // them before classification, which would otherwise reject the `var`.
    if (isAllowedTsLibHelperDeclaration(normalizeExact(text))) {
      return;
    }
    if (!requireShadowed) {
      const bound = REQUIRE_IMPORT.exec(text);
      // A helper-wrapped import (`__importDefault(require(...))` /
      // `__importStar(require(...))`) must not be fast-pathed if that helper is
      // locally shadowed — the shadow would run instead of the trusted helper.
      const usesShadowedImportHelper = importHelperShadowed &&
        /\b(?:__importDefault|__importStar)\s*\(/.test(text);
      if (
        bound && !usesShadowedImportHelper &&
        isAllowedAuthoredImportSpecifier(bound[2])
      ) {
        const [, binding, specifier] = bound;
        env.set(binding, {
          kind: "import",
          dependencySpecifier: specifier,
          namespaceImport: true,
          trustedRuntimeName: isRuntimeModuleIdentifier(specifier)
            ? specifier
            : undefined,
        });
        return;
      }
      const sideEffect = SIDE_EFFECT_REQUIRE.exec(text);
      if (sideEffect && isAllowedAuthoredImportSpecifier(sideEffect[1])) {
        return; // side-effect import binds nothing
      }
      const exportStar = EXPORT_STAR_REQUIRE.exec(text);
      if (
        exportStar && !exportStarShadowed &&
        isAllowedAuthoredImportSpecifier(exportStar[1])
      ) {
        return; // `export * from "<allowed>"` re-export; binds nothing
      }
    }
    classifiable.push(statement);
  });

  classifyModuleItems(wrapped, filename, classifiable, env, {
    requiredGuards: EMPTY_BINDING_SET,
    reservedBindings: EMPTY_BINDING_SET,
    missingGuardsErrorAt: 0,
  });
}

export class ModuleGraphVerificationError extends Error {
  override name = "ModuleGraphVerificationError";
}

export function verifyModuleGraph(
  records: Map<string, VirtualModuleRecord>,
  entrySpecifier: string,
): void {
  if (!records.has(entrySpecifier)) {
    throw new ModuleGraphVerificationError(
      `Module graph entry specifier is not present: ${entrySpecifier}`,
    );
  }

  for (const [specifier, record] of records) {
    if (!VALID_SPECIFIER.test(specifier)) {
      throw new ModuleGraphVerificationError(
        `Non-content-addressed module specifier: ${specifier}`,
      );
    }
    if (!Array.isArray(record.imports)) {
      throw new ModuleGraphVerificationError(
        `Record ${specifier} has a non-array imports list`,
      );
    }
    if (!Array.isArray(record.exports)) {
      throw new ModuleGraphVerificationError(
        `Record ${specifier} has a non-array exports list`,
      );
    }
    if (typeof record.execute !== "function") {
      throw new ModuleGraphVerificationError(
        `Record ${specifier} has a non-function execute`,
      );
    }
    for (const importSpecifier of record.imports) {
      const target = record.resolutions?.[importSpecifier] ?? importSpecifier;
      if (!records.has(target)) {
        throw new ModuleGraphVerificationError(
          `Record ${specifier} has an unresolved import "${importSpecifier}" -> "${target}"`,
        );
      }
    }
  }
}

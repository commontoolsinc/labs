import { assertEquals, assertStringIncludes } from "@std/assert";

import type { TransformationDiagnostic } from "../src/mod.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { callsNamed, literalToValue, parseModule } from "./transformed-ast.ts";
import { transformSource, validateSource } from "./utils.ts";

const FRAMEWORK_PROVIDED_WRAPPER =
  "pattern-callback:framework-provided-wrapper";

function frameworkDiagnostics(
  diagnostics: readonly TransformationDiagnostic[],
): readonly TransformationDiagnostic[] {
  return diagnostics.filter((diagnostic) =>
    diagnostic.type === FRAMEWORK_PROVIDED_WRAPPER
  );
}

Deno.test(
  "inline wrapper synthesizes and forwards FrameworkProvided input from argument 0",
  async () => {
    const diagnostics: TransformationDiagnostic[] = [];
    const output = await transformSource(
      `
import { pattern, type FrameworkProvided } from "commonfabric";

const privileged = pattern<{
  command: string;
  sandboxId: FrameworkProvided<string>;
}, { received: string }>(({ sandboxId }) => ({ received: sandboxId }));

export default pattern<{ command: string }>((outer) => ({
  tool: pattern<{ suffix: string }>(({ suffix }) =>
    privileged({ command: outer.command } as any)
  ),
}));
`,
      {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
        pipelineDiagnostics: diagnostics,
      },
    );

    assertEquals(frameworkDiagnostics(diagnostics), []);
    const root = parseModule(output);
    assertEquals(
      callsNamed(root, "forwardFrameworkProvidedInput").length,
      0,
      "forwarding must be structural, not a runtime merge capability",
    );
    assertStringIncludes(
      output,
      '"sandboxId": __cf_framework_input.key("sandboxId")',
    );
    assertEquals(
      callsNamed(root, "withFrameworkProvidedPaths").length,
      2,
      "both the base and wrapper artifacts must carry trusted path metadata",
    );
    assertStringIncludes(output, "sandboxId");
  },
);

Deno.test(
  "FrameworkProvided forwarding is transitive through a wrapper chain",
  async () => {
    const diagnostics: TransformationDiagnostic[] = [];
    const output = await transformSource(
      `
import { pattern, type FrameworkProvided } from "commonfabric";

const privileged = pattern<{
  command: string;
  sandboxId: FrameworkProvided<string>;
}, { received: string }>(({ sandboxId }) => ({ received: sandboxId }));

const firstWrapper = pattern<{ command: string }>(({ command }) =>
  privileged({ command } as any)
);

export default pattern(() => ({
  tool: pattern<{ command: string }>(({ command }) =>
    firstWrapper({ command })
  ),
}));
`,
      {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
        pipelineDiagnostics: diagnostics,
      },
    );

    assertEquals(frameworkDiagnostics(diagnostics), []);
    const root = parseModule(output);
    assertEquals(
      callsNamed(root, "forwardFrameworkProvidedInput").length,
      0,
      "wrapper chains must use direct aliases",
    );
    assertEquals(
      output.match(
        /"sandboxId": __cf_framework_input(?:_\d+)?\.key\("sandboxId"\)/g,
      )
        ?.length,
      2,
      "each wrapper layer must forward the same argument-0 alias",
    );
    assertEquals(
      callsNamed(root, "withFrameworkProvidedPaths").length,
      3,
      "the obligation must remain artifact metadata at every layer",
    );
  },
);

Deno.test(
  "compiler emits trusted FrameworkProvided metadata for pattern, lift, and handler factories",
  async () => {
    const diagnostics: TransformationDiagnostic[] = [];
    const output = await transformSource(
      `
import { handler, lift, pattern, type FrameworkProvided } from "commonfabric";

export const privilegedPattern = pattern<{
  sandboxId: FrameworkProvided<string>;
}>(({ sandboxId }) => ({ sandboxId }));

export const privilegedLift = lift((input: {
  sandboxId: FrameworkProvided<string>;
}) => input.sandboxId);

export const privilegedHandler = handler<
  { value: string },
  { sandboxId: FrameworkProvided<string> }
>((_event, context) => context.sandboxId);
`,
      {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
        pipelineDiagnostics: diagnostics,
      },
    );

    assertEquals(frameworkDiagnostics(diagnostics), []);
    assertEquals(
      callsNamed(parseModule(output), "withFrameworkProvidedPaths").length,
      3,
    );
  },
);

Deno.test(
  "compiler orders FrameworkProvided metadata by UTF-8 bytes",
  async () => {
    const output = await transformSource(
      `
import { pattern, type FrameworkProvided } from "commonfabric";

export const privilegedPattern = pattern<{
  z: FrameworkProvided<string>;
  ä: FrameworkProvided<string>;
  "😊": FrameworkProvided<string>;
}>((input) => input);
`,
      {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
      },
    );

    const [metadata] = callsNamed(
      parseModule(output),
      "withFrameworkProvidedPaths",
    );
    assertEquals(literalToValue(metadata!.arguments[1]!), [
      ["z"],
      ["ä"],
      ["😊"],
    ]);
  },
);

for (
  const [name, authoredValue] of [
    ["literal", '"author-chosen"'],
    ["capture", "chosen"],
  ] as const
) {
  Deno.test(
    `inline wrapper rejects an authored ${name} for FrameworkProvided input`,
    async () => {
      const { diagnostics } = await validateSource(
        `
import { pattern, type FrameworkProvided } from "commonfabric";

const privileged = pattern<{
  command: string;
  sandboxId: FrameworkProvided<string>;
}>(({ command }) => ({ command }));

export default pattern<{ chosen: string }>((outer) => {
  const chosen = outer.chosen;
  return {
    tool: pattern<{ command: string }>(({ command }) =>
      privileged({ command, sandboxId: ${authoredValue} })
    ),
  };
});
`,
        {
          types: COMMONFABRIC_TYPES,
          typeCheck: true,
        },
      );

      const failures = frameworkDiagnostics(diagnostics);
      assertEquals(failures.length, 1);
      assertStringIncludes(failures[0]!.message, "sandboxId");
      assertStringIncludes(failures[0]!.message, "authored");
    },
  );
}

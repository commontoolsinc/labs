import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { StaticCacheFS } from "@commonfabric/static";
import ts from "typescript";

import { transformSource, validateSource } from "./utils.ts";
import { collect, literalToValue, parseModule } from "./transformed-ast.ts";

const diagnosticTypes = (
  diagnostics: readonly { readonly type: string }[],
): string[] => diagnostics.map((diagnostic) => diagnostic.type);

const commonfabricTypes = await new StaticCacheFS().getText(
  "types/commonfabric.d.ts",
);

Deno.test("observeAvailability is a transparent reactive alias", async () => {
  const output = await transformSource(`
    import { observeAvailability, pattern } from "commonfabric";

    export default pattern((input: { value: string }) => {
      const observed = observeAvailability(input.value, "error");
      return { observed };
    });
  `);

  assertStringIncludes(
    output,
    'observeAvailability(input.key("value"), "error")',
  );
  assertEquals(output.includes("=> observeAvailability"), false);
});

Deno.test("resultOf is a transparent policy-free reactive alias", async () => {
  const output = await transformSource(
    `
    import { AsyncResult, pattern, resultOf } from "commonfabric";

    type Repo = { name: string };

    export default pattern((input: { request: AsyncResult<Repo> }) => {
      const result = resultOf(input.request);
      return { result };
    });
  `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
      typeCheck: true,
    },
  );

  assertStringIncludes(output, 'resultOf(input.key("request"))');
  assertEquals(output.includes("=> resultOf"), false);
  assertEquals(output.includes("unavailableInputPolicy"), false);
});

Deno.test("reports an availability guard inside computed without an external observation", async () => {
  const { diagnostics } = await validateSource(`
    import { computed, hasError, pattern } from "commonfabric";

    export default pattern((input: { value: string }) => {
      const failed = computed(() => hasError(input.value));
      return { failed };
    });
  `);

  assertEquals(
    diagnosticTypes(diagnostics).includes(
      "availability:unobserved-compute-guard",
    ),
    true,
  );
});

Deno.test("a visible AsyncResult guard inside computed needs no observation cast", async () => {
  const source = `
    import {
      AsyncResult,
      computed,
      hasError,
      pattern,
    } from "commonfabric";

    type Repo = { name: string };

    export default pattern((input: { request: AsyncResult<Repo> }) => {
      const failed = computed(() => hasError(input.request));
      return { failed };
    });
  `;
  const { diagnostics } = await validateSource(source, {
    types: { "commonfabric.d.ts": commonfabricTypes },
  });
  assertEquals(
    diagnosticTypes(diagnostics).includes(
      "availability:unobserved-compute-guard",
    ),
    false,
  );

  const output = await transformSource(source, {
    types: { "commonfabric.d.ts": commonfabricTypes },
    typeCheck: true,
  });
  assertStringIncludes(
    output,
    'unavailableInputPolicy: [{ path: ["input", "request"], reasons: ["error"] }]',
  );
  assertEquals(output.includes("observeAvailability"), false);
});

Deno.test("a guard only accepts the availability variant it probes", async () => {
  const { diagnostics } = await validateSource(
    `
    import {
      computed,
      HasError,
      isPending,
      pattern,
    } from "commonfabric";

    export default pattern((input: { failure: HasError }) => {
      const pending = computed(() => isPending(input.failure));
      return { pending };
    });
  `,
    { types: { "commonfabric.d.ts": commonfabricTypes } },
  );

  assertEquals(
    diagnosticTypes(diagnostics).includes(
      "availability:unobserved-compute-guard",
    ),
    true,
  );
});

Deno.test("AsyncResult<any> retains guard policy from its async producer", async () => {
  const source = `
    import {
      computed,
      fetchJsonUnchecked,
      hasError,
      pattern,
    } from "commonfabric";

    export default pattern(() => {
      const request = fetchJsonUnchecked({ url: "https://example.com/data" });
      const failed = computed(() => hasError(request));
      return { failed };
    });
  `;
  const { diagnostics } = await validateSource(source, {
    types: { "commonfabric.d.ts": commonfabricTypes },
  });
  assertEquals(
    diagnosticTypes(diagnostics).includes(
      "availability:unobserved-compute-guard",
    ),
    false,
  );

  const output = await transformSource(source, {
    types: { "commonfabric.d.ts": commonfabricTypes },
    typeCheck: true,
  });
  assertStringIncludes(
    output,
    'unavailableInputPolicy: [{ path: ["request"], reasons: ["error"] }]',
  );
});

Deno.test("advanced generation state is plain while its any result retains async provenance", async () => {
  const source = `
    import {
      computed,
      generateObjectStream as objectStream,
      generateTextStream as textStream,
      hasError,
      pattern,
    } from "commonfabric";
    import * as cf from "commonfabric";

    export default pattern(() => {
      const textState = textStream({ prompt: "text" });
      const aliasObjectState = objectStream<any>({ prompt: "alias object" });
      const objectState = cf.generateObjectStream<any>({ prompt: "object" });
      const badTextStateGuard = computed(() => hasError(textState));
      const badObjectStateGuard = computed(() => hasError(objectState));
      const textFailed = computed(() => hasError(textState.result));
      const aliasObjectFailed = computed(() => hasError(aliasObjectState.result));
      const objectFailed = computed(() => hasError(objectState.result));
      return {
        aliasObjectFailed,
        badObjectStateGuard,
        badTextStateGuard,
        objectFailed,
        textFailed,
      };
    });
  `;
  const { diagnostics } = await validateSource(source, {
    types: { "commonfabric.d.ts": commonfabricTypes },
  });
  const unobserved = diagnostics.filter((diagnostic) =>
    diagnostic.type === "availability:unobserved-compute-guard"
  );
  assertEquals(unobserved.length, 2);

  const output = await transformSource(source, {
    types: { "commonfabric.d.ts": commonfabricTypes },
    typeCheck: true,
  });
  assertStringIncludes(
    output,
    'path: ["textState", "result"], reasons: ["error"]',
  );
  assertStringIncludes(
    output,
    'path: ["aliasObjectState", "result"], reasons: ["error"]',
  );
  assertStringIncludes(
    output,
    'path: ["objectState", "result"], reasons: ["error"]',
  );
});

Deno.test("a destructured advanced generation result retains async provenance", async () => {
  const source = `
    import {
      computed,
      generateObjectStream,
      hasError,
      pattern,
    } from "commonfabric";

    export default pattern(() => {
      const { result: request } = generateObjectStream<any>({
        prompt: "object",
      });
      const failed = computed(() => hasError(request));
      return { failed };
    });
  `;
  const { diagnostics } = await validateSource(source, {
    types: { "commonfabric.d.ts": commonfabricTypes },
  });
  assertEquals(
    diagnosticTypes(diagnostics).includes(
      "availability:unobserved-compute-guard",
    ),
    false,
  );

  const output = await transformSource(source, {
    types: { "commonfabric.d.ts": commonfabricTypes },
    typeCheck: true,
  });
  assertStringIncludes(
    output,
    'unavailableInputPolicy: [{ path: ["request"], reasons: ["error"] }]',
  );
});

Deno.test("availability guards are plain predicates inside an existing compute", async () => {
  const source = `
    import {
      computed,
      generateText,
      generateTextStream,
      hasError,
      isPending,
      pattern,
    } from "commonfabric";

    export default pattern(() => {
      const request = generateText({ prompt: "text" });
      const stream = generateTextStream({ prompt: "stream" });
      const status = computed(() => {
        const pending = isPending(request);
        const failed = hasError(stream.result);
        if (pending || failed) return "waiting";
        return "ready";
      });
      return { status };
    });
  `;
  const { diagnostics } = await validateSource(source, {
    types: { "commonfabric.d.ts": commonfabricTypes },
  });
  assertEquals(
    diagnosticTypes(diagnostics).includes(
      "compute-context:local-reactive-use",
    ),
    false,
  );

  const output = await transformSource(source, {
    types: { "commonfabric.d.ts": commonfabricTypes },
    typeCheck: true,
  });
  assertStringIncludes(
    output,
    'path: ["request"], reasons: ["pending"]',
  );
  assertStringIncludes(
    output,
    'path: ["stream", "result"], reasons: ["error"]',
  );
});

Deno.test("availability guards stay plain in a nested compute over mapped results", async () => {
  const source = `
    import {
      computed,
      generateObject,
      hasError,
      isPending,
      pattern,
      resultOf,
    } from "commonfabric";

    type Result = { label: string };

    export default pattern((input: { prompts: string[] }) => {
      const requests = input.prompts.map((prompt) => {
        const request = generateObject<Result>({ prompt });
        const result = resultOf(request);
        return { request, result };
      });
      const labels = requests.map((item) => computed(() => {
        const pending = isPending(item.request);
        if (pending) return "pending";
        if (hasError(item.request)) return item.request.error.message;
        return item.result.label;
      }));
      return { labels };
    });
  `;
  const { diagnostics } = await validateSource(source, {
    types: { "commonfabric.d.ts": commonfabricTypes },
  });
  assertEquals(
    diagnosticTypes(diagnostics).includes(
      "compute-context:local-reactive-use",
    ),
    false,
  );

  await transformSource(source, {
    types: { "commonfabric.d.ts": commonfabricTypes },
    typeCheck: true,
  });
});

Deno.test("an availability guard does not hide a reactive value created inside a compute", async () => {
  const { diagnostics } = await validateSource(
    `
    import { computed, generateText, isPending, pattern } from "commonfabric";

    export default pattern(() => {
      const status = computed(() => {
        const request = generateText({ prompt: "created too late" });
        const pending = isPending(request);
        if (pending) return "pending";
        return "ready";
      });
      return { status };
    });
  `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
    },
  );
  assertEquals(
    diagnosticTypes(diagnostics).includes(
      "compute-context:local-reactive-use",
    ),
    true,
  );
});

Deno.test("reports observeAvailability inside the compute boundary it tries to widen", async () => {
  const { diagnostics } = await validateSource(`
    import { computed, observeAvailability, pattern } from "commonfabric";

    export default pattern((input: { value: string }) => {
      const failed = computed(() =>
        observeAvailability(input.value, "error")
      );
      return { failed };
    });
  `);

  assertEquals(
    diagnosticTypes(diagnostics).includes(
      "availability:observation-inside-compute",
    ),
    true,
  );
});

Deno.test("an external selective observation authorizes the matching compute guard through an alias", async () => {
  const { diagnostics } = await validateSource(`
    import {
      computed,
      hasError,
      observeAvailability as observe,
      pattern,
    } from "commonfabric";

    export default pattern((input: { value: string }) => {
      const observed = observe(input.value, "error");
      const alias = observed;
      const failed = computed(() => hasError(alias));
      return { failed };
    });
  `);

  assertEquals(
    diagnosticTypes(diagnostics).includes(
      "availability:unobserved-compute-guard",
    ),
    false,
  );
});

Deno.test("computed canonicalizes request and resultOf alias to one guarded capture", async () => {
  const source = `
    import {
      AsyncResult,
      computed,
      hasError,
      isPending,
      pattern,
      resultOf,
    } from "commonfabric";

    type Repo = { name: string; url: string };

    export default pattern((input: { request: AsyncResult<Repo> }) => {
      const request = input.request;
      const result = resultOf(request);
      const requestState = request;
      const content = computed(() =>
        isPending(requestState)
          ? "pending"
          : hasError(requestState)
          ? requestState.error.message
          : result.name + result.url
      );
      return { content };
    });
  `;

  const output = await transformSource(source, {
    types: { "commonfabric.d.ts": commonfabricTypes },
    typeCheck: true,
  });
  const root = parseModule(output);
  const declaration = collect(root, ts.isVariableDeclaration).find((node) =>
    ts.isIdentifier(node.name) && node.name.text.startsWith("__cfLift_") &&
    node.initializer?.getText(root).includes("isPending")
  );
  assert(
    declaration?.initializer && ts.isCallExpression(declaration.initializer),
  );
  const liftCall = declaration.initializer;
  const inputType = liftCall.typeArguments?.[0]?.getText(root) ?? "";
  assertStringIncludes(inputType, "request");
  assertEquals(inputType.includes("result:"), false);

  const inputSchema = literalToValue(liftCall.arguments[1]!) as {
    properties: Record<string, unknown>;
  };
  assertEquals(Object.keys(inputSchema.properties), ["request"]);
  const options = literalToValue(liftCall.arguments.at(-1)!) as {
    unavailableInputPolicy: unknown;
  };
  assertEquals(options.unavailableInputPolicy, [
    { path: ["request"], reasons: ["pending", "error"] },
  ]);
  assertEquals(
    liftCall.arguments.at(-2)?.getText(root).includes("resultOf"),
    false,
  );
});

Deno.test("a synthesized guarded expression canonicalizes its resultOf alias", async () => {
  const output = await transformSource(
    `
    import {
      AsyncResult,
      hasError,
      isPending,
      pattern,
      resultOf,
    } from "commonfabric";

    type Repo = { name: string };

    export default pattern((input: { request: AsyncResult<Repo> }) => {
      const request = input.request;
      const result = resultOf(request);
      return {
        label: isPending(request)
          ? "pending"
          : hasError(request)
          ? request.error.message
          : result.name,
      };
    });
  `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
      typeCheck: true,
    },
  );
  const root = parseModule(output);
  const declarations = collect(root, ts.isVariableDeclaration).filter((node) =>
    ts.isIdentifier(node.name) && node.name.text.startsWith("__cfLift_") &&
    (node.initializer?.getText(root).includes("isPending") ||
      node.initializer?.getText(root).includes("hasError"))
  );
  assert(declarations.length > 0);
  const reasons = new Set<string>();
  for (const declaration of declarations) {
    assert(
      declaration.initializer && ts.isCallExpression(declaration.initializer),
    );
    const inputSchema = literalToValue(
      declaration.initializer.arguments[1]!,
    ) as {
      properties: Record<string, unknown>;
    };
    assertEquals(Object.keys(inputSchema.properties), ["request"]);
    const options = literalToValue(
      declaration.initializer.arguments.at(-1)!,
    ) as {
      unavailableInputPolicy: Array<{ reasons: string[] }>;
    };
    for (const entry of options.unavailableInputPolicy) {
      entry.reasons.forEach((reason) => reasons.add(reason));
    }
  }
  assertEquals([...reasons].sort(), ["error", "pending"]);
});

Deno.test("explicit lift canonicalizes a resultOf alias with its guarded source", async () => {
  const output = await transformSource(
    `
    import {
      AsyncResult,
      hasError,
      lift,
      pattern,
      resultOf,
    } from "commonfabric";

    type Repo = { name: string };

    export default pattern((input: { request: AsyncResult<Repo> }) => {
      const request = input.request;
      const result = resultOf(request);
      const label = lift(() =>
        hasError(request) ? request.error.message : result.name
      )({});
      return { label };
    });
  `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
      typeCheck: true,
    },
  );
  const root = parseModule(output);
  const declaration = collect(root, ts.isVariableDeclaration).find((node) =>
    ts.isIdentifier(node.name) && node.name.text.startsWith("__cfLift_") &&
    node.initializer?.getText(root).includes("hasError")
  );
  assert(
    declaration?.initializer && ts.isCallExpression(declaration.initializer),
  );
  const liftCall = declaration.initializer;
  const inputSchema = literalToValue(liftCall.arguments[1]!) as {
    properties: Record<string, unknown>;
  };
  assertEquals(Object.keys(inputSchema.properties), ["request"]);
  const options = literalToValue(liftCall.arguments.at(-1)!) as {
    unavailableInputPolicy: unknown;
  };
  assertEquals(options.unavailableInputPolicy, [
    { path: ["request"], reasons: ["error"] },
  ]);
});

Deno.test("resultOf canonicalization preserves an authored shorthand output key", async () => {
  const output = await transformSource(
    `
    import {
      AsyncResult,
      computed,
      hasError,
      pattern,
      resultOf,
    } from "commonfabric";

    type Repo = { name: string };

    export default pattern((input: { request: AsyncResult<Repo> }) => {
      const request = input.request;
      const result = resultOf(request);
      const state = request;
      const view = computed(() =>
        hasError(state) ? { result: undefined } : { result }
      );
      return { view };
    });
  `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
      typeCheck: true,
    },
  );

  assertStringIncludes(output, "{ result: request }");
});

Deno.test("a typed explicit lift parameter infers guard policy without observation", async () => {
  const output = await transformSource(
    `
    import { AsyncResult, hasError, lift } from "commonfabric";

    type Repo = { name: string };
    export const failed = lift(
      (request: AsyncResult<Repo>) => hasError(request),
    );
  `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
      typeCheck: true,
    },
  );

  assertStringIncludes(
    output,
    'unavailableInputPolicy: [{ path: [], reasons: ["error"] }]',
  );
  assertEquals(output.includes("observeAvailability"), false);
});

Deno.test("closure hoisting maps an explicit lift guard to the emitted input key", async () => {
  const output = await transformSource(
    `
    import { AsyncResult, hasError, lift, pattern } from "commonfabric";

    type Repo = { name: string };

    export default pattern((input: {
      request: AsyncResult<Repo>;
      suffix: string;
    }) => {
      const suffix = input.suffix;
      const failed = lift((value: AsyncResult<Repo>) =>
        hasError(value) ? suffix : "ok"
      )(input.request);
      return { failed };
    });
  `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
      typeCheck: true,
    },
  );

  assertStringIncludes(
    output,
    'unavailableInputPolicy: [{ path: ["request"], reasons: ["error"] }]',
  );
  assertEquals(
    output.includes('path: ["value"], reasons: ["error"]'),
    false,
  );
});

Deno.test("closure hoisting maps a destructured lift guard below the merged input key", async () => {
  const output = await transformSource(
    `
    import { AsyncResult, hasError, lift, pattern } from "commonfabric";

    type Repo = { name: string };

    export default pattern((input: {
      request: AsyncResult<Repo>;
      suffix: string;
    }) => {
      const suffix = input.suffix;
      const failed = lift(({ request }: { request: AsyncResult<Repo> }) =>
        hasError(request) ? suffix : "ok"
      )({ request: input.request });
      return { failed };
    });
  `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
      typeCheck: true,
    },
  );

  assertStringIncludes(
    output,
    'unavailableInputPolicy: [{ path: ["input", "request"], reasons: ["error"] }]',
  );
  assertEquals(
    output.includes('path: ["request"], reasons: ["error"]'),
    false,
  );
});

Deno.test("same-file helper guards contribute policy to their owning compute", async () => {
  const output = await transformSource(
    `
    import {
      AsyncResult,
      computed,
      hasError,
      pattern,
    } from "commonfabric";

    type Repo = { name: string };

    function failed(request: AsyncResult<Repo>) {
      return hasError(request);
    }

    export default pattern((input: { request: AsyncResult<Repo> }) => {
      const result = computed(() => failed(input.request));
      return { result };
    });
  `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
      typeCheck: true,
    },
  );

  assertStringIncludes(
    output,
    'unavailableInputPolicy: [{ path: ["input", "request"], reasons: ["error"] }]',
  );
});

Deno.test("same-file helper guard paths retain nested caller structure", async () => {
  const output = await transformSource(
    `
    import {
      AsyncResult,
      computed,
      hasError,
      pattern,
    } from "commonfabric";

    type Repo = { name: string };

    function failed(state: { request: AsyncResult<Repo> }) {
      return hasError(state.request);
    }

    export default pattern((input: { request: AsyncResult<Repo> }) => {
      const result = computed(() => failed(input));
      return { result };
    });
  `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
      typeCheck: true,
    },
  );

  assertStringIncludes(
    output,
    'unavailableInputPolicy: [{ path: ["input", "request"], reasons: ["error"] }]',
  );
});

Deno.test("a helper parameter cannot widen a plain caller input implicitly", async () => {
  const { diagnostics } = await validateSource(
    `
    import {
      AsyncResult,
      computed,
      hasError,
      pattern,
    } from "commonfabric";

    type Repo = { name: string };

    function failed(request: AsyncResult<Repo>) {
      return hasError(request);
    }

    export default pattern((input: { repo: Repo }) => {
      const result = computed(() => failed(input.repo));
      return { result };
    });
  `,
    { types: { "commonfabric.d.ts": commonfabricTypes } },
  );

  assertEquals(
    diagnosticTypes(diagnostics).includes(
      "availability:unobserved-compute-guard",
    ),
    true,
  );
});

Deno.test("a local AsyncResult name does not authorize unavailable input", async () => {
  const { diagnostics } = await validateSource(
    `
    import { computed, hasError, pattern } from "commonfabric";

    interface AsyncResult {
      local: string;
    }

    export default pattern((input: { value: AsyncResult }) => {
      const failed = computed(() => hasError(input.value));
      return { failed };
    });
  `,
    { types: { "commonfabric.d.ts": commonfabricTypes } },
  );

  assertEquals(
    diagnosticTypes(diagnostics).includes(
      "availability:unobserved-compute-guard",
    ),
    true,
  );
});

Deno.test("a concrete type name containing a variant name still receives the marker arm", async () => {
  const output = await transformSource(
    `
    import { hasError, pattern } from "commonfabric";

    interface HasErrorEnvelope {
      local: string;
    }

    export default pattern((input: { value: HasErrorEnvelope }) => ({
      failed: hasError(input.value),
    }));
  `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
      typeCheck: true,
    },
  );

  assertStringIncludes(
    output,
    "value: HasErrorEnvelope | __cfHelpers.HasError",
  );
});

Deno.test("object-rest guard paths map back to the source object", async () => {
  const output = await transformSource(
    `
    import { AsyncResult, hasError, lift, pattern } from "commonfabric";

    type Repo = { name: string };

    export default pattern((input: { request: AsyncResult<Repo> }) => {
      const failed = lift(({
        ...rest
      }: { request: AsyncResult<Repo> }) => hasError(rest.request))({
        request: input.request,
      });
      return { failed };
    });
  `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
      typeCheck: true,
    },
  );

  assertStringIncludes(
    output,
    'unavailableInputPolicy: [{ path: ["request"], reasons: ["error"] }]',
  );
  assertEquals(output.includes('path: ["rest", "request"]'), false);
});

Deno.test("array-rest guard indices map back to source tuple positions", async () => {
  const output = await transformSource(
    `
    import { AsyncResult, hasError, lift, pattern } from "commonfabric";

    type Repo = { name: string };

    export default pattern((input: { request: AsyncResult<Repo> }) => {
      const failed = lift(([
        _head,
        ...rest
      ]: [string, AsyncResult<Repo>]) => hasError(rest[0]))([
        "head",
        input.request,
      ]);
      return { failed };
    });
  `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
      typeCheck: true,
    },
  );

  assertStringIncludes(
    output,
    'unavailableInputPolicy: [{ path: ["1"], reasons: ["error"] }]',
  );
  assertEquals(output.includes('path: ["1", "0"]'), false);
});

Deno.test("pending error and success JSX shares one physical async capture", async () => {
  const output = await transformSource(
    `
    import {
      AsyncResult,
      hasError,
      isPending,
      pattern,
      resultOf,
    } from "commonfabric";

    type Repo = { name: string; url: string };

    export default pattern((input: { request: AsyncResult<Repo> }) => {
      const request = input.request;
      const result = resultOf(request);
      return isPending(request)
        ? <div>Loading repository...</div>
        : hasError(request)
        ? <div>Error: {request.error.message}</div>
        : <a href={result.url}>{result.name}</a>;
    });
  `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
      typeCheck: true,
    },
  );

  const root = parseModule(output);
  const generatedLifts = collect(root, ts.isVariableDeclaration).filter((
    node,
  ) =>
    ts.isIdentifier(node.name) && node.name.text.startsWith("__cfLift_") &&
    node.initializer && ts.isCallExpression(node.initializer)
  );
  assert(generatedLifts.length > 0);
  for (const declaration of generatedLifts) {
    assert(
      declaration.initializer && ts.isCallExpression(declaration.initializer),
    );
    const inputSchema = literalToValue(
      declaration.initializer.arguments[1]!,
    ) as {
      properties?: Record<string, unknown>;
    };
    assertEquals(
      Object.keys(inputSchema.properties ?? {}).includes("result"),
      false,
    );
  }
  assertStringIncludes(output, 'path: ["request"]');
});

Deno.test("a selective observation does not authorize a different reason", async () => {
  const { diagnostics } = await validateSource(`
    import {
      computed,
      isPending,
      observeAvailability,
      pattern,
    } from "commonfabric";

    export default pattern((input: { value: string }) => {
      const observed = observeAvailability(input.value, "error");
      const pending = computed(() => isPending(observed));
      return { pending };
    });
  `);

  assertEquals(
    diagnosticTypes(diagnostics).includes(
      "availability:unobserved-compute-guard",
    ),
    true,
  );
});

Deno.test("an observed computed capture survives aliasing and hoisting with aligned artifacts", async () => {
  const output = await transformSource(`
    import {
      computed,
      hasError,
      observeAvailability,
      pattern,
    } from "commonfabric";

    export default pattern((input: { value: string }) => {
      const observed = observeAvailability(input.value, "error");
      const alias = observed;
      const failed = computed(() => hasError(alias));
      return { failed };
    });
  `);
  const root = parseModule(output);
  const declaration = collect(root, ts.isVariableDeclaration).find((node) =>
    ts.isIdentifier(node.name) && node.name.text.startsWith("__cfLift_")
  );
  assert(
    declaration?.initializer && ts.isCallExpression(declaration.initializer),
  );
  const liftCall = declaration.initializer;

  assertStringIncludes(
    liftCall.typeArguments?.[0]?.getText(root) ?? "",
    "alias: string | __cfHelpers.HasError",
  );
  assertEquals(liftCall.typeArguments?.[1]?.getText(root), "boolean");

  const inputSchema = literalToValue(liftCall.arguments[1]!) as {
    properties: { alias: Record<string, unknown> };
  };
  assert(Array.isArray(inputSchema.properties.alias.anyOf));
  assertEquals(
    (inputSchema.properties.alias.anyOf as unknown[]).includes(true),
    false,
  );
  assertEquals(literalToValue(liftCall.arguments[2]!), {
    type: "boolean",
  });

  const options = literalToValue(liftCall.arguments.at(-1)!) as {
    unavailableInputPolicy: unknown;
  };
  assertEquals(options.unavailableInputPolicy, [
    { path: ["alias"], reasons: ["error"] },
  ]);
  assertStringIncludes(output, "=> hasError(alias)");
});

Deno.test("an observed lift input is widened at its outer boundary", async () => {
  const output = await transformSource(`
    import { hasError, lift, observeAvailability, pattern } from "commonfabric";

    export default pattern((input: { value: string }) => {
      const observed = observeAvailability(input.value, "error");
      const failed = lift((value) => hasError(value))(observed);
      return { failed };
    });
  `);

  assertStringIncludes(
    output,
    "observed: string | __cfHelpers.HasError",
  );
  assertStringIncludes(
    output,
    'unavailableInputPolicy: [{ path: ["observed"], reasons: ["error"] }]',
  );
  assertStringIncludes(output, "({ observed: value }) => hasError(value)");
});

Deno.test("a destructured lift input maps observation to its emitted nested path", async () => {
  const source = `
    import { hasError, lift, observeAvailability, pattern } from "commonfabric";

    export default pattern((input: { value: string }) => {
      const observed = observeAvailability(input.value, "error");
      const failed = lift(({ value }) => hasError(value))({ value: observed });
      return { failed };
    });
  `;
  const { diagnostics } = await validateSource(source);
  assertEquals(
    diagnosticTypes(diagnostics).includes(
      "availability:unobserved-compute-guard",
    ),
    false,
  );

  const output = await transformSource(source);
  assertStringIncludes(
    output,
    "value: string | __cfHelpers.HasError",
  );
  assertStringIncludes(
    output,
    'unavailableInputPolicy: [{ path: ["input", "value"], reasons: ["error"] }]',
  );
  assertStringIncludes(output, "({ input: { value } }) => hasError(value)");
});

Deno.test("capture collision renaming is reflected in schema and policy paths", async () => {
  const output = await transformSource(`
    import { hasError, lift, observeAvailability, pattern } from "commonfabric";

    export default pattern((input: { value: string }) => {
      const observed = observeAvailability(input.value, "error");
      const failed = lift((_value) => hasError(observed))(observed);
      return { failed };
    });
  `);

  assertStringIncludes(
    output,
    "observed: string | __cfHelpers.HasError",
  );
  assertStringIncludes(
    output,
    "observed_1: string | __cfHelpers.HasError",
  );
  assertStringIncludes(
    output,
    'unavailableInputPolicy: [{ path: ["observed"], reasons: ["error"] }, { path: ["observed_1"], reasons: ["error"] }]',
  );
});

Deno.test("an omitted observation reason widens and authorizes every variant", async () => {
  const output = await transformSource(`
    import { computed, observeAvailability, pattern } from "commonfabric";

    export default pattern((input: { value: string }) => {
      const observed = observeAvailability(input.value);
      const copy = computed(() => observed);
      return { copy };
    });
  `);

  for (
    const variant of [
      "IsPending",
      "HasError",
      "IsSyncing",
      "HasSchemaMismatch",
    ]
  ) {
    assertStringIncludes(output, `__cfHelpers.${variant}`);
  }
  assertStringIncludes(
    output,
    'reasons: ["pending", "error", "syncing", "schema-mismatch"]',
  );
});

Deno.test("a generic named value keeps its concrete arm beside the observed variant", async () => {
  const output = await transformSource(
    `
    import {
      computed,
      hasError,
      observeAvailability,
      pattern,
    } from "commonfabric";

    type Box<T> = { value: T };
    type Item = { id: string };

    export default pattern<Box<Item>>((input) => {
      const observed = observeAvailability(input.value, "error");
      const failed = computed(() => hasError(observed));
      return { failed };
    });
  `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
      typeCheck: true,
    },
  );

  assertStringIncludes(
    output,
    "observed: Item | __cfHelpers.HasError",
  );
  assertStringIncludes(output, '$ref: "#/$defs/Item"');
  assertEquals(output.includes('$ref: "#/$defs/HasError"'), false);
  const root = parseModule(output);
  const declaration = collect(root, ts.isVariableDeclaration).find((node) =>
    ts.isIdentifier(node.name) && node.name.text.startsWith("__cfLift_")
  );
  assert(
    declaration?.initializer && ts.isCallExpression(declaration.initializer),
  );
  const inputSchema = literalToValue(declaration.initializer.arguments[1]!) as {
    properties: { observed: { anyOf: unknown[] } };
  };
  assertEquals(
    inputSchema.properties.observed.anyOf.includes(true),
    false,
  );
  assertEquals(
    inputSchema.properties.observed.anyOf.some((arm) =>
      JSON.stringify(arm) === JSON.stringify({ type: "object" })
    ),
    true,
  );
});

Deno.test("an authored same-named type does not collide with the availability schema arm", async () => {
  const output = await transformSource(
    `
    import {
      computed,
      hasError,
      observeAvailability,
      pattern,
    } from "commonfabric";

    type HasError = { local: string };

    export default pattern((input: { value: string }) => {
      const observed = observeAvailability(input.value, "error");
      const local: HasError = { local: "ordinary data" };
      const result = computed(() => hasError(observed) ? local : local);
      return { result };
    });
  `,
    {
      types: { "commonfabric.d.ts": commonfabricTypes },
      typeCheck: true,
    },
  );

  assertStringIncludes(output, '$ref: "#/$defs/HasError"');
  assertStringIncludes(output, "local: HasError");
  assertStringIncludes(
    output,
    'HasError: {\n            type: "object",\n            properties: {\n                local: {\n                    type: "string"',
  );
});

Deno.test("a direct pattern guard widens only its probed capture and emits exact policy", async () => {
  const output = await transformSource(`
    import { hasError, pattern } from "commonfabric";

    export default pattern((input: { value: string; other: number }) => ({
      failed: hasError(input.value),
      other: input.other,
    }));
  `);
  const root = parseModule(output);
  const declaration = collect(root, ts.isVariableDeclaration).find((node) =>
    ts.isIdentifier(node.name) && node.name.text.startsWith("__cfLift_")
  );
  assert(
    declaration?.initializer && ts.isCallExpression(declaration.initializer),
  );
  const liftCall = declaration.initializer;
  const inputType = liftCall.typeArguments?.[0];
  assert(inputType);
  assertStringIncludes(
    inputType.getText(root),
    "string | __cfHelpers.HasError",
  );
  assertEquals(inputType.getText(root).includes("other"), false);
  assertEquals(liftCall.typeArguments?.[1]?.getText(root), "boolean");

  const options = literalToValue(liftCall.arguments.at(-1)!) as {
    unavailableInputPolicy: unknown;
  };
  assertEquals(options.unavailableInputPolicy, [
    { path: ["input", "value"], reasons: ["error"] },
  ]);

  const inputSchema = literalToValue(liftCall.arguments[1]!) as {
    properties: { input: { properties: { value: Record<string, unknown> } } };
  };
  const valueSchema = inputSchema.properties.input.properties.value;
  assert(Array.isArray(valueSchema.anyOf));
  assertEquals((valueSchema.anyOf as unknown[]).includes(true), false);
  assertEquals(literalToValue(liftCall.arguments[2]!), {
    type: "boolean",
  });
});

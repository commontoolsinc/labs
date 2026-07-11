import { assert, assertEquals } from "@std/assert";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { callsNamed, literalToValue, parseModule } from "./transformed-ast.ts";
import { transformSource } from "./utils.ts";

function invokeFactoryContracts(output: string): Record<string, unknown>[] {
  const root = parseModule(output);
  return callsNamed(root, "invokeFactory").map((call) => {
    assertEquals(call.arguments.length, 3);
    const contract = literalToValue(call.arguments[2]!);
    assert(
      typeof contract === "object" && contract !== null &&
        !Array.isArray(contract),
    );
    return contract as Record<string, unknown>;
  });
}

Deno.test(
  "symbolic lowering follows properties and typed element access for every factory kind",
  async () => {
    const output = await transformSource(
      `
      import {
        pattern,
        type HandlerFactory,
        type ModuleFactory,
        type PatternFactory,
      } from "commonfabric";

      interface Input { value: number }
      interface Output { result: number }
      type PatternOperation = PatternFactory<Input, Output>;
      type ModuleOperation = ModuleFactory<Input, Output>;
      type EventOperation = HandlerFactory<Input, Output>;

      export default pattern<{
        patterns: Record<string, PatternOperation>;
        module: ModuleOperation;
        handler: EventOperation;
        key: string;
        value: number;
      }>((input) => ({
        patternResult: input.patterns[input.key]!({ value: input.value }),
        moduleResult: input.module({ value: input.value }),
        events: input.handler({ value: input.value }),
      }));
    `,
      {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
      },
    );

    const contracts = invokeFactoryContracts(output);
    assertEquals(
      contracts.map((contract) => contract.kind).sort(),
      ["handler", "module", "pattern"],
    );
    const handler = contracts.find((contract) => contract.kind === "handler")!;
    assert("contextSchema" in handler);
    assert("eventSchema" in handler);
    assert(!("argumentSchema" in handler));
  },
);

Deno.test(
  "factory parameters delivered to lift and handler callbacks remain direct",
  async () => {
    const output = await transformSource(
      `
      import {
        handler,
        lift,
        type ModuleFactory,
        type PatternFactory,
      } from "commonfabric";

      interface Input { value: number }
      interface Output { result: number }

      export const apply = lift((input: {
        operation: PatternFactory<Input, Output>;
        value: number;
      }) => input.operation({ value: input.value }));

      export const react = handler((event: {
        operation: PatternFactory<Input, Output>;
        value: number;
      }, context: {
        operation: ModuleFactory<Input, Output>;
        value: number;
      }) => {
        event.operation({ value: event.value });
        context.operation({ value: context.value });
      });
    `,
      {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
      },
    );

    assertEquals(invokeFactoryContracts(output), []);
    const root = parseModule(output);
    assertEquals(callsNamed(root, "operation").length, 3);
    assert(
      output.includes("asFactory"),
      "scheduled callback schemas must retain factory contracts",
    );
  },
);

Deno.test(
  "an eager factory capture becomes a direct scheduled input inside computed",
  async () => {
    const output = await transformSource(
      `
      import { computed, pattern, type PatternFactory } from "commonfabric";

      interface Input { value: number }
      interface Output { result: number }

      export default pattern<{
        operation: PatternFactory<Input, Output>;
        value: number;
      }>((input) => {
        const result = computed(() =>
          input.operation({ value: input.value })
        );
        return { result };
      });
    `,
      {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
      },
    );

    assertEquals(invokeFactoryContracts(output), []);
    assert(
      output.includes("asFactory"),
      "closure conversion must declare the captured factory input contract",
    );
  },
);

Deno.test(
  "nested array callbacks do not hide an enclosing scheduled materialization boundary",
  async () => {
    const output = await transformSource(
      `
      import { computed, pattern, type PatternFactory } from "commonfabric";

      interface Input { value: number }
      interface Output { result: number }

      export default pattern<{
        operation: PatternFactory<Input, Output>;
        values: number[];
      }>((input) => {
        const results = computed(() =>
          input.values.map((value) => input.operation({ value }))
        );
        return { results };
      });
    `,
      {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
      },
    );

    assertEquals(
      invokeFactoryContracts(output),
      [],
      "the enclosing computed/lift boundary materializes the captured factory",
    );
    assert(output.includes("asFactory"));
  },
);

Deno.test(
  "a nested eager pattern boundary makes an outer scheduled factory capture symbolic again",
  async () => {
    const output = await transformSource(
      `
      import { lift, pattern, type PatternFactory } from "commonfabric";

      interface Input { value: number }
      interface Output { result: number }

      export const makeNested = lift((input: {
        operation: PatternFactory<Input, Output>;
      }) => pattern<Input, Output>((argument) =>
        input.operation(argument)
      ));
    `,
      {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
      },
    );

    assertEquals(
      invokeFactoryContracts(output).length,
      1,
      "the nested pattern callback owns a new symbolic closure-param binding",
    );
  },
);

Deno.test(
  "an eager factory capture in a nested pattern-owned callback stays symbolic",
  async () => {
    const output = await transformSource(
      `
      import { pattern, type PatternFactory } from "commonfabric";

      interface Input { value: number }
      interface Output { result: number }

      export default pattern<{
        operation: PatternFactory<Input, Output>;
        values: number[];
      }>((input) => ({
        results: input.values.map((value) =>
          input.operation({ value })
        ),
      }));
    `,
      {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
      },
    );

    assertEquals(invokeFactoryContracts(output).length, 1);
  },
);

Deno.test(
  "live factory modifier chains are not lowered as plain module data",
  async () => {
    const output = await transformSource(
      `
      import { pattern } from "commonfabric";

      const base = pattern<{ value: number }, { value: number }>(
        ({ value }) => ({ value }),
      );

      export default base.asScope("space").inSpace();
    `,
      {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
      },
    );

    assertEquals(
      callsNamed(parseModule(output), "__cf_data").length,
      0,
      "a derived callable factory must not be wrapped as plain data",
    );
  },
);

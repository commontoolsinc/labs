import { assertEquals } from "@std/assert";
import "@commonfabric/api/schema";
import type {
  Cell,
  Default,
  FabricValue,
  FactoryInput,
  HandlerFactory,
  HandlerState as ScheduledHandlerState,
  JSONSchema,
  ModuleFactory,
  PatternFactory,
  PatternFactorySchema,
  PatternFunction,
  Reactive,
  SELF,
  StripCell,
  WishFunction,
  WishParams,
  WishState,
  Writable,
} from "@commonfabric/api";
import type { Schema, SchemaWithoutCell } from "@commonfabric/api/schema";

type MustBeTrue<T extends true> = T;
type MustBeFalse<T extends false> = T;
type AssertAssignable<T, U> = [T] extends [U] ? true : never;
type AssertNotAssignable<T, U> = [T] extends [U] ? never : true;
type IsAny<T> = 0 extends (1 & T) ? true : false;
type IsUnknown<T> = IsAny<T> extends true ? false
  : unknown extends T ? true
  : false;

interface Ship {
  name: string;
}

interface PlayerData {
  name: string;
  ships: Ship[];
}

type PlayerCell = Writable<PlayerData | null | Default<null>>;
type ReactivePlayerData = {
  name: FactoryInput<string>;
  ships: Array<FactoryInput<Ship>>;
};

interface HandlerState {
  name: string;
  player1: PlayerCell;
}

interface RoomInput {
  player1: PlayerCell;
}

type HandlerBinding = {
  name: FactoryInput<string>;
  player1: Writable<ReactivePlayerData | null>;
};

type RoomBinding = {
  player1: Writable<ReactivePlayerData | null>;
};

type WrongRoomBinding = {
  player1: Writable<
    {
      name: FactoryInput<number>;
      ships: Array<FactoryInput<Ship>>;
    } | null
  >;
};

const _handlerBinding: MustBeTrue<
  AssertAssignable<HandlerBinding, FactoryInput<StripCell<HandlerState>>>
> = true;

const _roomBinding: MustBeTrue<
  AssertAssignable<RoomBinding, FactoryInput<StripCell<RoomInput>>>
> = true;

const _handlerFactory: MustBeTrue<
  AssertAssignable<
    HandlerFactory<HandlerState, void>,
    (inputs: HandlerBinding) => unknown
  >
> = true;

const _patternFactory: MustBeTrue<
  AssertAssignable<
    PatternFactory<StripCell<RoomInput>, unknown>,
    (inputs: RoomBinding) => unknown
  >
> = true;

const _wrongRoomBinding: MustBeTrue<
  AssertNotAssignable<WrongRoomBinding, FactoryInput<StripCell<RoomInput>>>
> = true;

type SchemaPatternOverloadAcceptsFactoryInput = PatternFunction extends {
  <IS extends JSONSchema = JSONSchema, OS extends JSONSchema = JSONSchema>(
    fn: (
      input: Reactive<Schema<IS>> & { [SELF]: Reactive<Schema<OS>> },
    ) => FactoryInput<Schema<OS>>,
    argumentSchema: IS,
    resultSchema: OS,
  ): PatternFactory<SchemaWithoutCell<IS>, Schema<OS>>;
} ? true
  : never;

type SchemaWishOverloadAcceptsFactoryInput = WishFunction extends {
  <S extends JSONSchema = JSONSchema>(
    target: FactoryInput<WishParams>,
    schema: S,
  ): Reactive<WishState<Schema<S>>>;
} ? true
  : never;

const _schemaPatternOverload: MustBeTrue<
  SchemaPatternOverloadAcceptsFactoryInput
> = true;

const _schemaWishOverload: MustBeTrue<
  SchemaWishOverloadAcceptsFactoryInput
> = true;

const PATTERN_FACTORY_SCHEMA = {
  asFactory: {
    kind: "pattern",
    argumentSchema: {
      $ref: "#/$defs/PatternInput",
      $defs: {
        PatternInput: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    },
    resultSchema: {
      $ref: "#/$defs/PatternResult",
      $defs: {
        PatternResult: {
          type: "object",
          properties: { count: { type: "number" } },
          required: ["count"],
        },
      },
    },
  },
} as const satisfies JSONSchema;

const MODULE_FACTORY_SCHEMA = {
  asFactory: {
    kind: "module",
    argumentSchema: {
      type: "object",
      properties: { value: { type: "number" } },
      required: ["value"],
    },
    resultSchema: { type: "string" },
  },
} as const satisfies JSONSchema;

const HANDLER_FACTORY_SCHEMA = {
  asFactory: {
    kind: "handler",
    contextSchema: {
      type: "object",
      properties: { prefix: { type: "string" } },
      required: ["prefix"],
    },
    eventSchema: {
      type: "object",
      properties: { value: { type: "number" } },
      required: ["value"],
    },
  },
} as const satisfies JSONSchema;

const NESTED_AND_CELL_FACTORY_SCHEMA = {
  type: "object",
  properties: {
    direct: { asFactory: PATTERN_FACTORY_SCHEMA.asFactory },
    boxed: {
      asFactory: PATTERN_FACTORY_SCHEMA.asFactory,
      asCell: ["cell"],
    },
  },
  required: ["direct", "boxed"],
} as const satisfies JSONSchema;

type InferredPatternFactory = Schema<typeof PATTERN_FACTORY_SCHEMA>;
type InferredModuleFactory = SchemaWithoutCell<typeof MODULE_FACTORY_SCHEMA>;
type InferredHandlerFactory = Schema<typeof HANDLER_FACTORY_SCHEMA>;
type InferredNestedFactories = Schema<typeof NESTED_AND_CELL_FACTORY_SCHEMA>;

const EMBEDDED_LOCAL_REF_FACTORY_SCHEMA = {
  asFactory: {
    kind: "pattern",
    argumentSchema: {
      $ref: "#/$defs/Input",
      $defs: {
        Input: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    },
    resultSchema: {
      $ref: "#/$defs/Output",
      $defs: {
        Output: {
          type: "object",
          properties: { count: { type: "number" } },
          required: ["count"],
        },
      },
    },
  },
} as const satisfies JSONSchema;
type InferredEmbeddedLocalRefFactory = Schema<
  typeof EMBEDDED_LOCAL_REF_FACTORY_SCHEMA
>;

const HIGHER_ORDER_FACTORY_SCHEMA = {
  asFactory: {
    kind: "pattern",
    argumentSchema: {
      type: "object",
      properties: {
        operation: {
          asFactory: {
            kind: "module",
            argumentSchema: { type: "number" },
            resultSchema: { type: "string" },
          },
        },
      },
      required: ["operation"],
    },
    resultSchema: { type: "null" },
  },
} as const satisfies JSONSchema;
type InferredHigherOrderFactory = Schema<typeof HIGHER_ORDER_FACTORY_SCHEMA>;
type InferredHigherOrderArgument = InferredHigherOrderFactory extends
  PatternFactory<infer Argument, unknown> ? Argument : never;

type MixedBroadNestedFactorySchema = {
  readonly asFactory: {
    readonly kind: "pattern";
    readonly argumentSchema: {
      readonly type: "object";
      readonly properties: {
        readonly operation: {
          readonly asFactory:
            | PatternFactorySchema
            | typeof MODULE_FACTORY_SCHEMA.asFactory;
        };
      };
      readonly required: readonly ["operation"];
    };
    readonly resultSchema: { readonly type: "null" };
  };
};
type InferredMixedBroadNestedFactory = Schema<MixedBroadNestedFactorySchema>;
type InferredMixedBroadNestedArgument = InferredMixedBroadNestedFactory extends
  PatternFactory<infer Argument, unknown> ? Argument : never;

type RecursiveFactorySchema = {
  readonly asFactory: {
    readonly kind: "pattern";
    readonly argumentSchema: {
      readonly type: "object";
      readonly properties: {
        readonly recurse: RecursiveFactorySchema;
      };
      readonly required: readonly ["recurse"];
    };
    readonly resultSchema: { readonly type: "null" };
  };
};
type InferredRecursiveFactory = Schema<RecursiveFactorySchema>;

const OUTER_DEFS_FACTORY_SCHEMA = {
  asFactory: {
    kind: "pattern",
    argumentSchema: { $ref: "#/$defs/BorrowedInput" },
    resultSchema: { type: "null" },
  },
  $defs: {
    BorrowedInput: {
      type: "object",
      properties: { borrowed: { type: "string" } },
      required: ["borrowed"],
    },
  },
} as const satisfies JSONSchema;
type InferredOuterDefsFactory = Schema<typeof OUTER_DEFS_FACTORY_SCHEMA>;

const _patternFactoryInference: MustBeTrue<
  AssertAssignable<
    InferredPatternFactory,
    PatternFactory<{ query: string }, { count: number }>
  >
> = true;
const _moduleFactoryInference: MustBeTrue<
  AssertAssignable<
    InferredModuleFactory,
    ModuleFactory<{ value: number }, string>
  >
> = true;
const _handlerFactoryInference: MustBeTrue<
  AssertAssignable<
    InferredHandlerFactory,
    HandlerFactory<{ prefix: string }, { value: number }>
  >
> = true;
const _factoryInferenceIsNotAny: MustBeFalse<IsAny<InferredPatternFactory>> =
  false;

void ((factory: InferredEmbeddedLocalRefFactory) => {
  factory({ query: "weather" });
  // @ts-expect-error Embedded factory-local refs retain their input contract.
  factory({ query: 42 });
});
void ((factory: InferredHigherOrderFactory) => {
  const acceptsHigherOrder: PatternFactory<
    { operation: ModuleFactory<number, string> },
    null
  > = factory;
  void acceptsHigherOrder;
});
void ((factory: InferredOuterDefsFactory) => {
  // @ts-expect-error Factory public schemas are independent documents and
  // cannot resolve local refs from the containing value schema.
  factory({ borrowed: "outer" });
});
const _higherOrderNestedFactory: MustBeTrue<
  AssertAssignable<
    InferredHigherOrderArgument["operation"],
    ModuleFactory<number, string>
  >
> = true;
const _mixedBroadNestedFactoryFailsClosed: MustBeTrue<
  IsUnknown<InferredMixedBroadNestedArgument["operation"]>
> = true;
const _recursiveFactoryGuard: MustBeFalse<IsAny<InferredRecursiveFactory>> =
  false;
const _factoryIsFabricValue: MustBeTrue<
  AssertAssignable<InferredPatternFactory, FabricValue>
> = true;
const _nestedDirectFactory: MustBeTrue<
  AssertAssignable<
    InferredNestedFactories["direct"],
    PatternFactory<{ query: string }, { count: number }>
  >
> = true;
const _explicitCellFactory: MustBeTrue<
  AssertAssignable<
    InferredNestedFactories["boxed"],
    Cell<PatternFactory<{ query: string }, { count: number }>>
  >
> = true;

type ScheduledFactoryContext = ScheduledHandlerState<{
  pattern: PatternFactory<{ query: string }, { count: number }>;
  module: ModuleFactory<{ value: number }, string>;
  handler: HandlerFactory<{ prefix: string }, { value: number }>;
}>;
const _scheduledPatternRemainsCallable: MustBeTrue<
  AssertAssignable<
    ScheduledFactoryContext["pattern"],
    PatternFactory<{ query: string }, { count: number }>
  >
> = true;
const _scheduledModuleRemainsCallable: MustBeTrue<
  AssertAssignable<
    ScheduledFactoryContext["module"],
    ModuleFactory<{ value: number }, string>
  >
> = true;
const _scheduledHandlerRemainsCallable: MustBeTrue<
  AssertAssignable<
    ScheduledFactoryContext["handler"],
    HandlerFactory<{ prefix: string }, { value: number }>
  >
> = true;

function assertFactoryCallBoundaries(factory: InferredPatternFactory) {
  factory({ query: "weather" });
  // @ts-expect-error PatternFactory input generics must reject the wrong type.
  factory({ query: 42 });
  // @ts-expect-error .curry is transformer-only and absent from the public API.
  factory.curry({});
}

declare const authoredPattern: PatternFunction;
void (() => {
  // @ts-expect-error Public pattern callbacks have no authored params slot.
  authoredPattern((_argument: unknown, _params: unknown) => ({}));
});

Deno.test("FactoryInput accepts reactive cell handles in factory bindings", async () => {
  const schemaModule = await import("@commonfabric/api/schema");

  assertEquals(
    [
      typeof schemaModule,
      _handlerBinding,
      _roomBinding,
      _handlerFactory,
      _patternFactory,
      _wrongRoomBinding,
      _schemaPatternOverload,
      _schemaWishOverload,
      _patternFactoryInference,
      _moduleFactoryInference,
      _handlerFactoryInference,
      _factoryInferenceIsNotAny,
      _recursiveFactoryGuard,
      _mixedBroadNestedFactoryFailsClosed,
      _factoryIsFabricValue,
      _nestedDirectFactory,
      _explicitCellFactory,
      _scheduledPatternRemainsCallable,
      _scheduledModuleRemainsCallable,
      _scheduledHandlerRemainsCallable,
      typeof assertFactoryCallBoundaries,
    ],
    [
      "object",
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      "function",
    ],
  );
});

declare const FABRIC_FACTORY_TYPE: unique symbol;
declare const EXTRA_BRAND: unique symbol;

type FactoryInput<T> = T;
type FabricFactory<Args extends unknown[], Result> = {
  readonly [FABRIC_FACTORY_TYPE]: { readonly args: Args; readonly result: Result };
};
type PatternFactory<T, R> =
  & ((inputs: FactoryInput<T>) => Reactive<R>)
  & FabricFactory<[FactoryInput<T>], Reactive<R>>
  & { argumentSchema: object; resultSchema: object };
type ModuleFactory<T, R> =
  & ((inputs: FactoryInput<T>) => Reactive<R>)
  & FabricFactory<[FactoryInput<T>], Reactive<R>>
  & { type: "ref" | "javascript" };
type HandlerFactory<T, E> =
  & ((context: FactoryInput<T>) => Stream<E>)
  & FabricFactory<[FactoryInput<T>], Stream<E>>
  & { type: "ref" | "javascript"; with(inputs: FactoryInput<T>): Stream<E> };

type PatternAlias<T, R> = PatternFactory<T, R>;
type BrandedModule<T, R> = ModuleFactory<T, R> & {
  readonly [EXTRA_BRAND]: true;
};

interface SchemaRoot {
  inputFactory: PatternAlias<{ query: string }, { count: number }>;
  outputFactory: BrandedModule<{ value: number }, string>;
  capture: {
    handlers: HandlerFactory<{ room: string }, { body: string }>[];
  };
  byRefResult: ModuleFactory<{ id: string }, { ok: boolean }>;
  selected:
    | PatternFactory<{ query: string }, string>
    | HandlerFactory<{ room: string }, { body: string }>;
}

import { TILE_UI, UI, type VNode } from "commonfabric";
import type {
  LaunchedPatternInfo,
  LaunchedPatternResult,
  PatternOutput,
} from "./email-pattern-launcher.tsx";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true
  : false;
type Expect<T extends true> = T;

type PendingIsBoolean = Expect<
  Equal<LaunchedPatternInfo["pending"], boolean>
>;
type ErrorIsStringOrNull = Expect<
  Equal<LaunchedPatternInfo["error"], string | null>
>;
type ResultIsKnownLauncherBoundary = Expect<
  Equal<LaunchedPatternInfo["result"], LaunchedPatternResult | null>
>;
type OutputTileIsVNode = Expect<Equal<PatternOutput[typeof TILE_UI], VNode>>;
type ResultUiStaysUnknownUntilNarrowed = Expect<
  Equal<LaunchedPatternResult[typeof UI], unknown>
>;
type ResultTileStaysUnknownUntilNarrowed = Expect<
  Equal<LaunchedPatternResult[typeof TILE_UI], unknown>
>;
type ChildSpecificFieldsStayUnknown = Expect<
  Equal<LaunchedPatternResult["childSpecificField"], unknown>
>;

const unknownChild = {} as unknown;
// @ts-expect-error JSX children must be known renderable values.
const unknownChildInJsx = <div>{unknownChild}</div>;

void unknownChildInJsx;

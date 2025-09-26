/// <cts-enable />
import { lift } from "commontools";

type LiftArgs = {
  value: number;
};

type LiftResult = {
  doubled: number;
};

export const doubleValue = lift((args: LiftArgs): LiftResult => ({
  doubled: args.value * 2,
}));

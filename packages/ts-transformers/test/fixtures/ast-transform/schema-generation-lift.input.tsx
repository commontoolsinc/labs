/// <cts-enable />
import { lift } from "commontools";

type LiftArgs = {
  value: number;
};

type LiftResult = {
  doubled: number;
};

export const doubleValue = lift<LiftArgs, LiftResult>(({ value }) => ({
  doubled: value * 2,
}));

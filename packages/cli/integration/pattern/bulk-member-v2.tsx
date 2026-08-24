/**
 * The "next generation" of `bulk-member.tsx`, for the bulk-survey drill. The
 * drill never deploys it: it is the `--retarget` source whose computed
 * identity the survey stamps onto member rows, and the assertion is that the
 * stamp differs from the identity the members currently run. The only
 * difference from generation one is the field a retarget would change.
 */

import { NAME, pattern, type PatternFactory } from "commonfabric";

export interface MemberInput {
  title: string;
}

export interface MemberOutput {
  [NAME]: string;
  title: string;
  /** Which generation of this fixture the member runs. */
  generation: string;
}

export const Member: PatternFactory<MemberInput, MemberOutput> = pattern<
  MemberInput,
  MemberOutput
>(({ title }) => ({
  [NAME]: title,
  title,
  generation: "two",
}));

/**
 * The tests every read-budget test file registers for its group of cases, so
 * that each group's file holds its cases to the same checks. Each case runs in
 * the test's own process, through the same phases the probe measures.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { caseNamed, measureCasePhases } from "./topics-cost-cases.ts";
import {
  assignedLimitsNotExceeded,
  limitsExceeded,
  type ReadBudgetGroup,
  readBudgetTestFiles,
  TOPICS_READ_BUDGET_GROUPS,
  variantsAssignedTo,
} from "./topics-read-budget.ts";
import { READ_BUDGET_VARIANTS } from "./topics-read-budget-variants.ts";

/**
 * Registers the read-budget tests of `group` inside the calling `describe()`:
 * that the group's test file sits beside one for each other group, and, for
 * each of the group's cases, that every count its phases record stays within
 * its limit, and that each variant its limits are assigned to exceeds every
 * one of those limits. Each case is measured once for the limits and once more
 * for each variant, in this process.
 */
export function describeReadBudgetGroup(group: ReadBudgetGroup): void {
  it("sits beside one test file for each group of read-budget cases", async () => {
    const files: string[] = [];
    for await (const entry of Deno.readDir(new URL(".", import.meta.url))) {
      if (/^topics-read-budget-.+\.test\.ts$/.test(entry.name)) {
        files.push(entry.name);
      }
    }
    expect(files.toSorted()).toEqual(readBudgetTestFiles());
  });

  for (const id of TOPICS_READ_BUDGET_GROUPS[group]) {
    const probeCase = caseNamed(id);
    describe(id, () => {
      it("stays within each of its limits in every phase", async () => {
        const { phases } = await measureCasePhases(probeCase);
        expect(limitsExceeded(probeCase, phases)).toEqual([]);
      });

      for (const variant of variantsAssignedTo(probeCase)) {
        it(`exceeds each limit assigned to the \`${variant}\` variant when that variant runs`, async () => {
          const { phases } = await measureCasePhases(probeCase, {
            variant: READ_BUDGET_VARIANTS[variant](probeCase),
          });
          expect(assignedLimitsNotExceeded(probeCase, variant, phases))
            .toEqual([]);
        });
      }
    });
  }
}

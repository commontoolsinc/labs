/**
 * CT-1840 (critique F7): the dependency-collection arm counters exist so the
 * "schema arm dominates" attribution behind the data:-URI freeze work is
 * measurable rather than assumed. Pin the counter mechanics here; the
 * increments at the runner's populateDependencies closures are exercised by
 * the pattern integration suites.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  dependencyArmStats,
  noteDependencyArm,
  resetDependencyArmStats,
} from "../src/scheduler/dependency-arm-stats.ts";

describe("dependencyArmStats (CT-1840 F7)", () => {
  it("increments the named arm and resets to zero", () => {
    resetDependencyArmStats();
    noteDependencyArm("actionArgumentSchema");
    noteDependencyArm("actionArgumentSchema");
    noteDependencyArm("actionDeclaredReads");
    expect(dependencyArmStats.actionArgumentSchema).toBe(2);
    expect(dependencyArmStats.actionDeclaredReads).toBe(1);
    expect(dependencyArmStats.handlerArgumentSchema).toBe(0);

    resetDependencyArmStats();
    expect(dependencyArmStats.actionArgumentSchema).toBe(0);
    expect(dependencyArmStats.actionDeclaredReads).toBe(0);
  });

  it("tracks every declared arm key", () => {
    resetDependencyArmStats();
    for (const key of Object.keys(dependencyArmStats)) {
      noteDependencyArm(key as keyof typeof dependencyArmStats);
      expect(dependencyArmStats[key as keyof typeof dependencyArmStats])
        .toBe(1);
    }
    resetDependencyArmStats();
  });
});

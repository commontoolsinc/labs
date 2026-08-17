import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { cf, stripAnsi } from "./utils.ts";

/**
 * `cf get`/`cf set`/`cf call` and their `cf piece` counterparts are one
 * definition each, mounted twice (docs/plans/cli-surface-shape.md, step 5).
 * These tests compare the two mounts of each command directly, so a change
 * that reaches one spelling and not the other names itself here instead of
 * hiding behind two green per-surface tests. The target options arrive
 * differently by design — as `piece` globals on one mount, as own options
 * on the other — which is exactly why the comparison is over the EFFECTIVE
 * surface (own plus inherited), not over where each option is declared.
 */
describe("piece-data-spellings", () => {
  const SPELLINGS = ["get", "set", "call"] as const;

  /** The option surface visible on a command, inherited globals included,
   * minus the help machinery every command carries. Each option contributes
   * its full signature — every flag spelling plus the value grammar — so a
   * mount that renamed a short flag or retyped a value diverges here, not
   * only one that dropped an option outright. */
  // deno-lint-ignore no-explicit-any
  function effectiveOptionSurface(command: any): string[] {
    const signature = (
      option: { name: string; flags: string[]; typeDefinition?: string },
    ) =>
      `${[...option.flags].sort().join(",")} ${option.typeDefinition ?? ""}`
        .trim();
    const visible = [
      ...command.getOptions(true),
      ...command.getGlobalOptions(true),
    ].filter((option: { name: string }) =>
      option.name !== "help" && option.name !== "version"
    );
    return [...new Set(visible.map(signature))].sort();
  }

  it("mounts each command at top level with the piece mount's exact surface", async () => {
    const { main } = await import(
      "../commands/main.ts?piece-data-spellings-surface"
    );
    const piece = main.getCommand("piece")!;
    for (const name of SPELLINGS) {
      const top = main.getCommand(name);
      const nested = piece.getCommand(name);
      expect(top).toBeDefined();
      expect(nested).toBeDefined();
      expect(top!.getArgsDefinition()).toBe(nested!.getArgsDefinition());
      expect(top!.getUsage()).toBe(nested!.getUsage());
      expect(effectiveOptionSurface(top)).toEqual(
        effectiveOptionSurface(nested),
      );
      // The description differs only by how the command names itself.
      expect(top!.getDescription()).toBe(
        nested!.getDescription().replaceAll(`cf piece ${name}`, `cf ${name}`),
      );
    }
  });

  it("refuses a configuration-free run identically under both spellings", async () => {
    // End to end through real Cliffy parsing in a subprocess with no fabric
    // configuration: the refusal text and exit code are the behavior a
    // script sees first, and the two spellings must not diverge in it. The
    // deno task banner echoes the argv and so differs by construction.
    const refusal = (stderr: string[]) =>
      stderr.map((line) => stripAnsi(line))
        .filter((line) => !line.startsWith("Task "))
        .join("\n");
    for (const name of SPELLINGS) {
      const top = await cf(name);
      const nested = await cf(`piece ${name}`);
      expect(top.code).toBe(nested.code);
      expect(refusal(top.stderr)).toBe(refusal(nested.stderr));
      // `get` and `set` refuse on the missing identity, `call` on the
      // missing callable argument — either way a refusal happened, which is
      // what keeps the equality above from passing vacuously on two silent
      // successes.
      expect(refusal(top.stderr)).toContain("Missing");
    }
  });
});

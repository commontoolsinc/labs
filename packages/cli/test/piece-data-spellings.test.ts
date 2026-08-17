import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { warnDeprecatedPieceSpelling } from "../commands/piece.ts";
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
    // This test drives its own copy of the command tree, which reads the
    // environment as it is built; the query string is what makes the copy.
    // deno-lint-ignore cf-imports/no-inline-module-import
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

  it("refuses a configuration-free run identically, except the 6a notice", async () => {
    // End to end through real Cliffy parsing in a subprocess with no fabric
    // configuration: the refusal text and exit code are the behavior a
    // script sees first. Since step 6a the piece-mounted spelling warns and
    // the top-level spelling does not — the ONE respect in which the two
    // mounts may differ. The comparison stays exact by naming that line and
    // removing exactly it, so every other divergence still fails here. The
    // deno task banner echoes the argv and so differs by construction.
    const notice = (name: string) => {
      let line = "";
      warnDeprecatedPieceSpelling(`piece ${name}`, {
        writeError: (text) => line = text,
      });
      return line;
    };
    const stderrLines = (stderr: string[]) =>
      stderr.map((line) => stripAnsi(line))
        .filter((line) => !line.startsWith("Task "));
    for (const name of SPELLINGS) {
      // `call` gets a callable name so the refusal happens inside the
      // action: the 6a notice attaches to invocations, and a grammar error
      // (missing argument) is refused by Cliffy before any action — and so
      // before any notice — under both spellings alike.
      const tail = name === "call" ? " someCallable" : "";
      const top = await cf(`${name}${tail}`);
      const nested = await cf(`piece ${name}${tail}`);
      expect(top.code).toBe(nested.code);
      const topLines = stderrLines(top.stderr);
      const nestedLines = stderrLines(nested.stderr);
      expect(nestedLines).toContain(notice(name));
      expect(topLines).not.toContain(notice(name));
      expect(topLines).toEqual(
        nestedLines.filter((line) => line !== notice(name)),
      );
      // `get` and `set` refuse on the missing identity, `call` on the
      // missing callable argument — either way a refusal happened, which is
      // what keeps the equality above from passing vacuously on two silent
      // successes.
      expect(topLines.join("\n")).toContain("Missing");
    }
  });
});

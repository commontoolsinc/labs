/**
 * The notice a command carries while it answers to an older spelling.
 *
 * Step 7 of the CLI surface shape moves commands under the noun they act on,
 * and each moved command stays mounted at the spelling it had. That mount is
 * a migration aid rather than a second surface: it is hidden from help and
 * from completion's command suggestions, and it says on every run what to
 * write instead and the day after which it is no longer guaranteed.
 *
 * This is deliberately not the rule for `--piece`, which is a deprecated name
 * for `--cell` with no end date, no removal condition, and no notice. A flag
 * that is merely spelled two ways costs a reader nothing; a command mounted
 * at two paths teaches the wrong one to everybody who copies it.
 */

/**
 * The last day the pre-step-7 command spellings are guaranteed to answer.
 *
 * A literal, fixed when this reaches main, rather than a window computed per
 * run: a caller who reads the notice today and acts on it next week has to be
 * told the same day both times, and a date that moves with the clock is a
 * date nobody can plan against.
 *
 * Nothing consults this at run time, and that is the design. What retires a
 * spelling is a change that deletes it — the hidden mount, this constant, and
 * the notice together. A clock comparison instead would make an installed
 * binary start refusing on a morning when nothing shipped, leaving a caller a
 * failure with no version to roll back to.
 *
 * So the date bounds a guarantee rather than schedules an execution, and the
 * notice says so in those words: a removal landing later than this date makes
 * a promise of removal false, and cannot make the absence of one false.
 */
export const COMMAND_SPELLING_END_DATE = "2026-09-11";

/**
 * Tell a caller which spelling replaced the one they wrote, and how long the
 * one they wrote is guaranteed for.
 *
 * Goes to stderr and never to stdout. The commands carrying this notice
 * include the ones that reserve stdout for machine-readable output, and a
 * notice written there would corrupt exactly the piping scripts the notice
 * exists to migrate.
 */
export function warnDeprecatedCommandSpelling(
  oldSpelling: string,
  newSpelling: string,
  deps: { writeError?: (text: string) => void } = {},
): void {
  const writeError = deps.writeError ?? console.error;
  writeError(
    `'cf ${oldSpelling}' is deprecated; spell it 'cf ${newSpelling}'. The ` +
      `'cf ${oldSpelling}' spelling is not guaranteed to work after ` +
      `${COMMAND_SPELLING_END_DATE}.`,
  );
}

/**
 * An action that emits the notice before doing its work.
 *
 * The notice is unconditional rather than suppressed by `--quiet`, because a
 * script quiet enough to hide it is the caller most in need of the date.
 */
export function withDeprecatedCommandSpelling<
  // deno-lint-ignore no-explicit-any
  F extends (this: any, ...args: any[]) => unknown,
>(oldSpelling: string, newSpelling: string, action: F): F {
  // The `this` binding passes through untouched: a callable command's action
  // reads `this.getLiteralArgs()` to recover the words after the marker.
  // deno-lint-ignore no-explicit-any
  return function (this: any, ...args: any[]) {
    warnDeprecatedCommandSpelling(oldSpelling, newSpelling);
    return action.apply(this, args);
  } as F;
}

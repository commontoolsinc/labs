/**
 * The notice a command carries while it answers to an older spelling.
 *
 * Step 7 of the CLI surface shape moves commands under the noun they act on,
 * and each moved command stays mounted at the spelling it had. That mount is
 * a migration aid rather than a second surface: it is hidden from help and
 * from completion's command suggestions, and every run says what to write
 * instead and the day after which the old spelling is no longer guaranteed —
 * the runs that only ask for the help page included, since a page full of
 * examples in the superseded spelling is the loudest way to teach it.
 *
 * This is deliberately not the rule for `--piece`, which is a deprecated name
 * for `--cell` with no end date, no removal condition, and no notice. A flag
 * that is merely spelled two ways costs a reader nothing; a command mounted
 * at two paths teaches the wrong one to everybody who copies it.
 */

/**
 * What the help half of a notice needs of a command: the method cliffy renders
 * every help page through, whether `--help` asked for it or a refusal printed
 * it as context.
 *
 * Structural rather than cliffy's `Command`, so this module stays a leaf that
 * the command tree imports rather than one that imports the command tree.
 */
export interface AnyCommand {
  // deno-lint-ignore no-explicit-any
  showHelp(options?: any): void;
}

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
 * The two places one mount's notice reaches a caller.
 *
 * A run that does the command's work reaches the action. A run that asks what
 * the command is never does: `--help` renders the page and exits before any
 * action, and that page is where someone learning a command looks first — so
 * a mount whose page teaches its own spelling and says nothing beside it
 * teaches the spelling that is going away.
 */
export interface CommandSpellingNotice {
  /** An action that says the notice before doing its work. */
  action<
    // deno-lint-ignore no-explicit-any
    F extends (this: any, ...args: any[]) => unknown,
  >(action: F): F;

  /** A command whose help page carries the notice after it. */
  helpPage<C extends AnyCommand>(command: C): C;
}

/** The notice a blessed mount carries, which is none. */
export const noCommandSpellingNotice: CommandSpellingNotice = {
  action: (action) => action,
  helpPage: (command) => command,
};

/**
 * The notice for one superseded mount, said once however the run reaches it.
 *
 * Latched rather than said per path, because one run can reach both: cliffy
 * renders the help page after an action throws a validation error, so a
 * refused line would otherwise be told twice what a correct line is told
 * once. A caller told the same thing twice in one run learns to skim it.
 *
 * The notice is unconditional rather than suppressed by `--quiet`, because a
 * script quiet enough to hide it is the caller most in need of the date.
 */
export function commandSpellingNotice(
  oldSpelling: string,
  newSpelling: string,
): CommandSpellingNotice {
  let said = false;
  const say = (): void => {
    if (said) return;
    said = true;
    warnDeprecatedCommandSpelling(oldSpelling, newSpelling);
  };
  return {
    action<
      // deno-lint-ignore no-explicit-any
      F extends (this: any, ...args: any[]) => unknown,
    >(action: F): F {
      // The `this` binding passes through untouched: a callable command's
      // action reads `this.getLiteralArgs()` to recover the words after the
      // marker.
      // deno-lint-ignore no-explicit-any
      return function (this: any, ...args: any[]) {
        say();
        return action.apply(this, args);
      } as F;
    },
    helpPage<C extends AnyCommand>(command: C): C {
      const render = command.showHelp.bind(command);
      // The notice follows the page rather than preceding it. The page is
      // what the caller asked for and the notice is the correction to it, and
      // cliffy puts its own error after the page for the same reason. The two
      // go to different streams, so neither can be lost in the other.
      const withNotice: AnyCommand["showHelp"] = (options) => {
        render(options);
        say();
      };
      (command as AnyCommand).showHelp = withNotice;
      return command;
    },
  };
}

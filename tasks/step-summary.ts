/**
 * What a job writes into its step summary.
 *
 * GitHub takes the file `GITHUB_STEP_SUMMARY` names whole or not at all.
 * A file past `SUMMARY_LIMIT` is refused and what it held is lost, so a
 * step that prints a list the size of its input costs the summary every
 * line written before the list as well. Everything written here stays
 * inside the bound: what does not fit is left out and a line says so.
 */

/** The largest summary GitHub accepts. */
export const SUMMARY_LIMIT = 1024 * 1024;

/** What stands in the summary for the lines that did not fit. */
const ELIDED = "_Cut here: the rest of this is in the job log._";

const ENCODER = new TextEncoder();

/** How many bytes `text` occupies in the summary file. */
function bytes(text: string): number {
  return ENCODER.encode(text).length;
}

/**
 * As much of `text` as `room` bytes hold, cut between lines so that no
 * line and no character is split in half, and with `ELIDED` in place of
 * what was cut. Nothing at all where the room holds no whole line, so a
 * summary already at the bound gains nothing rather than a run of
 * markers saying so.
 */
export function fit(text: string, room: number): string {
  if (bytes(text) <= room) return text;
  const marker = `${ELIDED}\n`;
  let used = bytes(marker);
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const size = bytes(line) + 1;
    if (used + size > room) break;
    used += size;
    kept.push(line);
  }
  if (kept.length === 0) return "";
  return kept.map((line) => `${line}\n`).join("") + marker;
}

/**
 * Appends to the job summary, within what GitHub accepts. A run with no
 * summary file named is every run outside a GitHub job, and writes
 * nothing. Throws where the file is named and cannot be measured, since
 * a summary written past the bound is a summary lost.
 */
export function appendSummary(text: string): void {
  const at = Deno.env.get("GITHUB_STEP_SUMMARY");
  if (at === undefined || at.length === 0) return;
  // The bound is on the file rather than on one write, so what is
  // already there comes off the room this call has. A file the first
  // write is about to create holds nothing.
  let spent = 0;
  try {
    spent = Deno.statSync(at).size;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const body = fit(text, SUMMARY_LIMIT - spent);
  if (body.length === 0) return;
  Deno.writeTextFileSync(at, body, { append: true });
}

/** Says something both on the job's output and in its summary. */
export function say(lines: readonly string[]): void {
  const text = `${lines.join("\n")}\n`;
  console.log(text);
  appendSummary(text);
}

/**
 * What the command line writes, given its arguments and what it was
 * handed, and the status it exits with. A workflow step whose text is
 * some command's output rather than a task in this repository pipes it
 * through here, so that the one rule about what fits is the one every
 * caller applies. The step keeps whatever it wraps the text in, a
 * heading or a code fence, outside the room it asks for.
 */
export function cutToRoom(
  args: readonly string[],
  text: string,
): { out: string; code: number } {
  const room = args.length === 2 && args[0] === "--room"
    ? Number(args[1])
    : Number.NaN;
  if (!Number.isSafeInteger(room) || room < 0) {
    return {
      out: "usage: step-summary.ts --room <whole number of bytes>\n",
      code: 2,
    };
  }
  return { out: fit(text, room), code: 0 };
}

if (import.meta.main) {
  const { out, code } = cutToRoom(
    Deno.args,
    await new Response(Deno.stdin.readable).text(),
  );
  await (code === 0 ? Deno.stdout : Deno.stderr).write(ENCODER.encode(out));
  Deno.exit(code);
}

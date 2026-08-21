/**
 * The run's register of values a handle has been materialized into, and the
 * scrub that keeps them out of everything the model reads afterwards.
 *
 * A backstop against accidental echo, not a containment boundary. Resolving
 * a handle trusted-side is defeated outright if the value comes straight
 * back — a page echoes what was typed into it, a later snapshot reads the
 * filled field, a nonzero exit puts the argument list in stderr — so a tool
 * that materializes a value records it here and model-facing strings are
 * scrubbed through the register.
 *
 * Read the limits honestly; there are three, and all are holes rather than
 * fussiness.
 *
 * The first is that this matches strings. It catches a value returned as it
 * was written and misses one the page transformed: HTML entities, JSON
 * escaping, a case change, or a value split across two elements all pass
 * through. It raises the cost of the obvious return path; it does not close
 * the class.
 *
 * The second is {@link MIN_SCRUBBABLE_VALUE_LENGTH}. A value shorter than
 * that is recorded but never scrubbed, so a short secret — a PIN of three
 * digits, a one-character answer — comes back through this boundary intact.
 * Scrubbing it is not the alternative: a substring that short occurs in
 * ordinary text constantly, so matching it would blank unrelated output
 * everywhere without hiding anything an observer could not guess from the
 * shape of the placeholder anyway.
 *
 * The third belongs to {@link scrubResolvedValuesDeep}, the boundary that
 * applies the register to a tool result. It reaches the payload text fields
 * named by {@link SCRUBBED_PAYLOAD_TEXT_FIELDS} and no others, because
 * rewriting an arbitrary field would corrupt the shape of the result whenever
 * a materialized value happens to spell one of its protocol words. A value
 * echoed back in a field outside that set is not scrubbed.
 *
 * Containment that holds has to come from the labels on the data governing
 * the read, not from recognizing the bytes.
 *
 * The register is run-scoped and in-memory only. It holds the very values the
 * design exists to keep out of the model's context, so it is never written to
 * run state, a transcript, or an artifact.
 */
export const RESOLVED_VALUE_PLACEHOLDER = "<withheld value>";

/**
 * Shortest value the register will match on. Below four characters a value is
 * not a distinguishing string: it is a fragment of ordinary prose, of a URL,
 * of a hash, and replacing every occurrence of it corrupts output wholesale
 * for no gain in secrecy.
 */
export const MIN_SCRUBBABLE_VALUE_LENGTH = 4;

export interface HarnessResolvedValueRegister {
  /**
   * Adds a materialized value to the register. A value shorter than
   * {@link MIN_SCRUBBABLE_VALUE_LENGTH} counts towards {@link size} but is
   * never matched; an empty string is ignored entirely.
   */
  record(value: string): void;
  /** `text` with every registered value replaced by the placeholder. */
  scrub(text: string): string;
  /** How many distinct values the run has materialized. */
  readonly size: number;
}

/**
 * The forms a registered value can reappear in. A value typed into a form
 * comes back raw in a snapshot, percent-encoded in a submitted URL, and
 * form-encoded when the submission used `application/x-www-form-urlencoded`.
 *
 * A JavaScript string is a sequence of UTF-16 code units, so it can hold an
 * unpaired surrogate that no percent-encoding of it exists for, and
 * `encodeURIComponent` answers that with a `URIError`. A cell holding such a
 * string is ordinary data, not an error, so the encoded forms are dropped and
 * the raw form is registered on its own. The value is still scrubbed wherever
 * it appears as written; only the encoded return paths go uncovered, which is
 * the same partial cover the first limit above already describes.
 */
const echoForms = (value: string): readonly string[] => {
  let encoded: string;
  try {
    encoded = encodeURIComponent(value);
  } catch (error) {
    if (error instanceof URIError) {
      return [value];
    }
    throw error;
  }
  return [...new Set([value, encoded, encoded.replaceAll("%20", "+")])];
};

export const createHarnessResolvedValueRegister =
  (): HarnessResolvedValueRegister => {
    const forms = new Set<string>();
    let recorded = 0;
    return {
      record(value: string) {
        if (value === "") {
          return;
        }
        recorded += 1;
        if (value.length < MIN_SCRUBBABLE_VALUE_LENGTH) {
          return;
        }
        for (const form of echoForms(value)) {
          forms.add(form);
        }
      },
      scrub(text: string): string {
        if (forms.size === 0) {
          return text;
        }
        // Longest first, so a value that contains another is replaced whole
        // rather than left as a placeholder embedded in the rest of it.
        return [...forms]
          .sort((left, right) => right.length - left.length)
          .reduce(
            (scrubbed, form) =>
              scrubbed.replaceAll(form, RESOLVED_VALUE_PLACEHOLDER),
            text,
          );
      },
      get size() {
        return recorded;
      },
    };
  };

/**
 * The keys whose values {@link scrubResolvedValuesDeep} treats as text a tool
 * produced. Every other field of a tool result names part of a protocol this
 * code defines, and is left alone.
 *
 * The rule for membership: a field is here when its value is free text the
 * tool did not compose out of its own vocabulary — text read off a file, a
 * page, a network response, a child process, or a child run. Anything the
 * harness itself chose the words of stays out, and so does every identifier,
 * discriminator, path, digest, URL, and structured value. That split is what
 * lets the scrub rewrite a match without risking the shape of the result: a
 * materialized value that happens to spell `browser` or `error` cannot
 * corrupt `outputId` or `status`, because those keys are not reachable.
 *
 * What each key covers, across the builtin tools and the subagent result:
 *
 * - `output`, `detail` — `browser` action output and its diagnostic text;
 *   `detail` also carries the structured file-tool errors' extra text.
 * - `message` — every tool's error text: `browser`, `assign_slug`,
 *   `run_pattern`, `web_fetch`, `read_skill_resource`, `run_skill_script`,
 *   and the structured file-tool error.
 * - `stdout`, `stderr` — `bash` and `run_skill_script` process output.
 * - `content` — `read_file`'s file text and `read_skill_resource`'s resource
 *   text.
 * - `diff` — `edit_file`'s unified diff, which quotes the file around every
 *   edit.
 * - `text`, `rawContent`, `title` — `web_fetch`'s extracted text, the raw
 *   body it came from, the page title, and the anchor text of each link it
 *   lists.
 * - `summary` — the child's own account of its run in a `delegate_task`
 *   result, which is model-written prose over whatever the child read.
 * - `valueError`, `validationError` — schema-mismatch text from `run_pattern`
 *   and from a subagent's structured return, which quotes the offending data.
 * - `rawCauseMessage` — a failing `run_pattern` computation's thrown text,
 *   which may carry the data the computation ran over.
 *
 * `rawContent` and `rawCauseMessage` are listed even though the prompt loop
 * strips both from the rendering it hands the model: membership is decided by
 * what a field carries, so the allowlist stays correct for the field wherever
 * it travels rather than resting on another module's stripping.
 *
 * Deliberately excluded, and why: `outputId`, `type`, `status`, `code`,
 * `toolId`, `exitCode`, `ok`, `known`, and the subagent manifest's fields are
 * harness vocabulary a rewrite would break; `path`, `url`, `finalUrl`,
 * `href`, `cwd`, `slug`, and `sandboxResourcePath` name locations, and a
 * placeholder in one turns a usable reference into nothing the operator can
 * act on; digests, byte counts, and `schema` are not prose; `argv` and `args`
 * are the call this tool was given rather than text it read back. A tool that
 * adds a field carrying text it read from somewhere else adds that field
 * here.
 */
export const SCRUBBED_PAYLOAD_TEXT_FIELDS: ReadonlySet<string> = new Set([
  "output",
  "detail",
  "message",
  "stdout",
  "stderr",
  "content",
  "diff",
  "text",
  "rawContent",
  "title",
  "summary",
  "valueError",
  "validationError",
  "rawCauseMessage",
]);

/**
 * `value` with every registered value scrubbed out of the payload text it
 * carries. Scrubbing is confined to a fixed allowlist of keys,
 * {@link SCRUBBED_PAYLOAD_TEXT_FIELDS}, which are the fields a tool result
 * uses for text a tool read rather than composed. A string reached through
 * one of those keys is scrubbed, including one nested inside it, and so is a
 * bare string handed in as the whole value.
 *
 * Everything else is left exactly as it stands: object keys, and the values
 * of every other field. `outputId`, `type`, `status`, `code`, `toolId`,
 * `exitCode`, refs, and paths describe the shape of a tool result rather than
 * carrying page-derived text, and rewriting one breaks the result against its
 * tool descriptor — a value of `"browser"` would turn `outputId: "browser:1"`
 * into a placeholder followed by `:1`, and a value of `"error"` would rewrite
 * a status. The allowlist fails closed toward keeping the protocol intact.
 *
 * The cost is stated plainly, and it is the third hole in a mechanism already
 * documented as a backstop: a materialized value echoed somewhere outside
 * those fields is not scrubbed. A tool that carries page text in a field of
 * its own naming has to add that field here.
 *
 * A tool that materializes a value can only scrub what it prints itself. The
 * value reaches a page, and any tool that later reads that page — a skill
 * script driving the same browser, a shell command fetching the same URL —
 * would carry it back untouched. Applying this at the one boundary every tool
 * output crosses on its way to the model closes that class of return path
 * rather than one tool at a time.
 */
export const scrubResolvedValuesDeep = (
  register: HarnessResolvedValueRegister | undefined,
  value: unknown,
): unknown => {
  if (register === undefined || register.size === 0) {
    return value;
  }
  const walk = (input: unknown, inPayloadText: boolean): unknown => {
    if (typeof input === "string") {
      return inPayloadText ? register.scrub(input) : input;
    }
    if (Array.isArray(input)) {
      return input.map((entry) => walk(entry, inPayloadText));
    }
    if (typeof input === "object" && input !== null) {
      const result: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(input)) {
        Object.defineProperty(result, key, {
          value: walk(
            entry,
            inPayloadText || SCRUBBED_PAYLOAD_TEXT_FIELDS.has(key),
          ),
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
      return result;
    }
    return input;
  };
  return walk(value, typeof value === "string");
};

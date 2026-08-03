/**
 * Reads the method by which a value produces its encodable form.
 *
 * The name the runtime asks for is `toEncodableForm`, which claims only what
 * is true: this is the form a value takes on the way to being encoded, and
 * has nothing to do with JSON.
 *
 * `toJSON` is the other name a value may answer to, for two kinds of value
 * that keep it:
 *
 * - A builder artifact carries `toJSON` alongside `toEncodableForm`, for one
 *   consumer: `JSON.stringify()` of a pattern reaches each node's module
 *   through it, and a graph serialized without it loses every module's body
 *   and `$implRef`. Nothing in the runtime reads that spelling.
 * - A pattern factory and a `Cell` carry only `toJSON` -- a factory because
 *   `JSON.stringify(SomePattern)` is an idiom pattern source uses, a `Cell`
 *   because that is how it becomes a link.
 *
 * So this is the one place that knows both names, which keeps the remaining
 * `toJSON` findable and makes retiring it a change here rather than a sweep.
 * Retiring the factory's is a pattern-author migration whose failure mode is
 * a silent `undefined`, so it is deliberately not an internal rename.
 */
function encodableFormMethod(value: unknown): (() => unknown) | undefined {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return undefined;
  }

  const artifact = value as { toEncodableForm?: unknown; toJSON?: unknown };
  if (typeof artifact.toEncodableForm === "function") {
    return artifact.toEncodableForm as () => unknown;
  }
  if (typeof artifact.toJSON === "function") {
    return artifact.toJSON as () => unknown;
  }
  return undefined;
}

/** Checks whether a value can produce an encodable form of itself. */
export function hasEncodableForm(value: unknown): boolean {
  return encodableFormMethod(value) !== undefined;
}

/**
 * Produces the encodable form of a value that has one, or `undefined` for a
 * value that does not. Ask `hasEncodableForm()` to tell those apart from a
 * value whose encodable form is itself `undefined`.
 */
export function encodableFormOf(value: unknown): unknown {
  return encodableFormMethod(value)?.call(value);
}

/**
 * Marks an object whose replacement is under way -- an ancestor in the walk --
 * so a cycle is recognized instead of followed forever.
 */
const IN_PROGRESS = Symbol("IN_PROGRESS");

/**
 * Told about each copy the walk makes, so a caller can carry across whatever
 * does not travel with the bytes. Trust and the content-addressed entry ref
 * live in identity-keyed side tables, which is exactly that.
 */
export type OnCopy = (copy: unknown, original: unknown) => void;

/**
 * Replaces every builder artifact reachable from `value` with its encodable
 * form, yielding a value the data model can represent.
 *
 * A builder artifact carries its serializer as a `toEncodableForm` method (see
 * `builder/module.ts` and `builder/pattern.ts`). A method is a function-valued
 * property and a fabric record has none, so an artifact has to be replaced
 * before the value crosses into the data model. An artifact sits wherever a
 * pattern author put it -- under a tool's `handler` key, in a result, inside a
 * node's `inputs` -- so finding one takes a walk.
 *
 * This looks for THE ARTIFACT rather than for the POSITIONS an artifact is
 * allowed to occupy. A traversal written the other way round has to be told
 * every shape a graph can take, and is wrong the moment a new one appears --
 * silently, since what it leaves behind is a live function in a value headed
 * for storage.
 *
 * An artifact is reached in two shapes and both are covered: a module is an
 * object, and a factory is a FUNCTION carrying its module's members (the
 * `Object.assign` in `builder/module.ts`). A function is replaced but never
 * descended into: its members are the builder's, not content.
 *
 * Subtrees carrying no artifact come back by identity, which keeps an already
 * deep-frozen `FabricValue` eligible for the conversion's identity fast path
 * and keeps a twice-reachable object shared.
 *
 * A cycle is left for the conversion to reject. What it rejects it BY may be
 * the cycle or an artifact still raw inside the partial result: an ancestor is
 * answered as itself, so a copy's cycle edge points at the original.
 */
export function replaceArtifacts<T>(value: T, onCopy: OnCopy): T {
  return replace(value, new Map(), onCopy) as T;
}

function replace(
  value: unknown,
  seen: Map<object, unknown>,
  onCopy: OnCopy,
): unknown {
  if (value === null) return value;
  const isFunction = typeof value === "function";
  if (!isFunction && typeof value !== "object") return value;

  if (seen.has(value)) {
    const flattened = seen.get(value);
    return flattened === IN_PROGRESS ? value : flattened;
  }

  // A factory is a function carrying its module's members. Replaced by its
  // encodable form, never descended into: a function's own members belong to
  // the builder, and a function that is not an artifact has no fabric
  // representation for the conversion to find either way.
  if (isFunction) {
    if (!hasOwnEncodableForm(value)) return value;
    seen.set(value, IN_PROGRESS);
    return copied(
      replace(value.toEncodableForm(), seen, onCopy),
      value,
      seen,
      onCopy,
    );
  }

  // An array is answered by the array rule whatever it carries, so an array
  // is only ever descended into.
  const isArray = Array.isArray(value);
  if (!isArray && Object.getPrototypeOf(value) !== Object.prototype) {
    // Anything else -- a `Cell`, a `FabricInstance`, a `Date` -- is the
    // conversion's to interpret, and carries no builder artifact.
    //
    // Deliberately NOT `isPlainObject()`, which also admits a null-prototype
    // object. Such an object is not a fabric record, so descending into one
    // would be looking for artifacts somewhere the conversion is going to
    // refuse regardless. The question here is narrower than that predicate's.
    return value;
  }

  seen.set(value, IN_PROGRESS);
  let flattened: unknown;
  if (isArray) {
    flattened = replaceInElements(value, seen, onCopy);
  } else if (hasOwnEncodableForm(value)) {
    // The artifact's OWN method is what gets called, rather than the
    // serializer it delegates to: the method a copy carries is closed over the
    // artifact the copy was made from, and that original is what the
    // serialized form describes.
    flattened = replace(value.toEncodableForm(), seen, onCopy);
  } else {
    flattened = replaceInEntries(
      value as Record<string, unknown>,
      seen,
      onCopy,
    );
  }
  return copied(flattened, value, seen, onCopy);
}

/**
 * Records a replacement: the single place a copy becomes the answer for its
 * original.
 *
 * Every branch above returns through here, and that is deliberate. The
 * bookkeeping a copy needs -- telling the caller so identity-keyed facts can
 * follow, and remembering the answer so a value reachable twice is replaced
 * once -- was previously written out at each branch, and was left off a new
 * branch three separate times. Routing every copy through one function is what
 * makes the fourth omission impossible rather than merely unlikely.
 *
 * A value that came back unchanged is not a copy and is not announced as one.
 */
function copied(
  replacement: unknown,
  original: object,
  seen: Map<object, unknown>,
  onCopy: OnCopy,
): unknown {
  if (replacement !== original) onCopy(replacement, original);
  seen.set(original, replacement);
  return replacement;
}

function replaceInElements(
  value: readonly unknown[],
  seen: Map<object, unknown>,
  onCopy: OnCopy,
): readonly unknown[] {
  let result: unknown[] | undefined;
  for (let i = 0; i < value.length; i++) {
    // A hole holds nothing to flatten, and reading one would report the
    // element as `undefined` and fill it in on the copy.
    if (!(i in value)) continue;
    // Read ONCE. `slice()` would re-read every element, running an
    // accessor-backed one a second time and keeping that second answer.
    const element = value[i];
    const flattened = replace(element, seen, onCopy);
    if (flattened === element) continue;
    result ??= copyPreservingHoles(value);
    result[i] = flattened;
  }
  return result ?? value;
}

function replaceInEntries(
  value: Record<string, unknown>,
  seen: Map<object, unknown>,
  onCopy: OnCopy,
): Record<string, unknown> {
  // Read each member ONCE, and build any copy from what was read: reading a
  // second time to copy would run an accessor twice and keep the second
  // answer, so a value whose members are accessor-backed would be recorded
  // as something it never was at any single moment.
  const entries = Object.entries(value);
  let result: Record<string, unknown> | undefined;
  for (let i = 0; i < entries.length; i++) {
    const [key, element] = entries[i];
    const flattened = replace(element, seen, onCopy);
    if (flattened === element) continue;
    result ??= Object.fromEntries(entries);
    result[key] = flattened;
  }
  return result ?? value;
}

/**
 * Copies an array member by member, preserving holes and reading each present
 * element exactly once.
 */
function copyPreservingHoles(value: readonly unknown[]): unknown[] {
  const result: unknown[] = [];
  result.length = value.length;
  for (let i = 0; i < value.length; i++) {
    if (i in value) result[i] = value[i];
  }
  return result;
}

/**
 * Checks whether a value carries its own callable `toEncodableForm` method.
 *
 * Own, because what is being looked for is an artifact's own serializer.
 * `toEncodableForm` specifically, rather than through `encodableFormOf()`:
 * a plain object bearing a `toJSON` is not a builder artifact, and what
 * becomes of one is the conversion's to decide.
 */
function hasOwnEncodableForm(
  value: object | ((...args: unknown[]) => unknown),
): value is { toEncodableForm(): unknown } {
  return Object.hasOwn(value, "toEncodableForm") &&
    typeof (value as { toEncodableForm: unknown }).toEncodableForm ===
      "function";
}

import { isPlainObject } from "@commonfabric/utils/types";

/**
 * Reads the method by which a value produces its encodable form -- the form it
 * takes on the way to being encoded, which reaches storage without ever being
 * stringified.
 *
 * Two names answer, and they are asked for in this order:
 *
 * - `toEncodableForm`, carried by every builder artifact -- a module, a
 *   handler, a pattern, and the factory that carries a module's members.
 * - `toSigilLinkOrNull`, carried by a `Cell`, for which producing the link it
 *   names IS how it reaches storage.
 *
 * Both are the runtime's OWN names, and that is the point. Asking by name
 * rather than by class is what lets this module stay a leaf -- naming `Cell`
 * here would mean importing the runtime's core, and the graph already runs the
 * other way. Neither name is a public protocol, so no value acquires an
 * encodable form by carrying a member it defined for some other purpose.
 */
function encodableFormMethod(value: unknown): (() => unknown) | undefined {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return undefined;
  }

  const named = value as {
    toEncodableForm?: unknown;
    toSigilLinkOrNull?: unknown;
  };
  if (typeof named.toEncodableForm === "function") {
    return named.toEncodableForm as () => unknown;
  }
  return typeof named.toSigilLinkOrNull === "function"
    ? named.toSigilLinkOrNull as () => unknown
    : undefined;
}

/**
 * Checks whether a value can produce an encodable form of itself.
 *
 * Deliberately BROADER than the walk's own test (`hasOwnEncodableForm`): this
 * accepts either name and an inherited member, because its callers ask about a
 * specific value they already hold -- a pattern, a cell -- rather than sifting
 * an arbitrary graph. A cell answers here through an inherited member, that
 * being where a class puts its methods. The walk cannot afford either latitude;
 * see there.
 */
export function hasEncodableForm(value: unknown): boolean {
  return encodableFormMethod(value) !== undefined;
}

/**
 * Produces the encodable form of a value that has one, or `undefined` for a
 * value that does not. Ask `hasEncodableForm()` to tell those apart from a
 * value whose encodable form is itself `undefined`.
 */
export function encodableFormOf(value: unknown): unknown {
  const method = encodableFormMethod(value);
  if (method === undefined) return undefined;

  // `Reflect.apply`, and not the method's own `.call`. A proxy answers each
  // property read however it likes, so a proxied function can report `typeof
  // "function"` while what its `.call` yields is not callable at all.
  // `Reflect.apply` reaches a function's call behavior directly rather than
  // reading a property off it, which holds whether the method in hand arrived
  // plain or through a proxy.
  return Reflect.apply(method, value, []);
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
type OnCopy = (copy: unknown, original: unknown) => void;

/**
 * Asked about each value the walk would otherwise pass through untouched,
 * and answers what should stand in its place -- the value itself to leave it
 * alone. This is how a caller says what ELSE has no fabric representation: a
 * `Cell`, whose encodable form is the link it stands for. Recognizing one takes
 * `isCell()`, and that lives in the runtime's core rather than here, so the
 * knowledge arrives as a function instead of as an import.
 */
type ReplaceOther = (value: object | AnyFunction) => unknown;

/** Shorthand for the callable shape the walk reaches. */
type AnyFunction = (...args: never[]) => unknown;

/**
 * Replaces every builder artifact reachable from `value` with its encodable
 * form, yielding a value the data model can represent. `replaceOther` extends
 * that to values the walk does not descend into (see `ReplaceOther`).
 *
 * A builder artifact carries its serializer as a `toEncodableForm` method (see
 * `builder/module.ts` and `builder/pattern.ts`). A method is a function-valued
 * property and a fabric record has none, so an artifact has to be replaced
 * before the value crosses into the data model. An artifact sits wherever a
 * pattern author put it -- under a tool's `handler` key, in a result, inside a
 * node's `inputs` -- so finding one takes a walk.
 *
 * Keying on that name is what makes this walk's subject BUILDER ARTIFACTS
 * specifically, rather than everything the data model's duck-typed `toJSON`
 * protocol would honor. The narrower question is the intended one: a plain
 * object that answers `toJSON` and was not built here is the conversion's to
 * interpret, and is left to it.
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
export function replaceArtifacts<T>(
  value: T,
  onCopy: OnCopy,
  replaceOther: ReplaceOther = (value) => value,
): T {
  return replace(value, new Map(), onCopy, replaceOther) as T;
}

function replace(
  value: unknown,
  seen: Map<object, unknown>,
  onCopy: OnCopy,
  replaceOther: ReplaceOther,
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
    if (!hasOwnEncodableForm(value)) {
      return replaced(value, replaceOther, seen, onCopy);
    }
    seen.set(value, IN_PROGRESS);
    return copied(
      replace(value.toEncodableForm(), seen, onCopy, replaceOther),
      value,
      seen,
      onCopy,
    );
  }

  // An array is answered by the array rule whatever it carries, so an array
  // is only ever descended into.
  const isArray = Array.isArray(value);
  if (!isArray && !isPlainObject(value, false)) {
    // Anything else -- a `FabricInstance`, a `Date` -- carries no builder
    // artifact, and is the conversion's to interpret unless `replaceOther`
    // claims it. A `Cell` is what that hook is for: the walk cannot name one
    // from here, and the conversion has no representation for it either.
    //
    // A null-prototype object is excluded too -- hence the `false` argument
    // to `isPlainObject()`. It is not a fabric record, so it is not the
    // walk's to rewrite. That is not the same as the conversion refusing one:
    // `native-type-tags.ts` answers it `Object`. Whether to accept it is the
    // conversion's question, asked of the value as it stands.
    return replaced(value, replaceOther, seen, onCopy);
  }

  seen.set(value, IN_PROGRESS);
  let flattened: unknown;
  if (isArray) {
    flattened = replaceInElements(value, seen, onCopy, replaceOther);
  } else if (hasOwnEncodableForm(value)) {
    // The artifact's OWN method is what gets called, rather than the
    // serializer it delegates to: the method a copy carries is closed over the
    // artifact the copy was made from, and that original is what the
    // serialized form describes.
    flattened = replace(value.toEncodableForm(), seen, onCopy, replaceOther);
  } else {
    flattened = replaceInEntries(
      value as Record<string, unknown>,
      seen,
      onCopy,
      replaceOther,
    );
  }
  return copied(flattened, value, seen, onCopy);
}

/**
 * Helper for `replace()`, which offers a value the walk does not descend into
 * to `replaceOther` and records whatever comes back.
 *
 * The replacement is NOT descended into. What the hook answers stands for the
 * value itself -- a link, say -- rather than being a container the walk has any
 * further claim on.
 */
function replaced(
  value: object | AnyFunction,
  replaceOther: ReplaceOther,
  seen: Map<object, unknown>,
  onCopy: OnCopy,
): unknown {
  const replacement = replaceOther(value);
  if (replacement === value) return value;
  return copied(replacement, value, seen, onCopy);
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
  replaceOther: ReplaceOther,
): readonly unknown[] {
  // Read each element ONCE, and build any copy from what was read -- the
  // array counterpart of the entries `replaceInEntries` materializes, for the
  // same reason. Copying by re-reading (`slice()`, or an index-by-index pass
  // over the original) runs an accessor-backed element a second time and
  // keeps THAT answer, storing a value the array never held at any single
  // moment and which the walk never inspected.
  //
  // So the result is built as it goes rather than cloned at the first change:
  // every element is written here, changed or not, and the original is
  // answered by identity unless something actually moved.
  const replaced: unknown[] = [];
  replaced.length = value.length;
  let changed = false;
  for (let i = 0; i < value.length; i++) {
    // A hole holds nothing to flatten, and reading one would report the
    // element as `undefined` and fill it in on the copy. Skipped, so it stays
    // a hole here too.
    if (!(i in value)) continue;
    const element = value[i];
    const flattened = replace(element, seen, onCopy, replaceOther);
    replaced[i] = flattened;
    if (flattened !== element) changed = true;
  }
  return changed ? replaced : value;
}

function replaceInEntries(
  value: Record<string, unknown>,
  seen: Map<object, unknown>,
  onCopy: OnCopy,
  replaceOther: ReplaceOther,
): Record<string, unknown> {
  // Read each member ONCE, and build any copy from what was read: reading a
  // second time to copy would run an accessor twice and keep the second
  // answer, so a value whose members are accessor-backed would be recorded
  // as something it never was at any single moment.
  const entries = Object.entries(value);
  let result: Record<string, unknown> | undefined;
  for (let i = 0; i < entries.length; i++) {
    const [key, element] = entries[i];
    const flattened = replace(element, seen, onCopy, replaceOther);
    if (flattened === element) continue;
    result ??= Object.fromEntries(entries);
    result[key] = flattened;
  }
  return result ?? value;
}

/**
 * Checks whether a value carries its own callable `toEncodableForm` method --
 * the walk's test for "this is a builder artifact".
 *
 * OWN, not inherited: an inherited one is not the value's own serializer, and
 * a single assignment to `Object.prototype.toEncodableForm` would otherwise
 * route every plain object in the process through this.
 *
 * And that name only, unlike `hasEncodableForm` above: this one decides, for
 * every object in an arbitrary graph, whether the runtime serializes it here
 * instead of leaving it to the conversion. Admitting `toJSON` would widen that
 * to any object carrying the JSON protocol's member, which is a question about
 * user data, not about builder artifacts.
 */
function hasOwnEncodableForm(
  value: object | ((...args: unknown[]) => unknown),
): value is { toEncodableForm(): unknown } {
  return Object.hasOwn(value, "toEncodableForm") &&
    typeof (value as { toEncodableForm: unknown }).toEncodableForm ===
      "function";
}

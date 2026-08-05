import { isPlainObject } from "@commonfabric/utils/types";

/**
 * Reads the method by which a value produces its encodable form -- the form it
 * takes on the way to being encoded, which reaches storage without ever being
 * stringified.
 *
 * One name is asked for: `toEncodableForm`. Every builder artifact carries it -- a
 * module, a handler, a pattern, and the factory that carries a module's members
 * -- and so does a `Cell`, whose form is the link it names. A cell is what a
 * caller here is likeliest to hold that is not an artifact: a graph feeding a
 * content-derived id or a builder default can carry one, and neither has a
 * representation for the cell itself. The storage boundary is elsewhere and
 * asks differently, recognizing a cell by class rather than by member.
 *
 * It is the runtime's OWN name, and that is the point. Asking by name rather
 * than by class is what lets this module stay a leaf -- naming `Cell` here
 * would mean importing the runtime's core, and the graph already runs the other
 * way. The name is not a public protocol, so no value acquires an encodable
 * form by carrying a member it defined for some other purpose.
 */
function encodableFormMethod(value: unknown): (() => unknown) | undefined {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return undefined;
  }

  const named = value as { toEncodableForm?: unknown };
  return typeof named.toEncodableForm === "function"
    ? named.toEncodableForm as () => unknown
    : undefined;
}

/**
 * Checks whether a value can produce an encodable form of itself.
 *
 * Deliberately BROADER than the walk's own test (`ownEncodableFormMethod`):
 * this accepts an inherited member, because its callers ask about a specific
 * value they already hold -- a pattern, a cell -- rather than sifting an
 * arbitrary graph. A cell satisfies this through an inherited member, that
 * being where a class puts its methods. The walk cannot afford that latitude;
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
  return method === undefined ? undefined : encodableFormFrom(method, value);
}

/**
 * Helper for the two readers above, which returns what an already-read
 * `toEncodableForm` produces, invoked on the value it was read from.
 */
function encodableFormFrom(method: () => unknown, value: unknown): unknown {
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
 * and returns what should stand in its place -- the value itself to leave it
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
 * returned as itself, so a copy's cycle edge points at the original.
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
    const method = ownEncodableFormMethod(value);
    if (method === undefined) {
      return replaced(value, replaceOther, seen, onCopy);
    }
    seen.set(value, IN_PROGRESS);
    return copied(
      replace(encodableFormFrom(method, value), seen, onCopy, replaceOther),
      value,
      seen,
      onCopy,
    );
  }

  // The array rule applies whatever an array carries, so an array is only ever
  // descended into.
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
    // `native-type-tags.ts` reports it as `Object`. Whether to accept it is the
    // conversion's question, asked of the value as it stands.
    return replaced(value, replaceOther, seen, onCopy);
  }

  seen.set(value, IN_PROGRESS);
  let flattened: unknown;
  if (isArray) {
    flattened = replaceInElements(value, seen, onCopy, replaceOther);
  } else {
    // The artifact's OWN method is what gets read and called, rather than the
    // serializer it delegates to: the method a copy carries is closed over the
    // artifact the copy was made from, and that original is what the
    // serialized form describes.
    const method = ownEncodableFormMethod(value);
    flattened = method === undefined
      ? replaceInEntries(
        value as Record<string, unknown>,
        seen,
        onCopy,
        replaceOther,
      )
      : replace(encodableFormFrom(method, value), seen, onCopy, replaceOther);
  }
  return copied(flattened, value, seen, onCopy);
}

/**
 * Helper for `replace()`, which offers a value the walk does not descend into
 * to `replaceOther` and records whatever comes back.
 *
 * The replacement is NOT descended into. What the hook returns stands for the
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
 * Records a replacement: the single place a copy becomes the replacement for
 * its original.
 *
 * Every branch above returns through here, and that is deliberate. The
 * bookkeeping a copy needs -- telling the caller so identity-keyed facts can
 * follow, and remembering the replacement so a value reachable twice is replaced
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
  // keeps THAT value, storing a value the array never held at any single
  // moment and which the walk never inspected.
  //
  // So the result is built as it goes rather than cloned at the first change:
  // every element is written here, changed or not, and the original is
  // returned by identity unless something actually moved.
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
  // value, so a value whose members are accessor-backed would be recorded
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
 * Helper for `replace()`, which returns a value's own callable
 * `toEncodableForm` method, or `undefined` when it has none. This is the walk's
 * test for "this is a builder artifact" and the source of the method it
 * invokes, in one result: the function returned is the one that gets called.
 *
 * A `Cell` never reaches this question. It carries the member on its class,
 * which own-ness would exclude anyway, but `replace()` stops short of here with
 * one: a cell is not a plain object, so it goes to the `replaceOther` hook,
 * whose caller can name one.
 */
function ownEncodableFormMethod(
  value: object | ((...args: unknown[]) => unknown),
): (() => unknown) | undefined {
  // OWN, not inherited: an inherited member is not the value's own serializer,
  // and a single assignment to `Object.prototype.toEncodableForm` would
  // otherwise route every plain object in the process through here.
  if (!Object.hasOwn(value, "toEncodableForm")) return undefined;

  // Read once, and hand back what was read. `Object.hasOwn` runs no accessor,
  // so this is the only read; an accessor-backed member asked again at the
  // invoke would run a second time, and its second result is what would get
  // serialized.
  const method = (value as { toEncodableForm: unknown }).toEncodableForm;

  // The `typeof` gate is what settles a value carrying a user-data key of the
  // name -- a query-result proxy answers `Object.hasOwn` for any key its record
  // holds -- since a fabric record has no function-valued member to find. It
  // also keeps this to `toEncodableForm` alone: the JSON protocol's member
  // would widen the question from builder artifacts to user data.
  return typeof method === "function" ? method as () => unknown : undefined;
}

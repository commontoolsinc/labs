import { EditorState, Range, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";
import { MENTION_REF_KEY_SOURCE } from "../../../core/mention-refs.ts";

/**
 * A mention written as a markdown reference link, `[Label][key]`, whose key
 * resolves through the document's reference map.
 */
export interface MentionRefInfo {
  from: number; // Start of [
  to: number; // End of ]
  labelFrom: number; // Start of the label (after [)
  labelTo: number; // End of the label (the ] closing it)
  key: string; // The reference key
  label: string; // The display text
}

/**
 * A token has to look like a reference before anything reads it, and the
 * label cannot span a line, so a mention is always a single-line range.
 */
const REF_TOKEN = new RegExp(
  String.raw`\[([^\]\n]*)\]\[(${MENTION_REF_KEY_SOURCE})\]`,
  "g",
);

const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * Every key in the document that could name a mention, whether or not the map
 * holds it. The mint reads this so a pasted token's key is never handed out a
 * second time.
 */
export function scanRefKeys(doc: string): Set<string> {
  const keys = new Set<string>();
  REF_TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = REF_TOKEN.exec(doc)) !== null) {
    keys.add(match[2]);
  }
  return keys;
}

/**
 * Parse the mentions in a document.
 *
 * A token is a mention when the map holds its key, and ordinary text
 * otherwise. Membership rather than shape is what decides, so a hand-written
 * reference link — `[the docs][readme]` — is never captured, protected, or
 * styled. The cost is that a token whose entry has not arrived yet reads as
 * plain text until it does.
 */
export function parseMentionRefs(
  doc: string,
  knownKeys: ReadonlySet<string>,
): MentionRefInfo[] {
  if (knownKeys.size === 0) return [];

  const refs: MentionRefInfo[] = [];
  REF_TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = REF_TOKEN.exec(doc)) !== null) {
    const key = match[2];
    if (!knownKeys.has(key)) continue;

    const label = match[1];
    const from = match.index;
    const labelFrom = from + 1;

    refs.push({
      from,
      to: from + match[0].length,
      labelFrom,
      labelTo: labelFrom + label.length,
      key,
      label,
    });
  }

  return refs;
}

/**
 * Where a key's token sits in a document, whatever its label now reads.
 *
 * The label is ordinary editable text, so the only durable handle on a token
 * is the key inside it. Finding one by the string that was inserted would miss
 * a token the user has since retyped — which is exactly the window an
 * in-flight create leaves open.
 */
export function findRefToken(
  doc: string,
  key: string,
): { from: number; to: number; label: string } | null {
  // The key comes from the mint, whose alphabet holds no metacharacters.
  const match = new RegExp(`\\[([^\\]\\n]*)\\]\\[${key}\\]`).exec(doc);
  if (!match) return null;

  return {
    from: match.index,
    to: match.index + match[0].length,
    label: match[1],
  };
}

/** Announce the keys the document's reference map currently holds. */
export const setKnownRefKeys = StateEffect.define<readonly string[]>();

interface MentionRefState {
  keys: ReadonlySet<string>;
  refs: MentionRefInfo[];
}

/**
 * The mentions in the document, reparsed when either the text or the set of
 * known keys changes. Everything else reads from here rather than scanning the
 * document again.
 */
export const mentionRefField = StateField.define<MentionRefState>({
  create() {
    return { keys: NO_KEYS, refs: [] };
  },
  update(value, tr) {
    let keys = value.keys;
    for (const effect of tr.effects) {
      if (effect.is(setKnownRefKeys)) keys = new Set(effect.value);
    }
    if (keys === value.keys && !tr.docChanged) return value;
    return { keys, refs: parseMentionRefs(tr.newDoc.toString(), keys) };
  },
});

/** The mentions in a state, for readers outside this module. */
export function mentionRefs(state: EditorState): MentionRefInfo[] {
  return state.field(mentionRefField).refs;
}

/**
 * Make the cursor skip the parts of a mention that are not its label: the
 * opening `[`, and the `][key]` that closes it.
 */
export const atomicMentionRefRanges = EditorView.atomicRanges.of((view) => {
  const decorations: Range<Decoration>[] = [];

  for (const ref of mentionRefs(view.state)) {
    decorations.push(Decoration.mark({}).range(ref.from, ref.labelFrom));
    decorations.push(Decoration.mark({}).range(ref.labelTo, ref.to));
  }

  decorations.sort((a, b) => a.from - b.from);
  return Decoration.set(decorations);
});

/** An edit that begins inside `][key]` — dropped, since it edits identity. */
function startsInsideKey(ref: MentionRefInfo, fromA: number): boolean {
  return fromA > ref.labelTo && fromA < ref.to;
}

/**
 * An edit that begins at or before the label's end and runs into the key.
 *
 * A change covering the mention from before its start to at or past its end
 * is exempt: that is how a mention is deleted, and truncating it would leave
 * the key behind. Anything else is truncated at the label's end — including a
 * change that ends exactly at the token's edge, which would otherwise take
 * `][key]` with it and leave `[Label` behind as malformed text.
 */
function reachesIntoKey(
  ref: MentionRefInfo,
  fromA: number,
  toA: number,
): boolean {
  if (fromA <= ref.from && toA >= ref.to) return false;
  return fromA <= ref.labelTo && toA > ref.labelTo;
}

/**
 * Keep edits out of the `][key]` that carries a mention's identity: an edit
 * starting inside it is dropped, and one running into it from the label is
 * truncated at the label's end. A change spanning the whole mention still
 * deletes it, which is how a mention is removed.
 */
export const mentionRefEditFilter = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr;

  const refs = tr.startState.field(mentionRefField).refs;
  if (refs.length === 0) return tr;

  let needsModification = false;

  tr.changes.iterChanges((fromA, toA) => {
    for (const ref of refs) {
      if (startsInsideKey(ref, fromA) || reachesIntoKey(ref, fromA, toA)) {
        needsModification = true;
        return;
      }
    }
  });

  if (!needsModification) return tr;

  const specs: { from: number; to: number; insert: string }[] = [];

  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    let adjustedTo = toA;
    let shouldInclude = true;

    for (const ref of refs) {
      if (startsInsideKey(ref, fromA)) {
        shouldInclude = false;
        break;
      }
      // The EARLIEST boundary wins. One change can reach from inside one
      // mention's label into a later mention's key, and taking the last
      // match would move the cut past the first mention's key and delete it.
      if (reachesIntoKey(ref, fromA, toA)) {
        adjustedTo = Math.min(adjustedTo, ref.labelTo);
      }
    }

    if (shouldInclude) {
      specs.push({ from: fromA, to: adjustedTo, insert: inserted.toString() });
    }
  });

  // No selection is carried over. The original one was computed for changes
  // that are no longer being applied, so reusing it puts the caret where the
  // rejected edit would have left it — inside the hidden `][key]`, for a
  // keystroke that never landed. Omitting it lets CodeMirror map the previous
  // selection through the changes that did survive.
  return { changes: specs, effects: tr.effects };
});

/**
 * Render a mention as a pill, and reveal `[Label]` when the cursor is in it.
 * The key is never shown: it is a local token with nothing to say to a reader.
 */
export function createMentionRefDecorationPlugin() {
  const pillMark = Decoration.mark({ class: "cm-mention-ref-pill" });
  const hiddenReplace = Decoration.replace({});

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = this.getMentionRefDecorations(view);
      }

      update(update: ViewUpdate) {
        if (
          update.docChanged || update.viewportChanged ||
          update.selectionSet || update.focusChanged ||
          update.transactions.some((tr) =>
            tr.effects.some((effect) => effect.is(setKnownRefKeys))
          )
        ) {
          this.decorations = this.getMentionRefDecorations(update.view);
        }
      }

      getMentionRefDecorations(view: EditorView) {
        const decorations: Range<Decoration>[] = [];
        const hasFocus = view.hasFocus;
        const { head, from: selectionFrom, to: selectionTo } = view.state
          .selection.main;

        for (const ref of mentionRefs(view.state)) {
          const cursorInside = hasFocus && head >= ref.from && head <= ref.to;
          const selectionOverlaps = hasFocus && selectionFrom < ref.to &&
            selectionTo > ref.from;

          if (cursorInside || selectionOverlaps) {
            // Editing: show [Label], hide only the [key] that follows it.
            decorations.push(hiddenReplace.range(ref.labelTo + 1, ref.to));
          } else {
            decorations.push(hiddenReplace.range(ref.from, ref.labelFrom));
            decorations.push(pillMark.range(ref.labelFrom, ref.labelTo));
            decorations.push(hiddenReplace.range(ref.labelTo, ref.to));
          }
        }

        decorations.sort((a, b) => a.from - b.from || a.to - b.to);

        return Decoration.set(decorations);
      }
    },
    {
      decorations: (v) => v.decorations,
    },
  );
}

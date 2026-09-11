/**
 * A memo keyed by a hint, with each hit confirmed against the subject it was
 * computed for.
 *
 * A key here is cheap to derive and may be shared by subjects that are not
 * the same — a profile cell's entity id, say, which two cells in different
 * spaces can share. So a key only narrows the search: a remembered answer is
 * served to a subject the `same` comparison accepts, and subjects sharing a
 * key are kept apart.
 */

/** An answer computed for one subject, remembered under a key others may share. */
interface MemoEntry<Subject, Answer> {
  subject: Subject;
  answer: Answer;
}

/**
 * Remembers `compute(subject)` per subject. `keyOf` narrows the search and a
 * subject it cannot key is computed every time; `same` decides whether a
 * remembered subject is this one.
 */
export const memoBy = <Subject, Answer>(
  keyOf: (subject: Subject) => string | undefined,
  same: (remembered: Subject, subject: Subject) => boolean,
  compute: (subject: Subject) => Answer,
): (subject: Subject) => Answer => {
  const entries = new Map<string, MemoEntry<Subject, Answer>[]>();
  return (subject) => {
    const key = keyOf(subject);
    if (key === undefined) return compute(subject);
    const known = entries.get(key);
    if (known !== undefined) {
      for (const entry of known) {
        if (same(entry.subject, subject)) return entry.answer;
      }
    }
    const answer = compute(subject);
    if (known === undefined) {
      entries.set(key, [{ subject, answer }]);
    } else {
      known.push({ subject, answer });
    }
    return answer;
  };
};

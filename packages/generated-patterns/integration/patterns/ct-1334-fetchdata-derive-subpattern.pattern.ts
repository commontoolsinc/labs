import { computed, fetchData, pattern } from "commonfabric";

// CT-1334: Sub-pattern combining fetchData() with a computed() projection that
// captures a pattern parameter in a template literal.
//
// The `token` from the sub-pattern's destructured input is captured inside
// computed() via `${token}`. The ts-transformer must extract it as an
// explicit input so the projection receives the resolved value.
//
// NOTE on the explicit fetchData<T>: this test asserts the *materialized*
// contact names, so `page.result` must carry a concrete schema. With no type
// arg, FetchDataFunction's only inference site (`result?: T`) is absent, so TS
// infers `T = unknown`; the transformer then emits the computed's input schema
// for `page.result` as `{ type: "unknown" }`. A `{type:"unknown"}` field does
// not schema-materialize across the computed capture boundary at runtime
// (runner traverse.ts returns it as `undefined`), so the body would read
// `pageResult === undefined` and `pending` would stay `true` forever.
//
// TODO(CT-1334 follow-up): The old `derive` form used the same untyped call and
// the test asserted the same materialized names — but whether it actually
// *passed* on main (and if so, whether the derive path carried a non-`unknown`
// result schema, i.e. a dropped type-threading registry, vs. derive's
// value-in-input-slot bypassing schema-materialization entirely) is NOT yet
// verified. Pending an old-vs-new transformed-output comparison; file a Linear
// ticket with the outcome and link it here.
//
// Typing the call supplies the schema the assertion semantically requires.

const FetchPage = pattern<
  { token: string },
  { contacts: string[]; pending: boolean }
>(({ token }) => {
  const url = computed(() => {
    if (!token) return "";
    return `http://localhost:59999/api/contacts?token=${token}`;
  });

  const options = computed(() => ({
    headers: { Authorization: `Bearer ${token}` },
  }));

  const page = fetchData<{ connections: { name: string }[] }>({
    url,
    options,
    mode: "json",
  });

  const pageResultRef = page.result;
  const pageErrorRef = page.error;
  const pagePendingRef = page.pending;

  return computed(() => {
    const pageResult: any = pageResultRef;
    const pageError: any = pageErrorRef;
    const pagePending: boolean = pagePendingRef;
    if (pagePending || !pageResult) {
      return { contacts: [] as string[], pending: true };
    }
    if (pageError) {
      return { contacts: [] as string[], pending: false };
    }
    const contacts = (pageResult.connections || []).map(
      (c: any) => c.name as string,
    );
    return { contacts, pending: false };
  });
});

export const fetchDataDeriveSubpattern = pattern<
  { token: string },
  { contacts: string[]; pending: boolean }
>(({ token }) => {
  const fetchResult = FetchPage({ token }) as any;
  return {
    contacts: fetchResult.contacts,
    pending: fetchResult.pending,
  };
});

export default fetchDataDeriveSubpattern;

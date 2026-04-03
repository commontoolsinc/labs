/// <cts-enable />
import { computed, derive, fetchData, pattern } from "commontools";

// CT-1334: Sub-pattern combining fetchData() + derive() with computed()
// capturing pattern parameter in template literal.
//
// The `token` from the sub-pattern's destructured input is captured inside
// computed() via `${token}`. The ts-transformer must extract it as an
// explicit derive input so the callback receives the resolved value.

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

  const page = fetchData({ url, options, mode: "json" });

  return derive(
    {
      pageResult: page.result,
      pageError: page.error,
      pagePending: page.pending,
    },
    ({
      pageResult,
      pageError,
      pagePending,
    }: {
      pageResult: any;
      pageError: any;
      pagePending: boolean;
    }) => {
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
    },
  );
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

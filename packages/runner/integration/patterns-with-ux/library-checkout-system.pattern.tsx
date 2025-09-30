/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  cell,
  compute,
  Default,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

interface LibraryItem {
  id: string;
  title: string;
  copiesTotal: number;
}

interface LoanRecord {
  sequence: number;
  itemId: string;
  memberId: string;
}

interface HoldRecord {
  sequence: number;
  itemId: string;
  memberId: string;
}

interface CheckoutEvent {
  itemId?: string;
  memberId?: string;
}

interface HoldEvent {
  itemId?: string;
  memberId?: string;
}

interface CirculationChange {
  sequence: number;
  type: "checkout" | "return" | "hold" | "cancel";
  itemId: string;
  memberId: string;
  note: string;
}

interface LibraryCheckoutArgs {
  catalog: Default<LibraryItem[], typeof defaultCatalog>;
  loans: Default<LoanRecord[], typeof defaultLoans>;
  holds: Default<HoldRecord[], typeof defaultHolds>;
}

interface ItemAvailability {
  id: string;
  title: string;
  totalCopies: number;
  activeLoans: number;
  availableCopies: number;
  holdsQueued: number;
  loanMembers: string[];
  holdMembers: string[];
  nextHold: string | null;
  status: "available" | "limited" | "on-hold" | "unavailable";
  statusLabel: string;
}

interface CirculationContext {
  catalog: Cell<LibraryItem[]>;
  loans: Cell<LoanRecord[]>;
  holds: Cell<HoldRecord[]>;
  eventSequence: Cell<number>;
  lastChange: Cell<CirculationChange | null>;
}

const defaultCatalog: LibraryItem[] = [
  { id: "atlas-of-dawn", title: "Atlas of Dawn", copiesTotal: 3 },
  { id: "modular-thoughts", title: "Modular Thoughts", copiesTotal: 1 },
  { id: "synthesis-primer", title: "Synthesis Primer", copiesTotal: 2 },
];

const defaultLoans: LoanRecord[] = [
  { sequence: 1, itemId: "atlas-of-dawn", memberId: "member-alba" },
  { sequence: 2, itemId: "modular-thoughts", memberId: "member-luis" },
];

const defaultHolds: HoldRecord[] = [
  { sequence: 1, itemId: "modular-thoughts", memberId: "member-jade" },
];

const slugify = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  const slug = trimmed.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : null;
};

const sanitizeItemId = (value: unknown): string | null => {
  const slug = slugify(value);
  return slug ?? null;
};

const sanitizeMemberId = (value: unknown): string | null => {
  const slug = slugify(value);
  if (!slug) return null;
  return slug.startsWith("member-") ? slug : `member-${slug}`;
};

const sanitizeTitle = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim().replace(/\s+/g, " ");
    if (trimmed.length > 0) return trimmed;
  }
  return fallback;
};

const sanitizeCopies = (value: unknown, fallback: number): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.floor(value);
    if (normalized > 0) return normalized;
  }
  return fallback;
};

const cloneCatalog = (items: readonly LibraryItem[]): LibraryItem[] =>
  items.map((item) => ({ ...item }));

const cloneLoans = (loans: readonly LoanRecord[]): LoanRecord[] =>
  loans.map((loan) => ({ ...loan }));

const cloneHolds = (holds: readonly HoldRecord[]): HoldRecord[] =>
  holds.map((hold) => ({ ...hold }));

const sanitizeCatalogList = (value: unknown): LibraryItem[] => {
  if (!Array.isArray(value) || value.length === 0) {
    return cloneCatalog(defaultCatalog);
  }
  const used = new Set<string>();
  const sanitized: LibraryItem[] = [];
  for (let index = 0; index < value.length; index++) {
    const entry = value[index] as Partial<LibraryItem> | undefined;
    const fallback = defaultCatalog[index] ?? defaultCatalog[0];
    const id = sanitizeItemId(entry?.id ?? fallback.id);
    if (!id || used.has(id)) continue;
    const title = sanitizeTitle(entry?.title, fallback.title);
    const copies = sanitizeCopies(entry?.copiesTotal, fallback.copiesTotal);
    sanitized.push({ id, title, copiesTotal: copies });
    used.add(id);
  }
  return sanitized.length > 0 ? sanitized : cloneCatalog(defaultCatalog);
};

const sanitizeLoanList = (
  catalog: readonly LibraryItem[],
  value: unknown,
): LoanRecord[] => {
  const validItems = new Set(catalog.map((item) => item.id));
  if (!Array.isArray(value)) {
    return cloneLoans(
      defaultLoans.filter((loan) => validItems.has(loan.itemId)),
    );
  }
  if (value.length === 0) return [];
  const seen = new Set<string>();
  const sanitized: LoanRecord[] = [];
  for (const candidate of value) {
    const raw = candidate as Partial<LoanRecord> | undefined;
    const itemId = sanitizeItemId(raw?.itemId);
    const memberId = sanitizeMemberId(raw?.memberId);
    if (!itemId || !memberId || !validItems.has(itemId)) continue;
    const key = `${itemId}|${memberId}`;
    if (seen.has(key)) continue;
    sanitized.push({
      sequence: sanitized.length + 1,
      itemId,
      memberId,
    });
    seen.add(key);
  }
  return sanitized;
};

const sanitizeHoldList = (
  catalog: readonly LibraryItem[],
  value: unknown,
): HoldRecord[] => {
  const validItems = new Set(catalog.map((item) => item.id));
  if (!Array.isArray(value)) {
    return cloneHolds(
      defaultHolds.filter((hold) => validItems.has(hold.itemId)),
    );
  }
  if (value.length === 0) return [];
  const seen = new Set<string>();
  const sanitized: HoldRecord[] = [];
  for (const candidate of value) {
    const raw = candidate as Partial<HoldRecord> | undefined;
    const itemId = sanitizeItemId(raw?.itemId);
    const memberId = sanitizeMemberId(raw?.memberId);
    if (!itemId || !memberId || !validItems.has(itemId)) continue;
    const key = `${itemId}|${memberId}`;
    if (seen.has(key)) continue;
    sanitized.push({
      sequence: sanitized.length + 1,
      itemId,
      memberId,
    });
    seen.add(key);
  }
  return sanitized;
};

const formatCount = (
  count: number,
  singular: string,
  plural: string,
): string => {
  const value = count === 1 ? singular : plural;
  return `${count} ${value}`;
};

const statusLabelFor = (
  status: ItemAvailability["status"],
  available: number,
  total: number,
  holdCount: number,
): string => {
  switch (status) {
    case "available": {
      const base = `All ${total} copies available`;
      if (holdCount === 0) return base;
      const holdLabel = holdCount === 1
        ? "1 hold queued"
        : `${holdCount} holds queued`;
      return `${base}; ${holdLabel}`;
    }
    case "limited": {
      const base = `${available} of ${total} copies available`;
      if (holdCount === 0) return base;
      const holdLabel = holdCount === 1
        ? "1 hold queued"
        : `${holdCount} holds queued`;
      return `${base}; ${holdLabel}`;
    }
    case "on-hold": {
      const holdLabel = holdCount === 1
        ? "1 hold waiting"
        : `${holdCount} holds waiting`;
      return `All copies loaned; ${holdLabel}`;
    }
    case "unavailable":
      return "All copies loaned out";
  }
};

const computeAvailability = (
  catalog: readonly LibraryItem[],
  loans: readonly LoanRecord[],
  holds: readonly HoldRecord[],
): ItemAvailability[] => {
  const loansByItem = new Map<string, LoanRecord[]>();
  for (const loan of loans) {
    const bucket = loansByItem.get(loan.itemId) ?? [];
    bucket.push(loan);
    loansByItem.set(loan.itemId, bucket);
  }
  const holdsByItem = new Map<string, HoldRecord[]>();
  for (const hold of holds) {
    const bucket = holdsByItem.get(hold.itemId) ?? [];
    bucket.push(hold);
    holdsByItem.set(hold.itemId, bucket);
  }
  return catalog.map((item) => {
    const itemLoans = loansByItem.get(item.id) ?? [];
    const itemHolds = holdsByItem.get(item.id) ?? [];
    const availableCopies = Math.max(item.copiesTotal - itemLoans.length, 0);
    const holdCount = itemHolds.length;
    let status: ItemAvailability["status"];
    if (availableCopies === item.copiesTotal) status = "available";
    else if (availableCopies > 0) status = "limited";
    else if (holdCount > 0) status = "on-hold";
    else status = "unavailable";
    const statusLabel = statusLabelFor(
      status,
      availableCopies,
      item.copiesTotal,
      holdCount,
    );
    return {
      id: item.id,
      title: item.title,
      totalCopies: item.copiesTotal,
      activeLoans: itemLoans.length,
      availableCopies,
      holdsQueued: holdCount,
      loanMembers: itemLoans.map((loan) => loan.memberId),
      holdMembers: itemHolds.map((hold) => hold.memberId),
      nextHold: itemHolds.length > 0 ? itemHolds[0]?.memberId ?? null : null,
      status,
      statusLabel,
    };
  });
};

const recordChange = (
  context: CirculationContext,
  change: Omit<CirculationChange, "sequence">,
) => {
  const current = context.eventSequence.get();
  const base = typeof current === "number" && Number.isFinite(current) &&
      current > 0
    ? current
    : 1;
  context.lastChange.set({ sequence: base, ...change });
  context.eventSequence.set(base + 1);
};

const checkoutItem = handler(
  (
    event: CheckoutEvent | undefined,
    context: CirculationContext,
  ) => {
    const itemId = sanitizeItemId(event?.itemId);
    const memberId = sanitizeMemberId(event?.memberId);
    if (!itemId || !memberId) return;

    const catalogList = sanitizeCatalogList(context.catalog.get());
    const loansList = sanitizeLoanList(catalogList, context.loans.get());
    const holdsList = sanitizeHoldList(catalogList, context.holds.get());
    context.catalog.set(catalogList);
    const item = catalogList.find((entry) => entry.id === itemId);
    if (!item) return;

    if (
      loansList.some((loan) =>
        loan.itemId === itemId && loan.memberId === memberId
      )
    ) {
      return;
    }

    const activeForItem = loansList.filter((loan) => loan.itemId === itemId);
    if (activeForItem.length >= item.copiesTotal) return;

    const appended = [
      ...loansList,
      { sequence: loansList.length + 1, itemId, memberId },
    ];
    const sanitizedLoans = sanitizeLoanList(catalogList, appended);
    context.loans.set(sanitizedLoans);

    const filteredHolds = holdsList.filter((hold) =>
      !(hold.itemId === itemId && hold.memberId === memberId)
    );
    if (filteredHolds.length !== holdsList.length) {
      context.holds.set(sanitizeHoldList(catalogList, filteredHolds));
    }

    recordChange(context, {
      type: "checkout",
      itemId,
      memberId,
      note: `${memberId} checked out ${item.title}`,
    });
  },
);

const returnItem = handler(
  (
    event: CheckoutEvent | undefined,
    context: CirculationContext,
  ) => {
    const itemId = sanitizeItemId(event?.itemId);
    const requestedMember = sanitizeMemberId(event?.memberId);
    if (!itemId) return;

    const catalogList = sanitizeCatalogList(context.catalog.get());
    context.catalog.set(catalogList);
    const item = catalogList.find((entry) => entry.id === itemId);
    if (!item) return;

    const sanitizedLoans = sanitizeLoanList(
      catalogList,
      context.loans.get(),
    );
    const sanitizedHolds = sanitizeHoldList(
      catalogList,
      context.holds.get(),
    );

    const loanIndex = sanitizedLoans.findIndex((loan) => {
      if (loan.itemId !== itemId) return false;
      if (!requestedMember) return true;
      return loan.memberId === requestedMember;
    });
    if (loanIndex === -1) return;

    const removedLoan = sanitizedLoans[loanIndex];
    let loansAfter = sanitizeLoanList(
      catalogList,
      sanitizedLoans.filter((_, index) => index !== loanIndex),
    );

    let holdsAfter = sanitizedHolds;
    let promotedNote = "";
    let promotedMember: string | null = null;

    let promotedHold: HoldRecord | null = null;
    const holdRemainder: HoldRecord[] = [];
    for (const hold of holdsAfter) {
      if (!promotedHold && hold.itemId === itemId) {
        promotedHold = hold;
        promotedMember = hold.memberId;
        continue;
      }
      holdRemainder.push(hold);
    }

    if (promotedHold) {
      holdsAfter = sanitizeHoldList(catalogList, holdRemainder);
      loansAfter = sanitizeLoanList(catalogList, [
        ...loansAfter,
        {
          sequence: loansAfter.length + 1,
          itemId: promotedHold.itemId,
          memberId: promotedHold.memberId,
        },
      ]);
      promotedNote = `; promoted hold for ${promotedHold.memberId}`;
    }

    context.loans.set(loansAfter);
    context.holds.set(holdsAfter);

    recordChange(context, {
      type: "return",
      itemId,
      memberId: removedLoan.memberId,
      note: `${removedLoan.memberId} returned ${item.title}${promotedNote}`,
    });

    if (promotedMember) {
      recordChange(context, {
        type: "checkout",
        itemId,
        memberId: promotedMember,
        note: `${promotedMember} checked out ${item.title} via hold`,
      });
    }
  },
);

const placeHold = handler(
  (
    event: HoldEvent | undefined,
    context: CirculationContext,
  ) => {
    const itemId = sanitizeItemId(event?.itemId);
    const memberId = sanitizeMemberId(event?.memberId);
    if (!itemId || !memberId) return;

    const catalogList = sanitizeCatalogList(context.catalog.get());
    context.catalog.set(catalogList);
    const item = catalogList.find((entry) => entry.id === itemId);
    if (!item) return;

    const holdsList = sanitizeHoldList(catalogList, context.holds.get());
    context.holds.set(holdsList);
    if (
      holdsList.some((hold) =>
        hold.itemId === itemId && hold.memberId === memberId
      )
    ) {
      return;
    }

    const appended = [
      ...holdsList,
      { sequence: holdsList.length + 1, itemId, memberId },
    ];
    context.holds.set(sanitizeHoldList(catalogList, appended));

    recordChange(context, {
      type: "hold",
      itemId,
      memberId,
      note: `${memberId} placed hold on ${item.title}`,
    });
  },
);

const cancelHold = handler(
  (
    event: HoldEvent | undefined,
    context: CirculationContext,
  ) => {
    const itemId = sanitizeItemId(event?.itemId);
    const memberId = sanitizeMemberId(event?.memberId);
    if (!itemId || !memberId) return;

    const catalogList = sanitizeCatalogList(context.catalog.get());
    context.catalog.set(catalogList);
    const item = catalogList.find((entry) => entry.id === itemId);
    if (!item) return;

    const holdsList = sanitizeHoldList(catalogList, context.holds.get());
    context.holds.set(holdsList);
    const filtered = holdsList.filter((hold) =>
      !(hold.itemId === itemId && hold.memberId === memberId)
    );
    if (filtered.length === holdsList.length) return;

    context.holds.set(sanitizeHoldList(catalogList, filtered));

    recordChange(context, {
      type: "cancel",
      itemId,
      memberId,
      note: `${memberId} canceled hold on ${item.title}`,
    });
  },
);

// UI handlers
const uiCheckoutItem = handler(
  (
    _event: unknown,
    context: {
      catalog: Cell<LibraryItem[]>;
      loans: Cell<LoanRecord[]>;
      holds: Cell<HoldRecord[]>;
      eventSequence: Cell<number>;
      lastChange: Cell<CirculationChange | null>;
      itemIdField: Cell<string>;
      memberIdField: Cell<string>;
    },
  ) => {
    const itemIdStr = context.itemIdField.get();
    const memberIdStr = context.memberIdField.get();
    const itemId = sanitizeItemId(itemIdStr);
    const memberId = sanitizeMemberId(memberIdStr);
    if (!itemId || !memberId) return;

    const catalogList = sanitizeCatalogList(context.catalog.get());
    const loansList = sanitizeLoanList(catalogList, context.loans.get());
    const holdsList = sanitizeHoldList(catalogList, context.holds.get());
    context.catalog.set(catalogList);
    const item = catalogList.find((entry) => entry.id === itemId);
    if (!item) return;

    if (
      loansList.some((loan) =>
        loan.itemId === itemId && loan.memberId === memberId
      )
    ) {
      return;
    }

    const activeForItem = loansList.filter((loan) => loan.itemId === itemId);
    if (activeForItem.length >= item.copiesTotal) return;

    const appended = [
      ...loansList,
      { sequence: loansList.length + 1, itemId, memberId },
    ];
    const sanitizedLoans = sanitizeLoanList(catalogList, appended);
    context.loans.set(sanitizedLoans);

    const filteredHolds = holdsList.filter((hold) =>
      !(hold.itemId === itemId && hold.memberId === memberId)
    );
    if (filteredHolds.length !== holdsList.length) {
      context.holds.set(sanitizeHoldList(catalogList, filteredHolds));
    }

    recordChange(context, {
      type: "checkout",
      itemId,
      memberId,
      note: `${memberId} checked out ${item.title}`,
    });

    context.itemIdField.set("");
    context.memberIdField.set("");
  },
);

const uiReturnItem = handler(
  (
    _event: unknown,
    context: {
      catalog: Cell<LibraryItem[]>;
      loans: Cell<LoanRecord[]>;
      holds: Cell<HoldRecord[]>;
      eventSequence: Cell<number>;
      lastChange: Cell<CirculationChange | null>;
      returnItemIdField: Cell<string>;
      returnMemberIdField: Cell<string>;
    },
  ) => {
    const itemIdStr = context.returnItemIdField.get();
    const memberIdStr = context.returnMemberIdField.get();
    const itemId = sanitizeItemId(itemIdStr);
    const requestedMember = sanitizeMemberId(memberIdStr);
    if (!itemId) return;

    const catalogList = sanitizeCatalogList(context.catalog.get());
    context.catalog.set(catalogList);
    const item = catalogList.find((entry) => entry.id === itemId);
    if (!item) return;

    const sanitizedLoans = sanitizeLoanList(
      catalogList,
      context.loans.get(),
    );
    const sanitizedHolds = sanitizeHoldList(
      catalogList,
      context.holds.get(),
    );

    const loanIndex = sanitizedLoans.findIndex((loan) => {
      if (loan.itemId !== itemId) return false;
      if (!requestedMember) return true;
      return loan.memberId === requestedMember;
    });
    if (loanIndex === -1) return;

    const removedLoan = sanitizedLoans[loanIndex];
    let loansAfter = sanitizeLoanList(
      catalogList,
      sanitizedLoans.filter((_, index) => index !== loanIndex),
    );

    let holdsAfter = sanitizedHolds;
    let promotedNote = "";
    let promotedMember: string | null = null;

    let promotedHold: HoldRecord | null = null;
    const holdRemainder: HoldRecord[] = [];
    for (const hold of holdsAfter) {
      if (!promotedHold && hold.itemId === itemId) {
        promotedHold = hold;
        promotedMember = hold.memberId;
        continue;
      }
      holdRemainder.push(hold);
    }

    if (promotedHold) {
      holdsAfter = sanitizeHoldList(catalogList, holdRemainder);
      loansAfter = sanitizeLoanList(catalogList, [
        ...loansAfter,
        {
          sequence: loansAfter.length + 1,
          itemId: promotedHold.itemId,
          memberId: promotedHold.memberId,
        },
      ]);
      promotedNote = `; promoted hold for ${promotedHold.memberId}`;
    }

    context.loans.set(loansAfter);
    context.holds.set(holdsAfter);

    recordChange(context, {
      type: "return",
      itemId,
      memberId: removedLoan.memberId,
      note: `${removedLoan.memberId} returned ${item.title}${promotedNote}`,
    });

    if (promotedMember) {
      recordChange(context, {
        type: "checkout",
        itemId,
        memberId: promotedMember,
        note: `${promotedMember} checked out ${item.title} via hold`,
      });
    }

    context.returnItemIdField.set("");
    context.returnMemberIdField.set("");
  },
);

const uiPlaceHold = handler(
  (
    _event: unknown,
    context: {
      catalog: Cell<LibraryItem[]>;
      holds: Cell<HoldRecord[]>;
      eventSequence: Cell<number>;
      lastChange: Cell<CirculationChange | null>;
      holdItemIdField: Cell<string>;
      holdMemberIdField: Cell<string>;
    },
  ) => {
    const itemIdStr = context.holdItemIdField.get();
    const memberIdStr = context.holdMemberIdField.get();
    const itemId = sanitizeItemId(itemIdStr);
    const memberId = sanitizeMemberId(memberIdStr);
    if (!itemId || !memberId) return;

    const catalogList = sanitizeCatalogList(context.catalog.get());
    context.catalog.set(catalogList);
    const item = catalogList.find((entry) => entry.id === itemId);
    if (!item) return;

    const holdsList = sanitizeHoldList(catalogList, context.holds.get());
    context.holds.set(holdsList);
    if (
      holdsList.some((hold) =>
        hold.itemId === itemId && hold.memberId === memberId
      )
    ) {
      return;
    }

    const appended = [
      ...holdsList,
      { sequence: holdsList.length + 1, itemId, memberId },
    ];
    context.holds.set(sanitizeHoldList(catalogList, appended));

    recordChange(context, {
      type: "hold",
      itemId,
      memberId,
      note: `${memberId} placed hold on ${item.title}`,
    });

    context.holdItemIdField.set("");
    context.holdMemberIdField.set("");
  },
);

const uiCancelHold = handler(
  (
    _event: unknown,
    context: {
      catalog: Cell<LibraryItem[]>;
      holds: Cell<HoldRecord[]>;
      eventSequence: Cell<number>;
      lastChange: Cell<CirculationChange | null>;
      cancelHoldItemIdField: Cell<string>;
      cancelHoldMemberIdField: Cell<string>;
    },
  ) => {
    const itemIdStr = context.cancelHoldItemIdField.get();
    const memberIdStr = context.cancelHoldMemberIdField.get();
    const itemId = sanitizeItemId(itemIdStr);
    const memberId = sanitizeMemberId(memberIdStr);
    if (!itemId || !memberId) return;

    const catalogList = sanitizeCatalogList(context.catalog.get());
    context.catalog.set(catalogList);
    const item = catalogList.find((entry) => entry.id === itemId);
    if (!item) return;

    const holdsList = sanitizeHoldList(catalogList, context.holds.get());
    context.holds.set(holdsList);
    const filtered = holdsList.filter((hold) =>
      !(hold.itemId === itemId && hold.memberId === memberId)
    );
    if (filtered.length === holdsList.length) return;

    context.holds.set(sanitizeHoldList(catalogList, filtered));

    recordChange(context, {
      type: "cancel",
      itemId,
      memberId,
      note: `${memberId} canceled hold on ${item.title}`,
    });

    context.cancelHoldItemIdField.set("");
    context.cancelHoldMemberIdField.set("");
  },
);

export const libraryCheckoutSystem = recipe<LibraryCheckoutArgs>(
  "Library Checkout System",
  ({ catalog, loans, holds }) => {
    const eventSequence = cell(1);
    const lastChange = cell<CirculationChange | null>(null);
    const loanState = cell<LoanRecord[]>(cloneLoans(defaultLoans));
    const holdState = cell<HoldRecord[]>(cloneHolds(defaultHolds));

    const catalogView = lift(sanitizeCatalogList)(catalog);

    const _loanSeed = lift((input: {
      catalog: LibraryItem[];
      loans: LoanRecord[];
    }) => {
      const sanitized = sanitizeLoanList(input.catalog, input.loans);
      loanState.set(sanitized);
      return sanitized;
    })({
      catalog: catalogView,
      loans,
    });

    const _holdSeed = lift((input: {
      catalog: LibraryItem[];
      holds: HoldRecord[];
    }) => {
      const sanitized = sanitizeHoldList(input.catalog, input.holds);
      holdState.set(sanitized);
      return sanitized;
    })({
      catalog: catalogView,
      holds,
    });

    const loanEntries = lift(cloneLoans)(loanState);
    const holdEntries = lift(cloneHolds)(holdState);

    const availabilityRaw = lift(
      (
        input: {
          catalog: LibraryItem[];
          loans: LoanRecord[];
          holds: HoldRecord[];
        },
      ) => computeAvailability(input.catalog, input.loans, input.holds),
    )({
      catalog: catalogView,
      loans: loanState,
      holds: holdState,
    });
    const availability = lift((entries: ItemAvailability[]) =>
      entries.map((entry) => ({ ...entry }))
    )(availabilityRaw);
    const availabilitySignals = lift((entries: ItemAvailability[]) =>
      entries.map((entry) =>
        `${entry.id}|${entry.status}|${entry.availableCopies}|${entry.holdsQueued}`
      )
    )(availability);

    const availableTitleCount = lift((entries: ItemAvailability[]) =>
      entries.filter((entry) => entry.availableCopies > 0).length
    )(availability);
    const totalTitles = lift((entries: ItemAvailability[]) => entries.length)(
      availability,
    );
    const activeLoanCount = lift((entries: LoanRecord[]) => entries.length)(
      loanEntries,
    );
    const pendingHoldCount = lift((entries: HoldRecord[]) => entries.length)(
      holdEntries,
    );

    const loanSummary = lift((count: number) =>
      formatCount(count, "active loan", "active loans")
    )(activeLoanCount);
    const holdSummary = lift((count: number) =>
      formatCount(count, "hold queued", "holds queued")
    )(pendingHoldCount);

    const availabilitySummary =
      str`${availableTitleCount}/${totalTitles} titles open · ${loanSummary} · ${holdSummary}`;

    const lastChangeLabel = lift((change: CirculationChange | null) => {
      if (!change) return "No circulation changes yet";
      return `${change.note} (#${change.sequence})`;
    })(lastChange);

    const context = {
      catalog,
      loans: loanState,
      holds: holdState,
      eventSequence,
      lastChange,
    };

    // UI-specific cells
    const itemIdField = cell("");
    const memberIdField = cell("");
    const returnItemIdField = cell("");
    const returnMemberIdField = cell("");
    const holdItemIdField = cell("");
    const holdMemberIdField = cell("");
    const cancelHoldItemIdField = cell("");
    const cancelHoldMemberIdField = cell("");

    const name = str`Library: ${availabilitySummary}`;

    const catalogCards = lift((items: ItemAvailability[]) => {
      const elements = [];
      for (const item of items) {
        let statusColor = "#10b981";
        if (item.status === "limited") statusColor = "#f59e0b";
        else if (item.status === "on-hold") statusColor = "#ef4444";
        else if (item.status === "unavailable") statusColor = "#6b7280";

        const cardStyle = "background: #ffffff; border: 2px solid " +
          statusColor +
          "; border-radius: 8px; padding: 16px; margin-bottom: 12px;";

        const titleStyle =
          "font-size: 18px; font-weight: 600; color: #1f2937; margin-bottom: 8px;";
        const idStyle =
          "font-family: monospace; font-size: 13px; color: #6b7280; margin-bottom: 12px;";
        const statusBadgeStyle = "display: inline-block; background: " +
          statusColor +
          "; color: white; padding: 4px 12px; border-radius: 12px; font-size: 12px; font-weight: 600; text-transform: uppercase; margin-bottom: 12px;";
        const statusLabelStyle =
          "font-size: 14px; color: #4b5563; margin-bottom: 12px;";

        const statsContainerStyle =
          "display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 12px;";
        const statStyle =
          "text-align: center; padding: 8px; background: #f9fafb; border-radius: 6px;";
        const statLabelStyle =
          "font-size: 11px; color: #6b7280; text-transform: uppercase; margin-bottom: 4px;";
        const statValueStyle =
          "font-size: 20px; font-weight: 700; color: #1f2937;";

        const memberListStyle = "font-size: 13px; color: #4b5563;";

        const statsContainer = h(
          "div",
          { style: statsContainerStyle },
          h(
            "div",
            { style: statStyle },
            h("div", { style: statLabelStyle }, "Total"),
            h("div", { style: statValueStyle }, String(item.totalCopies)),
          ),
          h(
            "div",
            { style: statStyle },
            h("div", { style: statLabelStyle }, "On Loan"),
            h("div", { style: statValueStyle }, String(item.activeLoans)),
          ),
          h(
            "div",
            { style: statStyle },
            h("div", { style: statLabelStyle }, "Available"),
            h("div", { style: statValueStyle }, String(item.availableCopies)),
          ),
        );

        const children = [
          h("div", { style: titleStyle }, item.title),
          h("div", { style: idStyle }, item.id),
          h("div", { style: statusBadgeStyle }, item.status),
          h("div", { style: statusLabelStyle }, item.statusLabel),
          statsContainer,
        ];

        if (item.loanMembers.length > 0) {
          children.push(
            h(
              "div",
              { style: memberListStyle },
              "Borrowed by: " + item.loanMembers.join(", "),
            ),
          );
        }

        if (item.holdMembers.length > 0) {
          children.push(
            h(
              "div",
              { style: memberListStyle },
              "Holds: " + item.holdMembers.join(", "),
            ),
          );
        }

        elements.push(h("div", { style: cardStyle }, ...children));
      }
      return h("div", {}, ...elements);
    })(availability);

    const ui = (
      <div style="font-family: system-ui, sans-serif; max-width: 900px; margin: 0 auto; padding: 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh;">
        <div style="background: white; border-radius: 12px; padding: 24px; box-shadow: 0 8px 24px rgba(0,0,0,0.15); margin-bottom: 24px;">
          <div style="font-size: 28px; font-weight: 700; color: #1f2937; margin-bottom: 8px;">
            📚 Library Circulation
          </div>
          <div style="font-size: 16px; color: #6b7280; margin-bottom: 16px;">
            {availabilitySummary}
          </div>
          <div style="background: #f3f4f6; border-left: 4px solid #667eea; padding: 12px; border-radius: 6px; font-size: 14px; color: #4b5563;">
            {lastChangeLabel}
          </div>
        </div>

        <div style="background: white; border-radius: 12px; padding: 24px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); margin-bottom: 24px;">
          <div style="font-size: 20px; font-weight: 600; color: #1f2937; margin-bottom: 16px;">
            📖 Catalog
          </div>
          {catalogCards}
        </div>

        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin-bottom: 24px;">
          <div style="background: white; border-radius: 12px; padding: 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
            <div style="font-size: 18px; font-weight: 600; color: #1f2937; margin-bottom: 16px;">
              ✅ Check Out
            </div>
            <div style="margin-bottom: 12px;">
              <label style="display: block; font-size: 13px; font-weight: 500; color: #4b5563; margin-bottom: 6px;">
                Item ID
              </label>
              <ct-input
                $value={itemIdField}
                placeholder="atlas-of-dawn"
                style="width: 100%;"
              >
              </ct-input>
            </div>
            <div style="margin-bottom: 16px;">
              <label style="display: block; font-size: 13px; font-weight: 500; color: #4b5563; margin-bottom: 6px;">
                Member ID
              </label>
              <ct-input
                $value={memberIdField}
                placeholder="member-alex"
                style="width: 100%;"
              >
              </ct-input>
            </div>
            <ct-button
              onClick={uiCheckoutItem({
                catalog,
                loans: loanState,
                holds: holdState,
                eventSequence,
                lastChange,
                itemIdField,
                memberIdField,
              })}
              style="width: 100%; background: #10b981; color: white;"
            >
              Check Out Item
            </ct-button>
          </div>

          <div style="background: white; border-radius: 12px; padding: 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
            <div style="font-size: 18px; font-weight: 600; color: #1f2937; margin-bottom: 16px;">
              ↩️ Return
            </div>
            <div style="margin-bottom: 12px;">
              <label style="display: block; font-size: 13px; font-weight: 500; color: #4b5563; margin-bottom: 6px;">
                Item ID
              </label>
              <ct-input
                $value={returnItemIdField}
                placeholder="atlas-of-dawn"
                style="width: 100%;"
              >
              </ct-input>
            </div>
            <div style="margin-bottom: 16px;">
              <label style="display: block; font-size: 13px; font-weight: 500; color: #4b5563; margin-bottom: 6px;">
                Member ID (optional)
              </label>
              <ct-input
                $value={returnMemberIdField}
                placeholder="member-alba"
                style="width: 100%;"
              >
              </ct-input>
            </div>
            <ct-button
              onClick={uiReturnItem({
                catalog,
                loans: loanState,
                holds: holdState,
                eventSequence,
                lastChange,
                returnItemIdField,
                returnMemberIdField,
              })}
              style="width: 100%; background: #3b82f6; color: white;"
            >
              Return Item
            </ct-button>
          </div>
        </div>

        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px;">
          <div style="background: white; border-radius: 12px; padding: 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
            <div style="font-size: 18px; font-weight: 600; color: #1f2937; margin-bottom: 16px;">
              🔖 Place Hold
            </div>
            <div style="margin-bottom: 12px;">
              <label style="display: block; font-size: 13px; font-weight: 500; color: #4b5563; margin-bottom: 6px;">
                Item ID
              </label>
              <ct-input
                $value={holdItemIdField}
                placeholder="modular-thoughts"
                style="width: 100%;"
              >
              </ct-input>
            </div>
            <div style="margin-bottom: 16px;">
              <label style="display: block; font-size: 13px; font-weight: 500; color: #4b5563; margin-bottom: 6px;">
                Member ID
              </label>
              <ct-input
                $value={holdMemberIdField}
                placeholder="member-sam"
                style="width: 100%;"
              >
              </ct-input>
            </div>
            <ct-button
              onClick={uiPlaceHold({
                catalog,
                holds: holdState,
                eventSequence,
                lastChange,
                holdItemIdField,
                holdMemberIdField,
              })}
              style="width: 100%; background: #f59e0b; color: white;"
            >
              Place Hold
            </ct-button>
          </div>

          <div style="background: white; border-radius: 12px; padding: 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
            <div style="font-size: 18px; font-weight: 600; color: #1f2937; margin-bottom: 16px;">
              ❌ Cancel Hold
            </div>
            <div style="margin-bottom: 12px;">
              <label style="display: block; font-size: 13px; font-weight: 500; color: #4b5563; margin-bottom: 6px;">
                Item ID
              </label>
              <ct-input
                $value={cancelHoldItemIdField}
                placeholder="modular-thoughts"
                style="width: 100%;"
              >
              </ct-input>
            </div>
            <div style="margin-bottom: 16px;">
              <label style="display: block; font-size: 13px; font-weight: 500; color: #4b5563; margin-bottom: 6px;">
                Member ID
              </label>
              <ct-input
                $value={cancelHoldMemberIdField}
                placeholder="member-jade"
                style="width: 100%;"
              >
              </ct-input>
            </div>
            <ct-button
              onClick={uiCancelHold({
                catalog,
                holds: holdState,
                eventSequence,
                lastChange,
                cancelHoldItemIdField,
                cancelHoldMemberIdField,
              })}
              style="width: 100%; background: #ef4444; color: white;"
            >
              Cancel Hold
            </ct-button>
          </div>
        </div>
      </div>
    );

    return {
      [NAME]: name,
      [UI]: ui,
      catalog,
      loans: loanState,
      holds: holdState,
      catalogView,
      loanEntries,
      holdEntries,
      availability,
      availableTitleCount,
      activeLoanCount,
      pendingHoldCount,
      availabilitySummary,
      availabilitySignals,
      lastChange,
      lastChangeLabel,
      checkout: checkoutItem(context),
      returnLoan: returnItem(context),
      placeHold: placeHold(context),
      cancelHold: cancelHold(context),
    };
  },
);

export type {
  CirculationChange,
  HoldRecord,
  ItemAvailability,
  LibraryItem,
  LoanRecord,
};

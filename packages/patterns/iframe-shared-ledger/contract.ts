export interface IframeInputData {
  title: string;
  categories: string[];
}

export interface IframeStateData {
  categoryFilter: string | null;
}

export interface IframeOutputData {
  selectedEntryId: number | null;
  lastInsertedMemo: string;
}

export const DEFAULT_INPUT: IframeInputData = {
  title: "Shared field ledger",
  categories: ["Travel", "Materials", "Food", "Other"],
};

export const DEFAULT_STATE: IframeStateData = {
  categoryFilter: null,
};

export const DEFAULT_OUTPUT: IframeOutputData = {
  selectedEntryId: null,
  lastInsertedMemo: "",
};

export const IFRAME_PATTERN = {
  name: "IframeSharedLedger",
  displayName: "Iframe · Shared SQLite ledger",
  stateScope: "user",
  outputScope: "session",
  frameHeight: "760px",
  databases: {
    ledgerDatabase: {
      scope: "space",
      tables: {
        entries: {
          id: "integer primary key",
          memo: "text not null",
          amount: "real not null",
          category: "text not null",
        },
      },
    },
  },
} as const;

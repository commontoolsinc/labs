export interface KanbanColumn {
  id: string;
  label: string;
}

export interface KanbanCard {
  id: string;
  title: string;
  column: string;
}

export interface IframeInputData {
  boardName: string;
  columns: KanbanColumn[];
}

export interface IframeStateData {
  cards: KanbanCard[];
}

export interface IframeOutputData {
  selectedCardId: string | null;
}

export const DEFAULT_INPUT: IframeInputData = {
  boardName: "Shared launch board",
  columns: [
    { id: "todo", label: "To do" },
    { id: "doing", label: "Doing" },
    { id: "done", label: "Done" },
  ],
};

export const DEFAULT_STATE: IframeStateData = { cards: [] };

export const DEFAULT_OUTPUT: IframeOutputData = { selectedCardId: null };

export const IFRAME_PATTERN = {
  name: "IframeSharedKanban",
  displayName: "Iframe · Shared kanban",
  stateScope: "space",
  outputScope: "user",
  frameHeight: "760px",
  databases: {},
} as const;

import { NAME, UI } from "@commontools/runner/shared";
import { $conn, type RuntimeClient } from "./runtime-client.ts";
import { PageRef, RequestType } from "./protocol/mod.ts";
import { InitializedRuntimeConnection } from "./client/connection.ts";
import { VNode } from "./vnode-types.ts";
import { CellHandle } from "./cell-handle.ts";

export type PageType = {
  [NAME]?: CellHandle<string> | string;
  [UI]?: CellHandle<VNode> | VNode;
};

export class PageHandle<T = PageType> {
  private _conn: InitializedRuntimeConnection;
  private _cell: CellHandle<T>;

  constructor(
    rt: RuntimeClient,
    ref: PageRef,
  ) {
    this._conn = rt[$conn]();
    this._cell = new CellHandle<T>(rt, ref.cell);
  }

  cell(): CellHandle<T> {
    return this._cell;
  }

  id(): string {
    return this._cell.id();
  }

  name(): string | undefined {
    const data = this._cell.get() as Record<string, unknown> | undefined;
    if (data && typeof data === "object" && NAME in data) {
      return data[NAME] as string;
    }
  }

  async start(): Promise<boolean> {
    const res = await this._conn.request<RequestType.PageStart>({
      type: RequestType.PageStart,
      pageId: this.id(),
    });
    return res.value;
  }

  async stop(): Promise<boolean> {
    const res = await this._conn.request<RequestType.PageStop>({
      type: RequestType.PageStop,
      pageId: this.id(),
    });
    return res.value;
  }
}

export function isPageHandle<T = unknown>(
  value: unknown,
): value is PageHandle<T> {
  return value instanceof PageHandle;
}

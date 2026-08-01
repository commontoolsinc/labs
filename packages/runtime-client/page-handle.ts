import { NAME, UI } from "@commonfabric/runner/shared";
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

  /**
   * The piece-root ROUTING/DISPLAY form of the id: consumers feed shell
   * URLs, `cf-piece` lookups, menu entries, and equality against
   * URL-derived bare pieceIds, so `of:` is stripped to match that bare
   * convention. Piece roots are minted unkinded, so only `of:` ids arrive
   * here; a `computed:` scheme (which would indicate a bug upstream) stays
   * visible rather than being laundered into the bare-id world. For
   * identity, use `cell().id()` — the full schemed URI.
   */
  id(): string {
    return this._cell.id().replace(/^of:/, "");
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
      // The page's cell knows its space — start/stop route to that
      // space's piece context.
      space: this._cell.space(),
    });
    return res.value;
  }

  async stop(): Promise<boolean> {
    const res = await this._conn.request<RequestType.PageStop>({
      type: RequestType.PageStop,
      pageId: this.id(),
      space: this._cell.space(),
    });
    return res.value;
  }
}

export function isPageHandle<T = unknown>(
  value: unknown,
): value is PageHandle<T> {
  return value instanceof PageHandle;
}

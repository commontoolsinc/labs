import type {
  JSONSchema,
  JSONValue,
  NormalizedFullLink,
} from "@commontools/runner/shared";
import type { DID, KeyPairRaw } from "@commontools/identity";
import { type Program } from "@commontools/js-compiler/interface";
export type { JSONSchema, JSONValue, Program };

export type MessageId = number;

export type CellRef = NormalizedFullLink;

export type PageRef = {
  cell: CellRef;
  result?: CellRef;
  recipeId?: string;
};

export enum RequestType {
  // Lifecycle
  Initialize = "initialize",
  Dispose = "dispose",

  // Cell operations (main -> worker)
  CellGet = "cell:get",
  CellSet = "cell:set",
  CellSend = "cell:send",
  CellSubscribe = "cell:subscribe",
  CellUnsubscribe = "cell:unsubscribe",

  // Runtime operations
  GetCell = "runtime:getCell",
  Idle = "runtime:idle",

  // Page operations (main -> worker)
  GetSpaceRootPattern = "pattern:getSpaceRoot",
  PageCreate = "page:create",
  PageGet = "page:get",
  PageRemove = "page:remove",
  PageStart = "page:start",
  PageStop = "page:stop",
  PageGetAll = "page:getAll",
  PageSynced = "page:synced",
}

export enum NotificationType {
  CellUpdate = "cell:update",
  ConsoleMessage = "callback:console",
  NavigateRequest = "callback:navigate",
  ErrorReport = "callback:error",
}

export interface IPCClientMessage {
  msgId: MessageId;
  data: IPCClientRequest;
}

export type IPCRemoteResponse = {
  msgId: MessageId;
  data?: RemoteResponse;
} | {
  msgId: MessageId;
  error: string;
};

export type IPCRemoteMessage = IPCRemoteNotification | IPCRemoteResponse;

export interface BaseRequest {
  type: RequestType;
}

export interface InitializationData {
  // URL of backend server.
  apiUrl: string;
  // Signer.
  identity: KeyPairRaw;
  // Identity of space.
  spaceDid: DID;
  // Temporary space name
  spaceName?: string;
  // Temporary identity of space.
  spaceIdentity?: KeyPairRaw;
  // Default timeout in milliseconds.
  timeoutMs?: number;
}

export interface InitializeRequest extends BaseRequest {
  type: RequestType.Initialize;
  data: InitializationData;
}

export interface DisposeRequest extends BaseRequest {
  type: RequestType.Dispose;
}

export interface CellGetRequest extends BaseRequest {
  type: RequestType.CellGet;
  cell: CellRef;
}

export interface CellSetRequest extends BaseRequest {
  type: RequestType.CellSet;
  cell: CellRef;
  value: JSONValue;
}

export interface CellSendRequest extends BaseRequest {
  type: RequestType.CellSend;
  cell: CellRef;
  event: JSONValue;
}

export interface CellSubscribeRequest extends BaseRequest {
  type: RequestType.CellSubscribe;
  cell: CellRef;
}

export interface CellUnsubscribeRequest extends BaseRequest {
  type: RequestType.CellUnsubscribe;
  cell: CellRef;
}

// unused?
export interface GetCellRequest extends BaseRequest {
  type: RequestType.GetCell;
  space: DID;
  cause: JSONValue;
  schema?: JSONSchema;
}

export interface IdleRequest extends BaseRequest {
  type: RequestType.Idle;
}

export interface PageCreateRequest extends BaseRequest {
  type: RequestType.PageCreate;
  source: {
    url: string;
  } | {
    program: Program;
  };
  argument?: JSONValue;
  cause?: string;
  run?: boolean;
}

export interface PageGetSpaceDefault extends BaseRequest {
  type: RequestType.GetSpaceRootPattern;
}

export interface PageGetRequest extends BaseRequest {
  type: RequestType.PageGet;
  pageId: string;
  runIt?: boolean;
}

export interface PageRemoveRequest extends BaseRequest {
  type: RequestType.PageRemove;
  pageId: string;
}

export interface PageStartRequest extends BaseRequest {
  type: RequestType.PageStart;
  pageId: string;
}

export interface PageStopRequest extends BaseRequest {
  type: RequestType.PageStop;
  pageId: string;
}

export interface PageGetAllRequest extends BaseRequest {
  type: RequestType.PageGetAll;
}

export interface PageSyncedRequest extends BaseRequest {
  type: RequestType.PageSynced;
}

export type IPCClientRequest =
  | InitializeRequest
  | DisposeRequest
  | CellGetRequest
  | CellSetRequest
  | CellSendRequest
  | CellSubscribeRequest
  | CellUnsubscribeRequest
  | GetCellRequest
  | IdleRequest
  | PageCreateRequest
  | PageGetSpaceDefault
  | PageGetRequest
  | PageRemoveRequest
  | PageStartRequest
  | PageStopRequest
  | PageGetAllRequest
  | PageSyncedRequest;

export type NullResponse = null;

export type EmptyResponse = undefined;

export interface BooleanResponse {
  value: boolean;
}

export interface JSONValueResponse {
  value: JSONValue | undefined;
}

export interface CellResponse {
  cell: CellRef;
}

export interface PageResponse {
  page: PageRef;
}

export interface CellUpdateNotification {
  type: NotificationType.CellUpdate;
  cell: CellRef;
  value: JSONValue;
}

export interface ConsoleNotification {
  type: NotificationType.ConsoleMessage;
  metadata?: { charmId?: string; recipeId?: string; space?: string };
  method: string;
  args: JSONValue[];
}

export interface NavigateRequestNotification {
  type: NotificationType.NavigateRequest;
  targetCellRef: CellRef;
}

export interface ErrorNotification {
  type: NotificationType.ErrorReport;
  message: string;
  charmId?: string;
  space?: string;
  recipeId?: string;
  spellId?: string;
}

export type RemoteResponse =
  | EmptyResponse
  | NullResponse
  | BooleanResponse
  | JSONValueResponse
  | CellResponse
  | PageResponse;

export type IPCRemoteNotification =
  | CellUpdateNotification
  | ConsoleNotification
  | NavigateRequestNotification
  | ErrorNotification;

export type Commands = {
  // Runtime requests
  [RequestType.Initialize]: {
    request: InitializeRequest;
    response: EmptyResponse;
  };
  [RequestType.Dispose]: {
    request: DisposeRequest;
    response: EmptyResponse;
  };
  [RequestType.GetCell]: {
    request: GetCellRequest;
    response: CellResponse;
  };
  [RequestType.Idle]: {
    request: IdleRequest;
    response: EmptyResponse;
  };
  // Cell requests
  [RequestType.CellGet]: {
    request: CellGetRequest;
    response: JSONValueResponse;
  };
  [RequestType.CellSet]: {
    request: CellSetRequest;
    response: EmptyResponse;
  };
  [RequestType.CellSend]: {
    request: CellSendRequest;
    response: EmptyResponse;
  };
  [RequestType.CellSubscribe]: {
    request: CellSubscribeRequest;
    response: BooleanResponse;
  };
  [RequestType.CellUnsubscribe]: {
    request: CellUnsubscribeRequest;
    response: BooleanResponse;
  };
  // Page requests
  [RequestType.PageCreate]: {
    request: PageCreateRequest;
    response: PageResponse;
  };
  [RequestType.PageSynced]: {
    request: PageSyncedRequest;
    response: EmptyResponse;
  };
  [RequestType.PageGet]: {
    request: PageGetRequest;
    response: PageResponse | NullResponse;
  };
  [RequestType.PageRemove]: {
    request: PageRemoveRequest;
    response: BooleanResponse;
  };
  [RequestType.PageStart]: {
    request: PageStartRequest;
    response: BooleanResponse;
  };
  [RequestType.PageStop]: {
    request: PageStopRequest;
    response: BooleanResponse;
  };
  [RequestType.PageGetAll]: {
    request: PageGetAllRequest;
    response: CellResponse;
  };
  [RequestType.GetSpaceRootPattern]: {
    request: PageGetSpaceDefault;
    response: PageResponse;
  };
};

export type CommandRequest<T> = T extends keyof Commands
  ? Commands[T]["request"]
  : never;
export type CommandResponse<T> = T extends keyof Commands
  ? Commands[T]["response"]
  : never;

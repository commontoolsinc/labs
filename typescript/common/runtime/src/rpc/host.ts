// import { Value } from '@commontools/data/interfaces/common-data-types.js';

import { ElementUnion, EventMap } from '../helpers.js';
import { Value } from '../index.js';
import { RPCEventHandler } from './index.js';

/**
 * Messages sent to the host runtime from a worker
 */

export const HOST_WORKER_EVENTS = ['rpc:handshake:confirmed'] as const;

export type HostWorkerEvents = ElementUnion<typeof HOST_WORKER_EVENTS>;

export type HostWorkerRequests = EventMap<HostWorkerEvents> & {
  'rpc:handshake:confirmed': void;
};

export type HostWorkerResponses = EventMap<HostWorkerEvents> & {
  'rpc:handshake:confirmed': void;
};

export type HostWorkerEventHandler = RPCEventHandler<
  HostWorkerEvents,
  HostWorkerRequests,
  HostWorkerResponses
>;

/**
 * Messages sent to the host runtime from a module-within-a-worker
 */

export const HOST_MODULE_EVENTS = ['host:storage:read'] as const;

export type HostModuleEvents = ElementUnion<typeof HOST_MODULE_EVENTS>;

export type HostModuleRequests = EventMap<HostModuleEvents> & {
  'host:storage:read': {
    key: string;
  };
};

export type HostModuleResponses = EventMap<HostModuleEvents> & {
  'host:storage:read':
    | {
        error: string;
      }
    | {
        value: Value;
      };
};

export type HostModuleEventHandler = RPCEventHandler<
  HostModuleEvents,
  HostModuleRequests,
  HostModuleResponses
>;

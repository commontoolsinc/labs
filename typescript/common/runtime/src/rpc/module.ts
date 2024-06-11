import { Value } from '@commontools/data/interfaces/common-data-types.js';
import { ElementUnion, EventMap } from '../helpers.js';
import { RPCEventHandler } from './index.js';

/**
 * Messages sent to a module-within-a-worker from the host runtime
 */

export const MODULE_EVENTS = ['module:run', 'module:output:read'] as const;
export type ModuleEvents = ElementUnion<typeof MODULE_EVENTS>;

export type ModuleRequests = EventMap<ModuleEvents> & {
  'module:run': void;
  'module:output:read': {
    key: string;
  };
};

export type ModuleResponses = EventMap<ModuleEvents> & {
  'module:run':
    | {}
    | {
        error: string;
      };
  'module:output:read': {
    value: Value | undefined;
  };
};

export type ModuleEventHandler = RPCEventHandler<
  ModuleEvents,
  ModuleRequests,
  ModuleResponses
>;

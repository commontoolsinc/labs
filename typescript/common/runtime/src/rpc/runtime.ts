import { ContentType } from '../index.js';
import { ElementUnion, EventMap } from '../helpers.js';
import { RPCEventHandler } from './index.js';

/**
 * Events sent to a runtime-within-a-worker from the host runtime
 */

export const RUNTIME_EVENTS = ['runtime:eval'] as const;

export type RuntimeEvents = ElementUnion<typeof RUNTIME_EVENTS>;

export type RuntimeRequests = EventMap<RuntimeEvents> & {
  'runtime:eval': {
    id: string;
    contentType: ContentType;
    sourceCode: string;
    inputKeys: string[];
    port: MessagePort;
  };
};

export type RuntimeResponses = EventMap<RuntimeEvents> & {
  'runtime:eval':
    | {}
    | {
        error: string;
      };
};

export type RuntimeEventHandler = RPCEventHandler<
  RuntimeEvents,
  RuntimeRequests,
  RuntimeResponses
>;

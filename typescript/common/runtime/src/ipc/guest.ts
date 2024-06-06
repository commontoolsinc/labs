import { Value } from '@commontools/data/interfaces/common-data-types.js';
import { ContentType } from '../index.js';

export type GuestEvents = {
  'module:eval': {
    contentType: ContentType;
    sourceCode: string;
    state: Map<string, Value>;
  };
  'module:run': {
    id: string;
  };
  'output:read': {
    id: string;
    key: string;
  };
};

export type GuestResponses = {
  'module:eval': {
    error?: string;
    id?: string;
  };
  'module:run': {
    error?: string;
  };
  'output:read': {
    value: Value | undefined;
  };
};

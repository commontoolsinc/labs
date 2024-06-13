import { view } from '../hyperscript/render.js';

export const div = view('div', {
  type: 'object',
  properties: {
    id: { type: 'string' },
  }
});
import { view } from '../hyperscript/view.js';

export const div = view('div', {
  type: 'object',
  properties: {
    id: { type: 'string' },
  }
});
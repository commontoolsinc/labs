import { view } from '../hyperscript/view.js';
import { register as registerView } from '../hyperscript/known-tags.js';

export const div = view('div', {
  type: 'object',
  properties: {
    id: { type: 'string' },
  }
});

registerView(div);
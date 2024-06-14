import { dict } from './hyperscript/tags.js';
import render from './hyperscript/render.js';

const tree = dict({
  records: {
    'one': '1',
    'two': '2',
    'three': '3'
  }
});

const element = render(tree, {
  
});

document.body.appendChild(element);
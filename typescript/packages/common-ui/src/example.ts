import { div, navpanel } from './hyperscript/tags.js';
import render from './hyperscript/render.js';

const panel = render(
  navpanel(
    {
      content: div({id: 'hello'}, 'Hello, world!')
    }
  )
);

document.body.appendChild(panel);
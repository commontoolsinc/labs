import { assert, equal, throws } from './assert.js';
import { state } from '@commontools/common-frp/signal';
import { tags, signal, render } from '../lib/hyperscript.js';

const { hstack } = tags;

describe('vnode factory functions', () => {
  it('creates a vnode', () => {
    const vnode = hstack(
      {'className': 'foo'},
      'Hello'
    );
  
    equal(vnode.tag, 'com-hstack');
    equal(vnode.props.className, 'foo');
    equal(vnode.children[0], 'Hello');
  });
});

describe("it does not create tags that aren't whitelisted", () => {
  throws(() => {
    tags.div(
      {'className': 'foo'},
      'Hello'
    );
  });
});

describe("it binds signals", () => {
  const className = state('foo');

  const vnode = hstack(
    {'className': signal('string', 'className')},
    'Hello'
  );

  const element = render(vnode, {className});

  equal(element.tagName, 'COM-HSTACK');
  assert(element.classList.contains('foo'));
  equal(element.textContent, 'Hello');
});
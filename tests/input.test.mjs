import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindInput } from '../docs/input.mjs';

// Minimal DOM stand-ins: EventTarget plus the `contains` lookup the stage uses.
class FakeElement extends EventTarget {
  constructor(children = []) { super(); this.children = children; }
  contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
}

// Node has no KeyboardEvent/PointerEvent, so copy the fields the handlers read onto a cancelable Event.
function fire(target, type, fields = {}) {
  const event = new Event(type, { cancelable: true });
  for (const [name, value] of Object.entries(fields)) Object.defineProperty(event, name, { value });
  target.dispatchEvent(event);
  return event;
}
const keydown = (win, code, fields) => fire(win, 'keydown', { code, key: code === 'Space' ? ' ' : code, repeat: false, ...fields });
const keyup = (win, code, fields) => fire(win, 'keyup', { code, key: code === 'Space' ? ' ' : code, ...fields });

function setup() {
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { hidden: false, activeElement: null });
  const startLabel = new FakeElement();
  const startButton = new FakeElement([startLabel]);
  const restartButton = new FakeElement();
  const canvas = new FakeElement();
  const panel = new FakeElement([startButton, restartButton]);
  const stage = new FakeElement([canvas, panel]);
  const calls = [];
  const unbind = bindInput({
    win, doc, stage,
    onFlap: () => calls.push('flap'),
    buttons: [[startButton, () => calls.push('start')], [restartButton, () => calls.push('restart')]],
  });
  return { win, doc, stage, canvas, panel, startButton, startLabel, restartButton, calls, unbind };
}

for (const code of ['Space', 'ArrowUp']) {
  test(`${code}: one flap per physical press, repeats stay default-prevented`, () => {
    const { win, calls } = setup();
    const first = keydown(win, code);
    assert.deepEqual(calls, ['flap']);
    assert.equal(first.defaultPrevented, true, 'blocks page scroll and button activation');

    for (let i = 0; i < 5; i++) assert.equal(keydown(win, code, { repeat: true }).defaultPrevented, true);
    assert.equal(keydown(win, code).defaultPrevented, true, 'a held key without the repeat flag is still prevented');
    assert.deepEqual(calls, ['flap'], 'held key never flaps again');

    assert.equal(keyup(win, code).defaultPrevented, true, 'keyup cannot activate a focused button');
    keydown(win, code);
    assert.deepEqual(calls, ['flap', 'flap'], 'a new press after keyup flaps');
  });
}

test('Space and ArrowUp are separate physical keys', () => {
  const { win, calls } = setup();
  keydown(win, 'Space');
  keydown(win, 'ArrowUp');
  keydown(win, 'Space', { repeat: true });
  assert.deepEqual(calls, ['flap', 'flap']);
});

test('window blur releases held keys so the next press flaps', () => {
  const { win, calls } = setup();
  keydown(win, 'Space');
  win.dispatchEvent(new Event('blur'));
  keydown(win, 'Space', { repeat: true });
  assert.deepEqual(calls, ['flap'], 'OS auto-repeat of a key still held after refocus is ignored');
  keydown(win, 'Space');
  assert.deepEqual(calls, ['flap', 'flap']);
});

test('hiding the tab releases held keys', () => {
  const { win, doc, calls } = setup();
  keydown(win, 'ArrowUp');
  doc.hidden = true;
  doc.dispatchEvent(new Event('visibilitychange'));
  doc.hidden = false;
  doc.dispatchEvent(new Event('visibilitychange'));
  keydown(win, 'ArrowUp');
  assert.deepEqual(calls, ['flap', 'flap']);
});

test('browser shortcuts with Ctrl, Alt or Meta are left alone', () => {
  const { win, calls } = setup();
  for (const modifier of ['ctrlKey', 'altKey', 'metaKey']) {
    assert.equal(keydown(win, 'Space', { [modifier]: true }).defaultPrevented, false);
  }
  assert.deepEqual(calls, []);
  keydown(win, 'Space');
  assert.deepEqual(calls, ['flap'], 'an ignored shortcut does not mark the key as held');
});

test('Space on a focused start button runs one action and no button click', () => {
  const { win, doc, startButton, calls } = setup();
  doc.activeElement = startButton;
  const down = keydown(win, 'Space');
  const up = keyup(win, 'Space');
  assert.deepEqual(calls, ['flap']);
  assert.equal(down.defaultPrevented && up.defaultPrevented, true, 'native Space activation (click on keyup) is cancelled');
});

test('Enter on a focused button keeps the native click and blocks its auto-repeat', () => {
  const { win, doc, startButton, restartButton, calls } = setup();
  doc.activeElement = startButton;
  const first = fire(win, 'keydown', { code: 'Enter', key: 'Enter', repeat: false });
  assert.equal(first.defaultPrevented, false, 'the browser turns this Enter into a click');
  fire(startButton, 'click', { detail: 0 });
  assert.deepEqual(calls, ['start']);

  for (let i = 0; i < 3; i++) {
    assert.equal(fire(win, 'keydown', { code: 'Enter', key: 'Enter', repeat: true }).defaultPrevented, true);
  }
  doc.activeElement = restartButton;
  assert.equal(fire(win, 'keydown', { code: 'NumpadEnter', key: 'Enter', repeat: true }).defaultPrevented, true);
  doc.activeElement = null;
  assert.equal(fire(win, 'keydown', { code: 'Enter', key: 'Enter', repeat: true }).defaultPrevented, false, 'Enter elsewhere is untouched');
  assert.deepEqual(calls, ['start']);
});

test('pointer: a primary press on the stage flaps; buttons act only through click', () => {
  const { stage, canvas, panel, startButton, startLabel, restartButton, calls } = setup();
  fire(stage, 'pointerdown', { button: 0, target: canvas });
  fire(stage, 'pointerdown', { button: 0, target: panel });
  assert.deepEqual(calls, ['flap', 'flap'], 'canvas and panel background both count as a tap');

  fire(stage, 'pointerdown', { button: 2, target: canvas });
  fire(stage, 'pointerdown', { button: 1, target: canvas });
  assert.deepEqual(calls, ['flap', 'flap'], 'right and middle buttons are ignored');

  fire(stage, 'pointerdown', { button: 0, target: startLabel });
  fire(startButton, 'click', { detail: 1 });
  fire(stage, 'pointerdown', { button: 0, target: restartButton });
  fire(restartButton, 'click', { detail: 1 });
  assert.deepEqual(calls, ['flap', 'flap', 'start', 'restart'], 'pressing a button does not also flap');
});

test('a key held through a crash does not restart; a new press does', () => {
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { hidden: false, activeElement: null });
  // Mirrors the flap() boundary in main.js: ready -> start, running -> flap, over -> new flight.
  const game = { state: 'ready', log: [] };
  const onFlap = () => {
    if (game.state === 'ready') { game.state = 'running'; game.log.push('start'); }
    else if (game.state === 'over') { game.state = 'running'; game.log.push('retry'); }
    else game.log.push('flap');
  };
  bindInput({ win, doc, stage: new FakeElement(), onFlap });

  keydown(win, 'Space');
  keyup(win, 'Space');
  keydown(win, 'Space');
  game.state = 'over'; // crash while Space is still down
  for (let i = 0; i < 10; i++) keydown(win, 'Space', { repeat: true });
  assert.equal(game.state, 'over');
  keyup(win, 'Space');
  assert.equal(game.state, 'over', 'releasing the key does not restart');
  keydown(win, 'Space');
  assert.deepEqual(game.log, ['start', 'flap', 'retry']);
});

test('unbind removes every listener', () => {
  const { win, doc, stage, canvas, startButton, calls, unbind } = setup();
  unbind();
  assert.equal(keydown(win, 'Space').defaultPrevented, false);
  fire(stage, 'pointerdown', { button: 0, target: canvas });
  fire(startButton, 'click', { detail: 1 });
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.deepEqual(calls, []);
});

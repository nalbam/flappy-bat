import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindInput } from '../docs/input.mjs';
import { CAVE_FLOOR, FLAP_VELOCITY } from '../docs/game-rules.mjs';
import { createFrameClock, createGame, resumeRun, startRun, togglePause } from '../docs/game-core.mjs';

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

for (const code of ['KeyP', 'Escape']) {
  test(`${code}: one pause action per physical press, repeats and held keys ignored`, () => {
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { hidden: false, activeElement: null });
    const calls = [];
    bindInput({ win, doc, stage: new FakeElement(), onFlap: () => calls.push('flap'), onPause: () => calls.push('pause') });
    assert.equal(keydown(win, code, { key: code === 'KeyP' ? 'p' : 'Escape' }).defaultPrevented, true);
    for (let i = 0; i < 5; i++) keydown(win, code, { repeat: true });
    keydown(win, code); // a second keydown without keyup
    assert.deepEqual(calls, ['pause']);
    keyup(win, code);
    keydown(win, code);
    assert.deepEqual(calls, ['pause', 'pause'], 'a new press after keyup pauses again');
    keyup(win, code);
    for (const modifier of ['ctrlKey', 'altKey', 'metaKey']) {
      assert.equal(keydown(win, code, { [modifier]: true }).defaultPrevented, false, `${modifier} shortcut left alone`);
    }
    assert.deepEqual(calls, ['pause', 'pause']);
  });
}

test('a hidden tab calls onHidden once per hide; becoming visible calls nothing', () => {
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { hidden: false, activeElement: null });
  const calls = [];
  bindInput({ win, doc, stage: new FakeElement(), onFlap: () => calls.push('flap'), onHidden: () => calls.push('hidden') });
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.deepEqual(calls, []);
  doc.hidden = true;
  doc.dispatchEvent(new Event('visibilitychange'));
  doc.hidden = false;
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.deepEqual(calls, ['hidden']);
});

// The real model, frame clock and input binding, wired as main.js wires them: a flap key starts in 'ready'
// and flaps otherwise (the model refuses it while paused), a pause key toggles, a hidden tab pauses and
// the `계속` button resumes.
function pausableGame() {
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { hidden: false, activeElement: null });
  const canvas = new FakeElement();
  const continueButton = new FakeElement();
  const stage = new FakeElement([canvas, continueButton]);
  const game = createGame({ seed: 12345 });
  const clock = createFrameClock();
  const log = [];
  let now = 1000;
  bindInput({
    win, doc, stage,
    onFlap: () => log.push(game.state === 'ready' ? startRun(game, clock) && 'start' : game.flap() && 'flap'),
    onPause: () => log.push(togglePause(game, clock) && game.state),
    onHidden: () => log.push(game.pause() && 'paused'),
    buttons: [[continueButton, () => log.push(resumeRun(game, clock) && 'resumed')]],
  });
  const frame = (ms = 1000 / 60) => game.advance(clock.frame((now += ms)));
  const model = () => JSON.stringify({
    state: game.state, tick: game.tick, bat: game.bat, score: game.score, runTime: game.runTime,
    distance: game.distance, seed: game.seed, obstacles: game.obstacles,
  });
  return { win, doc, stage, canvas, continueButton, game, log, frame, model };
}

test('real game: flap keys, taps and Space on the focused continue button neither flap nor resume while paused', () => {
  const { win, doc, stage, canvas, continueButton, game, log, frame, model } = pausableGame();
  keydown(win, 'Space'); keyup(win, 'Space');
  frame(0);
  for (let i = 0; i < 20; i++) frame();
  keydown(win, 'KeyP');
  assert.equal(game.state, 'paused');
  const paused = model();

  for (let i = 0; i < 3; i++) {
    keydown(win, 'Space'); keyup(win, 'Space');
    keydown(win, 'ArrowUp'); keyup(win, 'ArrowUp');
    fire(stage, 'pointerdown', { button: 0, target: canvas });
    keydown(win, 'KeyP', { repeat: true });
    keydown(win, 'KeyP');
    frame(); frame(5000);
  }
  doc.activeElement = continueButton;
  const down = keydown(win, 'Space');
  const up = keyup(win, 'Space');
  assert.equal(down.defaultPrevented && up.defaultPrevented, true, 'Space cannot click the focused continue button');
  assert.equal(game.state, 'paused');
  assert.equal(model(), paused, 'nothing in the model moved while paused');
  // Each Space, ArrowUp and tap reached the model and was refused (false); the held KeyP never toggled.
  assert.deepEqual(log, ['start', 'paused', ...Array(10).fill(false)]);

  keyup(win, 'KeyP');
  keydown(win, 'Escape');
  assert.equal(game.state, 'running');
  assert.equal(frame(3000), 0, 'the first frame after the resume is 0 s');
  assert.equal(model(), paused.replace('"state":"paused"', '"state":"running"'), 'resume adds no flap and no reset');
  assert.ok(frame() > 0, 'the flight goes on');
  assert.ok(game.bat.velocity < FLAP_VELOCITY);
});

test('real game: the continue button resumes once by click, tap or Enter', () => {
  const { win, doc, stage, continueButton, game, log, frame, model } = pausableGame();
  keydown(win, 'Space'); keyup(win, 'Space');
  frame(0); frame();
  for (const way of ['click', 'tap', 'Enter']) {
    keydown(win, 'Escape'); keyup(win, 'Escape');
    assert.equal(game.state, 'paused', way);
    const paused = model();
    if (way === 'tap') fire(stage, 'pointerdown', { button: 0, target: continueButton });
    if (way === 'Enter') {
      doc.activeElement = continueButton;
      assert.equal(fire(win, 'keydown', { code: 'Enter', key: 'Enter', repeat: false }).defaultPrevented, false, 'Enter becomes a native click');
      for (let i = 0; i < 3; i++) fire(win, 'keydown', { code: 'Enter', key: 'Enter', repeat: true });
    }
    fire(continueButton, 'click', { detail: way === 'Enter' ? 0 : 1 });
    assert.equal(game.state, 'running', way);
    assert.equal(frame(), 0, `${way}: first frame after the resume`);
    assert.equal(model(), paused.replace('"state":"paused"', '"state":"running"'), `${way}: no flap`);
    frame();
  }
  assert.deepEqual(log, ['start', 'paused', 'resumed', 'paused', 'resumed', 'paused', 'resumed']);
});

test('real game: hiding the tab pauses a run, showing it does not resume, ready and over ignore both', () => {
  const { win, doc, game, log, frame, model } = pausableGame();
  const hide = () => { doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange')); };
  const show = () => { doc.hidden = false; doc.dispatchEvent(new Event('visibilitychange')); };

  const ready = model();
  hide(); show(); keydown(win, 'KeyP'); keyup(win, 'KeyP'); keydown(win, 'Escape'); keyup(win, 'Escape');
  frame(); frame();
  assert.equal(model(), ready, 'ready: hidden, visible and pause keys change nothing');

  keydown(win, 'Space'); keyup(win, 'Space');
  frame(0); frame();
  hide();
  assert.equal(game.state, 'paused');
  const paused = model();
  show();
  for (let i = 0; i < 5; i++) frame();
  assert.equal(model(), paused, 'becoming visible does not resume');
  keydown(win, 'KeyP'); keyup(win, 'KeyP');
  assert.equal(game.state, 'running');

  assert.equal(frame(), 0, 'first frame after the resume');
  game.bat.y = CAVE_FLOOR - 1;
  frame();
  assert.equal(game.state, 'over');
  const over = model();
  hide(); show(); keydown(win, 'Escape'); keyup(win, 'Escape');
  frame();
  assert.equal(model(), over, 'over: hidden, visible and pause keys change nothing');
  assert.deepEqual(log, [false, false, false, 'start', 'paused', 'running', false, false]);
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

test('KeyM: one onMute per physical press; repeats, held keys and shortcuts ignored; blur releases', () => {
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { hidden: false, activeElement: null });
  const calls = [];
  bindInput({ win, doc, stage: new FakeElement(), onFlap: () => calls.push('flap'), onPause: () => calls.push('pause'), onMute: () => calls.push('mute') });
  assert.equal(keydown(win, 'KeyM').defaultPrevented, true);
  for (let i = 0; i < 4; i++) keydown(win, 'KeyM', { repeat: true });
  keydown(win, 'KeyM');
  assert.deepEqual(calls, ['mute'], 'auto-repeat and a held key toggle once');
  keyup(win, 'KeyM');
  keydown(win, 'KeyM');
  assert.deepEqual(calls, ['mute', 'mute'], 'a new press toggles again');
  win.dispatchEvent(new Event('blur'));
  keydown(win, 'KeyM');
  assert.deepEqual(calls, ['mute', 'mute', 'mute'], 'blur forgets the held key');
  doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange')); doc.hidden = false;
  keydown(win, 'KeyM');
  assert.equal(calls.length, 4, 'a hidden tab forgets the held key');
  for (const modifier of ['ctrlKey', 'altKey', 'metaKey']) {
    keyup(win, 'KeyM');
    assert.equal(keydown(win, 'KeyM', { [modifier]: true }).defaultPrevented, false, modifier);
  }
  assert.equal(calls.length, 4, 'browser shortcuts never toggle');
  keydown(win, 'Space'); keydown(win, 'KeyP');
  assert.deepEqual(calls.slice(4), ['flap', 'pause'], 'mute keeps the flap and pause keys');
});

test('unbind also removes the mute key', () => {
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { hidden: false, activeElement: null });
  const calls = [];
  const unbind = bindInput({ win, doc, stage: new FakeElement(), onFlap: () => {}, onMute: () => calls.push('mute') });
  unbind();
  assert.equal(keydown(win, 'KeyM').defaultPrevented, false);
  assert.deepEqual(calls, []);
});

test('callers without onMute keep working: KeyM is a no-op', () => {
  const { win, calls } = setup();
  assert.doesNotThrow(() => keydown(win, 'KeyM'));
  assert.deepEqual(calls, []);
});

test('real game: KeyM toggles once per press in ready, running, paused and over without touching the model', () => {
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { hidden: false, activeElement: null });
  const game = createGame({ seed: 12345 });
  const clock = createFrameClock();
  let muted = false;
  const toggles = [];
  bindInput({
    win, doc, stage: new FakeElement(),
    onFlap: () => (game.state === 'ready' ? startRun(game, clock) : game.flap()),
    onPause: () => togglePause(game, clock),
    onMute: () => { muted = !muted; toggles.push([game.state, muted]); },
  });
  const model = () => JSON.stringify({ state: game.state, tick: game.tick, bat: game.bat, score: game.score, obstacles: game.obstacles });
  const pressM = () => {
    const before = model();
    keydown(win, 'KeyM'); keydown(win, 'KeyM', { repeat: true }); keyup(win, 'KeyM');
    assert.equal(model(), before, `M changes nothing in ${game.state}`);
  };
  pressM();
  keydown(win, 'Space'); keyup(win, 'Space');
  game.advance(1 / 60);
  pressM();
  keydown(win, 'KeyP'); keyup(win, 'KeyP');
  pressM();
  keydown(win, 'KeyP'); keyup(win, 'KeyP');
  game.bat.y = CAVE_FLOOR - 1;
  game.advance(1 / 60);
  pressM();
  assert.deepEqual(toggles, [['ready', true], ['running', false], ['paused', true], ['over', false]]);
});

// A result card seed link: `closest('a[href]')` finds the link from the link itself or a node inside it.
class FakeLink extends FakeElement {
  closest(selector) { return selector === 'a[href]' ? this : null; }
}
class FakeLinkText extends FakeElement {
  constructor(link) { super(); this.link = link; }
  closest(selector) { return selector === 'a[href]' ? this.link : null; }
}

test('pointer: a press on a stage link only follows the link, also in the over state', () => {
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { hidden: false, activeElement: null });
  const link = new FakeLink();
  const linkText = new FakeLinkText(link);
  link.children.push(linkText);
  const plain = new FakeElement();
  plain.closest = () => null; // a panel node that is not inside a link
  const restartButton = new FakeElement();
  const canvas = new FakeElement();
  const stage = new FakeElement([canvas, new FakeElement([plain, link, restartButton])]);
  const game = createGame({ seed: 7 });
  const clock = createFrameClock();
  const crash = () => { startRun(game, clock); while (game.state === 'running') game.advance(0.1); };
  crash(); // the result card with its seed links is shown only after a crash
  assert.equal(game.state, 'over');
  const calls = [];
  bindInput({
    win, doc, stage,
    onFlap: () => { calls.push('flap'); if (game.state === 'over') { game.reset(); startRun(game, clock); } }, // main.js: setReady() then start()
    buttons: [[restartButton, () => calls.push('restart')]],
  });

  const press = fire(stage, 'pointerdown', { button: 0, target: link });
  fire(stage, 'pointerdown', { button: 0, target: linkText });
  assert.deepEqual(calls, [], 'a press on a link or inside it does not flap');
  assert.equal(game.state, 'over', 'the link press does not restart the flight');
  assert.equal(press.defaultPrevented, false, 'the browser still follows the link');

  doc.activeElement = link;
  assert.equal(keydown(win, 'Space').defaultPrevented, true, 'Space on a focused link is a flap key, not a link activation');
  assert.equal(fire(win, 'keydown', { code: 'Enter', key: 'Enter', repeat: false }).defaultPrevented, false, 'Enter on a focused link opens it');
  assert.deepEqual(calls, ['flap'], 'Space restarts as before');
  assert.equal(game.state, 'running');

  game.reset();
  crash();
  fire(stage, 'pointerdown', { button: 0, target: plain });
  fire(stage, 'pointerdown', { button: 0, target: canvas });
  assert.deepEqual(calls, ['flap', 'flap', 'flap'], 'other stage presses still flap and restart');
});

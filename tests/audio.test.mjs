import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EFFECTS, MUTE_STORAGE_KEY, createSound } from '../docs/audio.mjs';
import { FakeAudioContext, contextFactory, memoryStorage } from './fake-audio.mjs';

const settle = () => new Promise((resolve) => setImmediate(resolve));

function running(options = {}) {
  const factory = contextFactory();
  const storage = options.storage ?? memoryStorage();
  const sound = createSound({ createContext: factory.create, getStorage: () => storage });
  return { sound, factory, storage, context: () => factory.made[0] };
}

test('no AudioContext exists before the first user input unlocks the sound', () => {
  const { sound, factory } = running();
  assert.equal(sound.status, 'on');
  assert.equal(sound.play('flap'), false, 'an effect before any input is dropped');
  sound.silence();
  assert.equal(factory.made.length, 0, 'loading, playing and silencing never create a context');
  sound.unlock();
  sound.unlock();
  assert.equal(factory.made.length, 1, 'the first input creates one context, later inputs reuse it');
  assert.equal(factory.made[0].resumeCalls, 0, 'a running context is not resumed again');
});

test('flap, score and crash are distinct short effects that reach the speakers and clean up', () => {
  const { sound, context } = running();
  sound.unlock();
  const signature = {};
  for (const name of ['flap', 'score', 'crash']) {
    const before = context().oscillators.length;
    assert.equal(sound.play(name), true, name);
    const made = context().oscillators.slice(before);
    assert.equal(made.length, EFFECTS[name].length, `${name}: one oscillator per tone`);
    for (const o of made) {
      assert.ok(o.reaches(context().destination), `${name}: wired to the destination`);
      const gain = [...o.outputs][0].gain.events;
      assert.equal(gain[0][0], 'set', `${name}: envelope starts quiet`);
      assert.ok(gain[0][1] < 0.001);
      assert.equal(gain.at(-1)[0], 'exponential', `${name}: envelope decays`);
      assert.ok(gain.at(-1)[1] < 0.001);
      assert.ok(o.endAt > o.startAt && o.endAt - o.startAt < 0.6, `${name}: short, with a scheduled stop`);
    }
    signature[name] = made.map((o) => `${o.type}:${o.frequency.events[0][1]}`).join('+');
  }
  assert.equal(new Set(Object.values(signature)).size, 3, `three different sounds: ${JSON.stringify(signature)}`);
  assert.equal(sound.activeVoices, 5);
  context().endAll();
  assert.equal(sound.activeVoices, 0, 'ended oscillators are released');
  assert.equal(context().wired().length, 0, 'ended oscillators are disconnected');
});

test('silence() stops sounding and scheduled effects; nothing replays afterwards', () => {
  const { sound, context } = running();
  sound.unlock();
  sound.play('crash');
  sound.play('score', 0.14); // a chime scheduled for later in the frame
  assert.equal(context().audibleAt(0.01).length, 2);
  sound.silence();
  assert.equal(sound.activeVoices, 0);
  assert.equal(context().wired().length, 0, 'every sounding and scheduled oscillator left the speakers');
  for (const o of context().oscillators) assert.ok(o.endAt <= context().currentTime, 'stopped now');
  const made = context().oscillators.length;
  context().currentTime = 1;
  assert.equal(context().audibleAt(1.1).length, 0, 'no old sound later');
  assert.equal(sound.play('flap'), true, 'a new effect after silence sounds');
  assert.equal(context().oscillators.length, made + 1);
  assert.equal(context().audibleAt(1.01).length, 1);
});

test('mute silences at once, drops later effects, persists, and unmuting replays nothing', () => {
  const { sound, context, storage } = running();
  sound.unlock();
  sound.play('crash');
  assert.equal(sound.toggleMute(), true);
  assert.equal(sound.status, 'off');
  assert.equal(storage.getItem(MUTE_STORAGE_KEY), '1');
  assert.equal(context().wired().length, 0, 'the crash stops when muted');
  const made = context().oscillators.length;
  assert.equal(sound.play('flap'), false);
  assert.equal(sound.play('score'), false);
  assert.equal(context().oscillators.length, made, 'muted effects are discarded, not queued');
  assert.equal(sound.toggleMute(), false);
  assert.equal(storage.getItem(MUTE_STORAGE_KEY), '0');
  assert.equal(context().oscillators.length, made, 'unmuting plays none of the muted effects');
  assert.equal(sound.play('flap'), true);
});

test('the saved mute setting is restored and a muted page creates no context until unmuted', () => {
  const storage = memoryStorage({ [MUTE_STORAGE_KEY]: '1' });
  const factory = contextFactory();
  const sound = createSound({ createContext: factory.create, getStorage: () => storage });
  assert.equal(sound.muted, true);
  sound.unlock();
  assert.equal(factory.made.length, 0, 'muted input does not start audio');
  sound.toggleMute(); // the M key is a user input
  assert.equal(factory.made.length, 1, 'unmuting starts the context');
  assert.equal(sound.play('score'), true);

  const fresh = createSound({ createContext: factory.create, getStorage: () => memoryStorage() });
  assert.equal(fresh.muted, false, 'without a saved setting the sound is on');
  const other = createSound({ createContext: factory.create, getStorage: () => memoryStorage({ [MUTE_STORAGE_KEY]: 'yes' }) });
  assert.equal(other.muted, false, 'an unknown saved value means sound on');
});

test('an effect asked for while resume is pending sounds once when the resume finishes', async () => {
  let clockMs = 0;
  const factory = contextFactory({ state: 'suspended' });
  const sound = createSound({ createContext: factory.create, getStorage: () => memoryStorage(), now: () => clockMs });
  sound.unlock();
  sound.unlock(); // a second input before the first resume finishes
  const context = factory.made[0];
  assert.equal(context.resumeCalls, 2, 'a suspended context is resumed from each input');
  assert.equal(sound.play('flap'), true, 'the effect waits for the resume');
  assert.equal(context.oscillators.length, 0, 'nothing sounds while suspended');
  assert.equal(sound.waitingEffects, 1);
  clockMs = 50;
  context.finishResume();
  await settle();
  assert.equal(context.oscillators.length, 1, 'the waiting flap sounds exactly once, for both resumes');
  assert.equal(context.audibleAt(0.01).length, 1);
  assert.equal(sound.waitingEffects, 0);
  assert.equal(sound.play('crash'), true, 'after the resume new effects sound at once');
  assert.equal(context.oscillators.length, 3);
});

test('mute, silence or a failed resume drop waiting effects; a slow resume still plays each once', async () => {
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    for (const [label, cancel] of [
      ['silence (pause or hidden tab)', (sound) => sound.silence()],
      ['mute', (sound) => sound.toggleMute()],
      ['mute and unmute', (sound) => { sound.toggleMute(); sound.toggleMute(); }],
    ]) {
      const factory = contextFactory({ state: 'suspended' });
      const sound = createSound({ createContext: factory.create, getStorage: () => memoryStorage(), now: () => 0 });
      sound.unlock();
      sound.play('flap');
      sound.play('score', 0.07);
      cancel(sound);
      assert.equal(sound.waitingEffects, 0, label);
      for (const context of factory.made) context.finishResume();
      await settle();
      const context = factory.made[0];
      assert.equal(context.oscillators.length, 0, `${label}: the late resume plays nothing cancelled`);
      assert.equal(sound.play('crash'), !sound.muted, `${label}: new effects follow the mute setting`);
    }

    const failing = contextFactory({ state: 'suspended' });
    const refused = createSound({ createContext: failing.create, getStorage: () => memoryStorage(), now: () => 0 });
    refused.unlock();
    refused.play('flap');
    failing.made[0].failResume();
    await settle();
    assert.equal(refused.waitingEffects, 0, 'a refused resume drops the waiting flap');
    assert.equal(refused.play('flap'), false, 'suspended with no resume under way: silent');
    refused.unlock();
    failing.made[0].finishResume();
    await settle();
    assert.equal(failing.made[0].oscillators.length, 0, 'the next resume does not replay the old flap');

    let clockMs = 0;
    const slow = contextFactory({ state: 'suspended' });
    const late = createSound({ createContext: slow.create, getStorage: () => memoryStorage(), now: () => clockMs });
    late.unlock();
    late.play('flap');
    late.play('score', 0.07);
    clockMs = 2000; // a slow but normal resume
    slow.made[0].finishResume();
    await settle();
    assert.equal(slow.made[0].oscillators.length, 3, 'a slow normal resume still plays the flap and the score once each');
    assert.equal(late.waitingEffects, 0);
    slow.made[0].finishResume();
    await settle();
    assert.equal(slow.made[0].oscillators.length, 3, 'nothing replays on a second resume completion');
  } finally {
    process.off('unhandledRejection', onRejection);
  }
  assert.deepEqual(rejections, []);
});

test('no Web Audio, a failing constructor or a closed context leave the game silent without errors', () => {
  for (const [label, createContext] of [
    ['no API', () => null],
    ['constructor throws', () => { throw new Error('NotSupportedError'); }],
    ['closed', () => new FakeAudioContext({ state: 'closed' })],
  ]) {
    const sound = createSound({ createContext, getStorage: () => memoryStorage() });
    assert.doesNotThrow(() => sound.unlock(), label);
    assert.equal(sound.status, 'unavailable', label);
    assert.equal(sound.play('flap'), false, label);
    assert.doesNotThrow(() => { sound.silence(); sound.toggleMute(); sound.toggleMute(); sound.unlock(); }, label);
    assert.equal(sound.status, 'unavailable', `${label}: unmuting keeps the state readable`);
  }
  const sound = createSound({ getStorage: () => memoryStorage() }); // Node has no AudioContext
  sound.unlock();
  assert.equal(sound.status, 'unavailable', 'the default factory reports missing support');
});

test('a rejected or throwing resume is contained; the next input tries again', async () => {
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    const factory = contextFactory({ state: 'suspended' });
    const sound = createSound({ createContext: factory.create, getStorage: () => memoryStorage() });
    sound.unlock();
    factory.made[0].failResume();
    await settle();
    assert.equal(sound.status, 'on', 'a refused resume is not a missing API');
    assert.equal(sound.play('flap'), false, 'still suspended, no resume under way: silent');
    sound.unlock();
    assert.equal(factory.made[0].resumeCalls, 2, 'the next input resumes again');
    factory.made[0].finishResume();
    await settle();
    assert.equal(sound.play('flap'), true);

    const throwing = new FakeAudioContext({ state: 'suspended' });
    throwing.resume = () => { throw new Error('InvalidStateError'); };
    const other = createSound({ createContext: () => throwing, getStorage: () => memoryStorage() });
    assert.doesNotThrow(() => other.unlock());
    await settle();
  } finally {
    process.off('unhandledRejection', onRejection);
  }
  assert.deepEqual(rejections, [], 'no unhandled Promise rejection');
});

test('blocked storage keeps the mute setting in memory', () => {
  const blocked = () => { throw new Error('SecurityError'); };
  const throwingItems = { getItem: blocked, setItem: blocked };
  for (const [label, getStorage] of [['storage getter throws', blocked], ['items throw', () => throwingItems], ['no storage', () => null]]) {
    const factory = contextFactory();
    let sound;
    assert.doesNotThrow(() => { sound = createSound({ createContext: factory.create, getStorage }); }, label);
    assert.equal(sound.muted, false, `${label}: default sound on`);
    assert.equal(sound.toggleMute(), true, label);
    assert.equal(sound.status, 'off', label);
    assert.equal(sound.toggleMute(), false, label);
    assert.equal(sound.status, 'on', label);
    assert.equal(sound.play('flap'), true, `${label}: sound still works`);
  }
});

test('an unknown effect name is a programming error', () => {
  const { sound } = running();
  sound.unlock();
  assert.throws(() => sound.play('boom'), /Unknown sound effect/);
});

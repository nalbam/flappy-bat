/* Test stand-ins for Web Audio and storage. They record what the sound code asks for. */

class FakeParam {
  constructor() { this.events = []; }
  setValueAtTime(value, time) { this.events.push(['set', value, time]); }
  linearRampToValueAtTime(value, time) { this.events.push(['linear', value, time]); }
  exponentialRampToValueAtTime(value, time) { this.events.push(['exponential', value, time]); }
}

class FakeNode {
  constructor(context) { this.context = context; this.outputs = new Set(); }
  connect(node) { this.outputs.add(node); return node; }
  disconnect() { this.outputs.clear(); }
  reaches(node) { return this === node || [...this.outputs].some((out) => out.reaches(node)); }
}

class FakeGain extends FakeNode {
  constructor(context) { super(context); this.gain = new FakeParam(); }
}

class FakeOscillator extends FakeNode {
  constructor(context) {
    super(context);
    this.type = 'sine';
    this.frequency = new FakeParam();
    this.startAt = null;
    this.stops = [];
    this.onended = null;
  }
  start(time = 0) {
    if (this.startAt !== null) throw new Error('InvalidStateError: started twice');
    this.startAt = time;
    this.context.oscillators.push(this);
  }
  stop(time) {
    if (this.startAt === null) throw new Error('InvalidStateError: stop before start');
    this.stops.push(time ?? this.context.currentTime);
  }
  /** The time the oscillator goes quiet: the earliest stop. */
  get endAt() { return Math.min(...this.stops); }
}

/**
 * A minimal AudioContext. `state` starts as given; resume() returns a Promise that the test
 * settles with `finishResume()` or `failResume()`, so a late resume can be ordered against input.
 */
export class FakeAudioContext {
  constructor({ state = 'running' } = {}) {
    this.state = state;
    this.currentTime = 0;
    this.destination = new FakeNode(this);
    this.oscillators = [];
    this.resumeCalls = 0;
    this.pending = [];
  }
  createGain() { return new FakeGain(this); }
  createOscillator() { return new FakeOscillator(this); }
  resume() {
    this.resumeCalls += 1;
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }
  finishResume() { this.state = 'running'; for (const p of this.pending.splice(0)) p.resolve(); }
  failResume() { for (const p of this.pending.splice(0)) p.reject(new Error('NotAllowedError')); }
  /** Oscillators still wired to the speakers and not stopped before `time`. */
  audibleAt(time) {
    return this.oscillators.filter((o) => o.reaches(this.destination) && o.startAt <= time && o.endAt > time);
  }
  /** Oscillators still wired to the speakers whose stop lies at or after their scheduled end. */
  wired() { return this.oscillators.filter((o) => o.reaches(this.destination)); }
  /** Ends every oscillator as the audio thread would, calling onended. */
  endAll() { for (const o of this.oscillators) o.onended?.(); }
}

/** Counts createContext() calls and returns the contexts it made. */
export function contextFactory(options) {
  const made = [];
  const create = () => { const c = new FakeAudioContext(options); made.push(c); return c; };
  return { create, made };
}

/** A Map-backed Storage. */
export function memoryStorage(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    map,
  };
}

/** Records the effects asked for, as audio-events.mjs calls them. */
export function soundLog() {
  const played = [];
  return { played, play: (name, delay = 0) => { played.push(delay ? [name, delay] : name); return true; } };
}

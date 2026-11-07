/* Flappy Bat sound: procedural Web Audio effects and the saved mute setting. No audio files. */

/** localStorage key of the mute setting ('1' muted, '0' sound on), separate from the best score. */
export const MUTE_STORAGE_KEY = 'flappyBatMuted';

/**
 * Tone recipes of each effect. Each tone is one oscillator with a short gain envelope:
 * `start` and `duration` in seconds after the effect starts, `from`/`to` the pitch sweep in Hz.
 * - flap: a short soft triangle swoop down, the sound of one wing beat.
 * - score: a bright two-note rising sine chime.
 * - crash: a long low sawtooth and square rumble that falls in pitch.
 */
export const EFFECTS = Object.freeze({
  flap: [{ type: 'triangle', from: 540, to: 230, start: 0, duration: 0.09, peak: 0.2 }],
  score: [
    { type: 'sine', from: 880, to: 880, start: 0, duration: 0.11, peak: 0.18 },
    { type: 'sine', from: 1320, to: 1320, start: 0.07, duration: 0.16, peak: 0.16 },
  ],
  crash: [
    { type: 'sawtooth', from: 170, to: 38, start: 0, duration: 0.5, peak: 0.26 },
    { type: 'square', from: 90, to: 30, start: 0, duration: 0.32, peak: 0.1 },
  ],
});

/**
 * Longest wait, in milliseconds, for an effect asked for while `resume()` is pending. When the
 * resume finishes later than this after the effect, the effect is stale and is dropped.
 */
export const MAX_PENDING_MS = 300;

const ATTACK = 0.008; // seconds from silence to the peak
const SILENT = 0.0001; // exponential ramps cannot reach 0

function defaultCreateContext() {
  const AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  return AudioContextClass ? new AudioContextClass() : null;
}

// Reading `localStorage` itself throws when the browser blocks storage.
function defaultGetStorage() {
  return globalThis.localStorage ?? null;
}

function defaultNow() {
  return globalThis.performance?.now() ?? Date.now();
}

/**
 * Creates the game's sound output.
 *
 * - No AudioContext exists until `unlock()`, which the caller runs from a real user input
 *   (key, pointer or button). `unlock()` creates the context or resumes a suspended one.
 *   It never waits: the game goes on while `resume()` is pending.
 * - `play()` starts an effect at once while the context is 'running' and sound is not muted.
 *   While a `resume()` started by `unlock()` is pending, the effect waits and sounds once when
 *   the resume finishes, so the start flap of the first input is heard. A waiting effect is
 *   dropped when `silence()` or muting runs before the resume finishes, when the resume fails,
 *   and when it finishes more than MAX_PENDING_MS after the effect. A late resume therefore
 *   never plays an old or cancelled sound.
 * - `silence()` stops every sounding, scheduled and waiting effect at once. Call it on pause
 *   and when the tab is hidden. Muting also silences. Nothing replays later.
 * - No Web Audio support, a constructor that throws and a rejected `resume()` only make the
 *   game silent: `status` becomes 'unavailable' after a failed creation and no error escapes.
 * - The mute setting is read once and written on every change. When storage is blocked the
 *   setting lives in memory only.
 *
 * @param {object} [options]
 * @param {() => AudioContext | null} [options.createContext] Returns a new context, or null without support.
 * @param {() => Storage | null} [options.getStorage] Returns the storage for the mute setting.
 * @param {() => number} [options.now] Wall clock in milliseconds, for the age of waiting effects.
 */
export function createSound({ createContext = defaultCreateContext, getStorage = defaultGetStorage, now = defaultNow } = {}) {
  let muted = readMuted();
  let context = null;
  let unavailable = false;
  let bus = null; // gain node shared by the current effects; silence() drops it
  const voices = new Set();
  let waiting = []; // effects asked for while resume() is pending: { name, delay, at }
  let resumes = 0; // resume() calls not yet settled

  function readMuted() {
    try {
      return getStorage()?.getItem(MUTE_STORAGE_KEY) === '1';
    } catch {
      return false; // blocked storage: start with sound on, the default
    }
  }

  function writeMuted() {
    try {
      getStorage()?.setItem(MUTE_STORAGE_KEY, muted ? '1' : '0');
    } catch {
      // Blocked or full storage: the setting stays in memory for this page.
    }
  }

  function unlock() {
    if (muted || unavailable) return;
    if (!context) {
      try {
        context = createContext();
      } catch {
        context = null;
      }
      if (!context) {
        unavailable = true;
        return;
      }
    }
    if (context.state === 'closed') {
      unavailable = true;
      return;
    }
    if (context.state !== 'running') {
      resumes += 1;
      try {
        Promise.resolve(context.resume()).then(onResumed, onResumeFailed);
      } catch {
        onResumeFailed(); // resume() threw synchronously; a later input tries again.
      }
    }
  }

  // Several inputs may each start a resume(); the first one to finish plays the waiting effects
  // and the others find nothing left.
  function onResumed() {
    resumes -= 1;
    const ready = waiting;
    waiting = [];
    if (muted || !context || context.state !== 'running') return;
    const time = now();
    for (const effect of ready) {
      const age = time - effect.at;
      if (age <= MAX_PENDING_MS) start(effect.name, effect.delay - age / 1000);
    }
  }

  function onResumeFailed() {
    resumes -= 1;
    waiting = [];
  }

  function silence() {
    waiting = [];
    for (const voice of voices) {
      voice.oscillator.onended = null;
      voice.oscillator.stop();
      voice.oscillator.disconnect();
      voice.gain.disconnect();
    }
    voices.clear();
    if (bus) {
      bus.disconnect();
      bus = null;
    }
  }

  function play(name, delay = 0) {
    const tones = EFFECTS[name];
    if (!tones) throw new Error(`Unknown sound effect "${name}"`);
    if (muted || !context) return false;
    if (context.state === 'running') {
      start(name, delay);
      return true;
    }
    if (resumes === 0) return false; // suspended with no resume under way: silent
    waiting.push({ name, delay, at: now() });
    return true;
  }

  function start(name, delay) {
    const tones = EFFECTS[name];
    if (!bus) {
      bus = context.createGain();
      bus.connect(context.destination);
    }
    const effectStart = context.currentTime + Math.max(0, delay);
    for (const tone of tones) {
      const toneStart = effectStart + tone.start;
      const end = toneStart + tone.duration;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = tone.type;
      oscillator.frequency.setValueAtTime(tone.from, toneStart);
      oscillator.frequency.exponentialRampToValueAtTime(tone.to, end);
      gain.gain.setValueAtTime(SILENT, toneStart);
      gain.gain.linearRampToValueAtTime(tone.peak, toneStart + ATTACK);
      gain.gain.exponentialRampToValueAtTime(SILENT, end);
      oscillator.connect(gain);
      gain.connect(bus);
      const voice = { oscillator, gain };
      voices.add(voice);
      oscillator.onended = () => {
        voices.delete(voice);
        oscillator.disconnect();
        gain.disconnect();
      };
      oscillator.start(toneStart);
      oscillator.stop(end + 0.02);
    }
  }

  function setMuted(value) {
    muted = Boolean(value);
    writeMuted();
    if (muted) silence();
    else unlock(); // unmuting is a user input, so the context may start here
    return muted;
  }

  return {
    get muted() { return muted; },
    /** 'off' when muted, 'unavailable' when the browser cannot make sound, otherwise 'on'. */
    get status() { return muted ? 'off' : unavailable ? 'unavailable' : 'on'; },
    /** Number of oscillators that are sounding or scheduled. */
    get activeVoices() { return voices.size; },
    /** Number of effects waiting for a pending resume(). */
    get waitingEffects() { return waiting.length; },
    unlock,
    play,
    silence,
    setMuted,
    toggleMute: () => setMuted(!muted),
  };
}

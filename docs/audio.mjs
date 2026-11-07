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

/**
 * Creates the game's sound output.
 *
 * - No AudioContext exists until `unlock()`, which the caller runs from a real user input
 *   (key, pointer or button). `unlock()` creates the context or resumes a suspended one.
 *   It never waits: the game goes on while `resume()` is pending.
 * - `play()` starts an effect only while the context is 'running' and sound is not muted.
 *   An effect asked for while the context is suspended (resume still pending) is dropped,
 *   so a late resume never plays old sounds.
 * - `silence()` stops every sounding and scheduled effect at once. Call it on pause and when
 *   the tab is hidden. Muting also silences. Nothing is queued, so nothing replays later.
 * - No Web Audio support, a constructor that throws and a rejected `resume()` only make the
 *   game silent: `status` becomes 'unavailable' after a failed creation and no error escapes.
 * - The mute setting is read once and written on every change. When storage is blocked the
 *   setting lives in memory only.
 *
 * @param {object} [options]
 * @param {() => AudioContext | null} [options.createContext] Returns a new context, or null without support.
 * @param {() => Storage | null} [options.getStorage] Returns the storage for the mute setting.
 */
export function createSound({ createContext = defaultCreateContext, getStorage = defaultGetStorage } = {}) {
  let muted = readMuted();
  let context = null;
  let unavailable = false;
  let bus = null; // gain node shared by the current effects; silence() drops it
  const voices = new Set();

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
      try {
        Promise.resolve(context.resume()).catch(() => {});
      } catch {
        // resume() threw synchronously; a later input tries again.
      }
    }
  }

  function silence() {
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
    if (muted || !context || context.state !== 'running') return false;
    if (!bus) {
      bus = context.createGain();
      bus.connect(context.destination);
    }
    const effectStart = context.currentTime + Math.max(0, delay);
    for (const tone of tones) {
      const start = effectStart + tone.start;
      const end = start + tone.duration;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = tone.type;
      oscillator.frequency.setValueAtTime(tone.from, start);
      oscillator.frequency.exponentialRampToValueAtTime(tone.to, end);
      gain.gain.setValueAtTime(SILENT, start);
      gain.gain.linearRampToValueAtTime(tone.peak, start + ATTACK);
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
      oscillator.start(start);
      oscillator.stop(end + 0.02);
    }
    return true;
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
    unlock,
    play,
    silence,
    setMuted,
    toggleMute: () => setMuted(!muted),
  };
}

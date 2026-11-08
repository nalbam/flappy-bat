/* Flappy Bat recent flights: the last flights' score and seed, kept apart from the best score and the mute setting. */
import { MAX_SEED } from './obstacle-generator.mjs';

/** localStorage key of the recent flights. `flappyBatBest` and `flappyBatMuted` are separate keys. */
export const HISTORY_STORAGE_KEY = 'flappyBatRecent';
/** Number of flights kept, newest first. */
export const HISTORY_LIMIT = 5;

/**
 * True for a valid flight record `{ score, seed }`: score is an integer >= 0 and seed an integer
 * from 0 to MAX_SEED. Only such records reach the result card, so a changed stored value can
 * never put text or HTML into it.
 */
export function isFlight(value) {
  return value !== null && typeof value === 'object'
    && Number.isSafeInteger(value.score) && value.score >= 0
    && Number.isInteger(value.seed) && value.seed >= 0 && value.seed <= MAX_SEED;
}

/**
 * Returns a new history with `flight` first, cut to HISTORY_LIMIT records. The input array is not
 * changed. Only the `score` and `seed` fields are kept. An invalid flight leaves the history as it is.
 *
 * @param {ReadonlyArray<{score: number, seed: number}>} history Newest first.
 * @param {{score: number, seed: number}} flight
 * @returns {Array<{score: number, seed: number}>}
 */
export function addFlight(history, flight) {
  const kept = history.slice(0, HISTORY_LIMIT);
  if (!isFlight(flight)) return kept;
  return [{ score: flight.score, seed: flight.seed }, ...kept].slice(0, HISTORY_LIMIT);
}

/**
 * Reads a stored history (a JSON array of `{ score, seed }`, newest first) and never throws.
 *
 * Recovery policy:
 * - null, broken JSON or a value that is not an array gives an empty history.
 * - Invalid records (wrong type, negative or fractional numbers, a seed out of range, strings)
 *   are dropped one by one; the valid records keep their order. Only score and seed are kept.
 * - The result has at most HISTORY_LIMIT records: the first (newest) valid ones.
 *
 * @param {string | null | undefined} raw
 * @returns {Array<{score: number, seed: number}>}
 */
export function parseHistory(raw) {
  if (typeof raw !== 'string') return [];
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.filter(isFlight).slice(0, HISTORY_LIMIT).map(({ score, seed }) => ({ score, seed }));
}

function defaultGetStorage() {
  return globalThis.localStorage ?? null;
}

/**
 * Loads the history from storage. A missing storage, a throwing `getStorage` or `getItem`, or a
 * broken value gives an empty history; no exception reaches the game.
 *
 * @param {() => Storage | null} [getStorage] Returns the storage (normally `localStorage`).
 */
export function loadHistory(getStorage = defaultGetStorage) {
  try {
    return parseHistory(getStorage()?.getItem(HISTORY_STORAGE_KEY));
  } catch {
    return []; // blocked storage: start with an empty history
  }
}

/**
 * Saves the history under HISTORY_STORAGE_KEY only. Returns false when the storage is missing or
 * throws (blocked or full); the caller keeps its in-memory history and the game goes on.
 *
 * @param {() => Storage | null} getStorage
 * @param {ReadonlyArray<{score: number, seed: number}>} history
 * @returns {boolean} True when the value was written.
 */
export function saveHistory(getStorage = defaultGetStorage, history = []) {
  try {
    const storage = getStorage();
    if (!storage) return false;
    storage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history.filter(isFlight).slice(0, HISTORY_LIMIT)));
    return true;
  } catch {
    return false;
  }
}

/**
 * Relative link that reopens the current page with `seed`: the path stays, other query
 * parameters stay, and only `seed` is set. `search` is the current `location.search`.
 *
 * @param {string} search
 * @param {number} seed A valid seed (integer 0..MAX_SEED).
 * @returns {string} For example `?seed=42` or `?debug=1&seed=42`.
 */
export function seedHref(search, seed) {
  const params = new URLSearchParams(search);
  params.set('seed', String(seed));
  return `?${params}`;
}

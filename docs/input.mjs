/* Flappy Bat input: maps keyboard, pointer and button events to game actions. */

/** Keys that flap. Matched on `event.code` so keyboard layout and IME state do not matter. */
export const FLAP_KEYS = Object.freeze(['Space', 'ArrowUp']);
/** Keys that pause and resume, matched on `event.code` like FLAP_KEYS. */
export const PAUSE_KEYS = Object.freeze(['KeyP', 'Escape']);

/**
 * Binds game input and returns a function that removes every listener.
 *
 * - A flap key calls `onFlap` once per physical press. Auto-repeat and a key that is still
 *   held are ignored, so holding a key through a crash does not start a new flight.
 * - A pause key calls `onPause` once per physical press, with the same repeat and held-key rules.
 * - Flap and pause keys always cancel the default action: no page scroll and no click on a
 *   focused button, so Space on a focused button never activates it.
 * - Ctrl, Alt or Meta with a flap or pause key is a browser shortcut and is left alone.
 * - Window blur and a hidden tab forget held keys, because their keyup may never arrive.
 *   A hidden tab also calls `onHidden`; becoming visible again calls nothing.
 * - A primary pointer press anywhere on `stage` calls `onFlap`, except on a bound button.
 *   Buttons act only through their `click` event, which also covers Enter on a focused button.
 *   Enter auto-repeat on a focused button is cancelled so holding Enter clicks once.
 *
 * @param {object} options
 * @param {EventTarget} options.win Receives keydown, keyup and blur (normally `window`).
 * @param {EventTarget & {hidden: boolean, activeElement: unknown}} options.doc Normally `document`.
 * @param {EventTarget} options.stage Element that receives taps and clicks (normally `#game`).
 * @param {Array<[EventTarget & {contains(node: unknown): boolean}, () => void]>} [options.buttons]
 *   Each button with the action its click runs.
 * @param {() => void} options.onFlap Called for a new flap key press or stage tap. The game
 *   decides what a flap means in its current state (main.js ignores it while paused).
 * @param {() => void} [options.onPause] Called for a new pause key press.
 * @param {() => void} [options.onHidden] Called when the document becomes hidden.
 * @returns {() => void} Removes the listeners.
 */
export function bindInput({ win, doc, stage, buttons = [], onFlap, onPause = () => {}, onHidden = () => {} }) {
  const held = new Set();
  const isBoundButton = (node) => buttons.some(([button]) => button === node);
  const isInsideButton = (node) => buttons.some(([button]) => button.contains(node));
  const hasShortcutModifier = (event) => event.ctrlKey || event.altKey || event.metaKey;

  const actionFor = (code) => (FLAP_KEYS.includes(code) ? onFlap : PAUSE_KEYS.includes(code) ? onPause : null);

  function onKeyDown(event) {
    const action = actionFor(event.code);
    if (action) {
      if (hasShortcutModifier(event)) return;
      event.preventDefault();
      if (event.repeat || held.has(event.code)) return;
      held.add(event.code);
      action();
    } else if (event.key === 'Enter' && event.repeat && isBoundButton(doc.activeElement)) {
      event.preventDefault();
    }
  }

  function onKeyUp(event) {
    if (!actionFor(event.code)) return;
    held.delete(event.code);
    event.preventDefault();
  }

  const releaseAll = () => held.clear();
  const onVisibilityChange = () => {
    if (!doc.hidden) return;
    releaseAll();
    onHidden();
  };

  function onPointerDown(event) {
    if (event.button !== 0 || isInsideButton(event.target)) return;
    onFlap();
  }

  const listeners = [
    [win, 'keydown', onKeyDown],
    [win, 'keyup', onKeyUp],
    [win, 'blur', releaseAll],
    [doc, 'visibilitychange', onVisibilityChange],
    [stage, 'pointerdown', onPointerDown],
    ...buttons.map(([button, action]) => [button, 'click', () => action()]),
  ];
  for (const [target, type, listener] of listeners) target.addEventListener(type, listener);
  return () => {
    for (const [target, type, listener] of listeners) target.removeEventListener(type, listener);
  };
}

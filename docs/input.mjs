/* Flappy Bat input: maps keyboard, pointer and button events to game actions. */

/** Keys that flap. Matched on `event.code` so keyboard layout and IME state do not matter. */
export const FLAP_KEYS = Object.freeze(['Space', 'ArrowUp']);

/**
 * Binds game input and returns a function that removes every listener.
 *
 * - A flap key calls `onFlap` once per physical press. Auto-repeat and a key that is still
 *   held are ignored, so holding a key through a crash does not start a new flight.
 * - Flap keys always cancel the default action: no page scroll and no click on a focused button.
 * - Window blur and a hidden tab forget held keys, because their keyup may never arrive.
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
 * @param {() => void} options.onFlap Called for a new flap key press or stage tap.
 * @returns {() => void} Removes the listeners.
 */
export function bindInput({ win, doc, stage, buttons = [], onFlap }) {
  const held = new Set();
  const isBoundButton = (node) => buttons.some(([button]) => button === node);
  const isInsideButton = (node) => buttons.some(([button]) => button.contains(node));
  const hasShortcutModifier = (event) => event.ctrlKey || event.altKey || event.metaKey;

  function onKeyDown(event) {
    if (FLAP_KEYS.includes(event.code)) {
      if (hasShortcutModifier(event)) return;
      event.preventDefault();
      if (event.repeat || held.has(event.code)) return;
      held.add(event.code);
      onFlap();
    } else if (event.key === 'Enter' && event.repeat && isBoundButton(doc.activeElement)) {
      event.preventDefault();
    }
  }

  function onKeyUp(event) {
    if (!FLAP_KEYS.includes(event.code)) return;
    held.delete(event.code);
    event.preventDefault();
  }

  const releaseAll = () => held.clear();
  const onVisibilityChange = () => { if (doc.hidden) releaseAll(); };

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

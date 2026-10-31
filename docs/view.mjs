/* Flappy Bat camera framing: a fixed side view of the play plane (z = 0). */

/**
 * World-space window, relative to the bat, that must stay visible at every screen size.
 * - `behind`/`ahead`: x distance kept on screen behind and in front of the bat.
 *   `ahead` gives about 1.3 s of look-ahead at the start speed (7.2 units/s).
 * - `bottom`/`top`: covers the flight band (-0.8 to 5.5) with margins.
 *   The top margin leaves room for the HUD above the ceiling.
 * - `batScreenX`: preferred bat position as a fraction of the screen width.
 */
export const PLAY_VIEW = Object.freeze({ behind: 3, ahead: 9.5, bottom: -2.2, top: 7.4, batScreenX: 0.25 });

/**
 * Fits PLAY_VIEW to the screen. The camera sits at (batX + x, y, distance) and looks straight
 * down -z with no tilt, so pillars stay vertical and gaps read at their true height.
 * Narrow screens move the camera back until the full width fits.
 * Wide screens keep the band height and add the extra width in front of the bat.
 *
 * @param {number} aspect Screen width / height.
 * @param {number} fovDeg Vertical field of view in degrees.
 * @param {typeof PLAY_VIEW} [view]
 * @returns {{x: number, y: number, distance: number, width: number, height: number}}
 *   Camera offset from the bat and the visible width and height at z = 0.
 */
export function frameView(aspect, fovDeg, view = PLAY_VIEW) {
  const height = Math.max(view.top - view.bottom, (view.behind + view.ahead) / aspect);
  const width = height * aspect;
  const behind = Math.min(Math.max(width * view.batScreenX, view.behind), width - view.ahead);
  return {
    x: width / 2 - behind,
    y: (view.top + view.bottom) / 2,
    distance: height / 2 / Math.tan(fovDeg * Math.PI / 360),
    width,
    height,
  };
}

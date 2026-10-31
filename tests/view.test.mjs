import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLAY_VIEW, frameView } from '../docs/view.mjs';

const FOV = 65;
const EPS = 1e-9;
const SCREENS = { desktop: [1280, 720], phone: [390, 844], ultrawide: [2560, 1080], square: [800, 800], narrow: [320, 900] };

for (const [name, [w, h]] of Object.entries(SCREENS)) {
  test(`${name} ${w}x${h}: the play window stays on screen with the bat on the left`, () => {
    const aspect = w / h;
    const view = frameView(aspect, FOV);
    const left = view.x - view.width / 2, right = view.x + view.width / 2;
    const bottom = view.y - view.height / 2, top = view.y + view.height / 2;

    assert.ok(Math.abs(view.width / view.height - aspect) < EPS, 'window matches the screen aspect');
    assert.ok(Math.abs(2 * view.distance * Math.tan(FOV * Math.PI / 360) - view.height) < EPS, 'distance shows exactly that height');
    assert.ok(left <= -PLAY_VIEW.behind + EPS, 'space behind the bat for the pillar it passes');
    assert.ok(right >= PLAY_VIEW.ahead - EPS, 'the approaching pillar is visible ahead of the bat');
    assert.ok(bottom <= PLAY_VIEW.bottom + EPS && top >= PLAY_VIEW.top - EPS, 'the whole flight band is visible');
    assert.ok(-left / view.width <= 0.3, 'bat stays in the left third so the flight reads left to right');
  });
}

test('narrow screens zoom out only as far as the required width', () => {
  const view = frameView(390 / 844, FOV);
  assert.ok(Math.abs(view.width - (PLAY_VIEW.behind + PLAY_VIEW.ahead)) < EPS);
});

test('wide screens keep the flight band height and give extra width to the look-ahead', () => {
  const desktop = frameView(1280 / 720, FOV);
  const ultrawide = frameView(2560 / 1080, FOV);
  assert.ok(Math.abs(desktop.height - (PLAY_VIEW.top - PLAY_VIEW.bottom)) < EPS);
  const ahead = (view) => view.x + view.width / 2;
  assert.ok(ahead(ultrawide) > ahead(desktop));
});

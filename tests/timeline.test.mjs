import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_SPAN, MIN_COORDINATE, MAX_COORDINATE, EMPTY_LANE_HEIGHT, MAX_EMPTY_LANE_GAP, clampRange, dateToX, xToDate,
  zoomRange, panRange, fitRange, maxSpanForCoordinates, generateTicks, layoutCards,
} from '../src/domain/timeline.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
function at(year, month = 1, day = 1, hour = 0) {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, 0, 0, 0);
  return date.getTime();
}
const range = { start: at(2026, 10, 1), end: at(2026, 11, 1) };
const card = (id, coordinate, preferredLane = 0, height = 96) => ({ id, coordinate, preferredLane, width: 300, height });

test('calendar mapping is reversible and a zero-size hidden view remains finite', () => {
  for (const coordinate of [range.start, at(2026, 10, 19, 15), range.end]) {
    assert.equal(xToDate(dateToX(coordinate, range, 1024), range, 1024), coordinate);
  }
  assert.equal(dateToX(range.start, range, 0), 0);
  assert.equal(xToDate(30, range, 0), (range.start + range.end) / 2);
  assert.deepEqual(generateTicks(range, 0), []);
});

test('zoom retains pointer date, honors one hour and upper bounds, and clamps calendar edges', () => {
  const anchor = xToDate(250, range, 1000);
  const zoomed = zoomRange(range, 2, 0.25, 90 * DAY);
  assert.equal(xToDate(250, zoomed, 1000), anchor);
  assert.equal(zoomed.end - zoomed.start, (range.end - range.start) / 2);
  const tiny = zoomRange(range, 1e20, 0.5, 90 * DAY);
  assert.equal(tiny.end - tiny.start, MIN_SPAN);
  const large = zoomRange(range, 1e-20, 0.5, 40 * DAY);
  assert.equal(large.end - large.start, 40 * DAY);
  const edge = panRange({ start: MIN_COORDINATE, end: MIN_COORDINATE + DAY }, -DAY);
  assert.deepEqual(edge, { start: MIN_COORDINATE, end: MIN_COORDINATE + DAY });
  const last = panRange({ start: MAX_COORDINATE - DAY, end: MAX_COORDINATE }, DAY);
  assert.deepEqual(last, { start: MAX_COORDINATE - DAY, end: MAX_COORDINATE });
  assert.throws(() => zoomRange(range, 0, 0.5, DAY));
  assert.throws(() => clampRange({ start: NaN, end: 0 }));
});

test('fit reserves whole edge cards and single-point range is one day', () => {
  const points = [at(2026, 1, 1), at(2026, 12, 31)];
  const fitted = fitRange(points, 1000);
  assert.ok(dateToX(points[0], fitted, 1000) >= 166 - 1e-7);
  assert.ok(dateToX(points[1], fitted, 1000) <= 834 + 1e-7);
  const single = fitRange([points[0]], 1000);
  assert.equal(single.end - single.start, DAY);
  assert.equal(dateToX(points[0], single, 1000), 500);
  assert.equal(fitRange([MIN_COORDINATE], 1000).start, MIN_COORDINATE);
  assert.equal(fitRange([MAX_COORDINATE], 1000).end, MAX_COORDINATE);
  assert.ok(Number.isFinite(fitRange(points, 0).start));
});

test('maximum zoom span includes a real calendar month and padding for a full extent', () => {
  assert.equal(maxSpanForCoordinates([], at(2024, 2, 15)), 29 * DAY);
  assert.equal(maxSpanForCoordinates([at(2026, 10, 22)]), 31 * DAY);
  const coordinates = [at(2000), at(2026)];
  assert.ok(maxSpanForCoordinates(coordinates) > coordinates[1] - coordinates[0]);
  assert.ok(maxSpanForCoordinates([MIN_COORDINATE, MAX_COORDINATE]) <= MAX_COORDINATE - MIN_COORDINATE);
});

test('narrow mobile fit keeps a short extent short and whole edge cards visible', () => {
  const coordinates = [at(2026, 10, 1), at(2026, 10, 6)];
  const width = 375;
  const cardWidth = 343;
  const fitted = fitRange(coordinates, width, cardWidth);
  const extent = coordinates[1] - coordinates[0];
  assert.ok(fitted.end - fitted.start >= extent);
  assert.ok(fitted.end - fitted.start <= 3 * extent);
  const inputs = coordinates.map((coordinate, index) => ({ ...card(String(index), coordinate), width: cardWidth }));
  const { items } = layoutCards(inputs, fitted, width);
  assert.ok(items.every(item => item.x >= 0 && item.x + item.width <= width));
  assert.equal(items.length, coordinates.length);
});

test('calendar ticks cross months, leap days and years without 1900 coercion', () => {
  const months = generateTicks({ start: at(2024, 1, 1), end: at(2024, 5, 1) }, 1000);
  assert.ok(months.some(tick => tick.label === '2024-02'));
  assert.ok(months.some(tick => tick.label === '2024-03'));
  const leap = generateTicks({ start: at(2024, 2, 27), end: at(2024, 3, 2) }, 1000);
  assert.ok(leap.some(tick => tick.label.startsWith('2024-02-29')));
  const early = generateTicks({ start: at(1), end: at(6) }, 1000);
  assert.ok(early.some(tick => tick.label === '0001'));
  assert.ok(early.every(tick => new Date(tick.coordinate).getUTCFullYear() < 100));
  const century = generateTicks({ start: at(99), end: at(101) }, 1000);
  assert.ok(century.some(tick => tick.label.startsWith('0100')));
  const full = generateTicks({ start: MIN_COORDINATE, end: MAX_COORDINATE }, 1000);
  assert.ok(full.length > 0 && full.length <= 10);
  assert.ok(full.every(tick => tick.coordinate >= MIN_COORDINATE && tick.coordinate <= MAX_COORDINATE));
});

test('same-date cards occupy separate lanes, retain temporal coordinate and have nonnegative tops', () => {
  const coordinate = at(2026, 10, 15);
  const result = layoutCards([card('b', coordinate), card('a', coordinate), card('c', coordinate)], range, 1000);
  assert.deepEqual(result.items.map(item => [item.id, item.lane]), [['a', 0], ['b', 1], ['c', 2]]);
  assert.ok(result.items.every(item => item.coordinate === coordinate && item.y >= 0));
  assert.ok(result.items[0].y > result.items[1].y);
  assert.ok(result.items[1].y > result.items[2].y);
  assert.ok(result.height > Math.max(...result.items.map(item => item.y + item.height)));
});

test('expanding one card changes lane height without collisions or overwriting preferences', () => {
  const inputs = [card('a', at(2026, 10, 15)), card('b', at(2026, 10, 15), 0, 420), card('c', at(2026, 10, 16), 2)];
  const result = layoutCards(inputs, range, 1000);
  assert.deepEqual(inputs.map(input => input.preferredLane), [0, 0, 2]);
  for (let i = 0; i < result.items.length; i += 1) {
    for (let j = i + 1; j < result.items.length; j += 1) {
      const first = result.items[i];
      const second = result.items[j];
      assert.ok(first.x + first.width <= second.x || second.x + second.width <= first.x ||
        first.y + first.height <= second.y || second.y + second.height <= first.y);
    }
  }
  assert.deepEqual(result, layoutCards([...inputs].reverse(), range, 1000));
});

test('a single card moves above the axis through empty levels, including a viewport taller than the layout', () => {
  const coordinate = at(2026, 10, 15);
  const layouts = [0, 1, 2].map(lane => layoutCards([card('only', coordinate, lane)], range, 1000));
  const viewportHeight = 1000;
  const axisDistance = layouts.map(layout => {
    const sceneHeight = Math.max(viewportHeight, layout.height);
    const shift = sceneHeight - layout.height;
    const item = layout.items[0];
    return sceneHeight - (item.y + shift + item.height);
  });
  assert.equal(layouts[1].height - layouts[0].height, EMPTY_LANE_HEIGHT);
  assert.equal(layouts[2].height - layouts[1].height, EMPTY_LANE_HEIGHT);
  assert.equal(axisDistance[1] - axisDistance[0], EMPTY_LANE_HEIGHT);
  assert.equal(axisDistance[2] - axisDistance[1], EMPTY_LANE_HEIGHT);
});

test('empty levels between occupied cards add space while each sparse gap is bounded', () => {
  const coordinate = at(2026, 10, 15);
  const adjacent = layoutCards([card('bottom', coordinate, 0), card('top', coordinate, 1)], range, 1000);
  const separated = layoutCards([card('bottom', coordinate, 0), card('top', coordinate, 3)], range, 1000);
  assert.equal(separated.height - adjacent.height, 2 * EMPTY_LANE_HEIGHT);
  const bottom = separated.items.find(item => item.id === 'bottom');
  const top = separated.items.find(item => item.id === 'top');
  assert.ok(bottom.y - (top.y + top.height) >= 2 * EMPTY_LANE_HEIGHT);
  for (const lane of [1_000_000, Number.MAX_SAFE_INTEGER]) {
    const sparse = layoutCards([card('sparse', coordinate, lane)], range, 1000);
    assert.ok(sparse.items[0].y >= 0);
    assert.equal(sparse.height, layoutsHeightForCard() + MAX_EMPTY_LANE_GAP);
  }
  function layoutsHeightForCard() { return layoutCards([card('normal', coordinate)], range, 1000).height; }
});

test('cards at both calendar limits fit the viewport and sparse lanes do not create huge canvases', () => {
  for (const coordinate of [MIN_COORDINATE, MAX_COORDINATE]) {
    const fitted = fitRange([coordinate], 1000);
    const { items, height } = layoutCards([card('edge', coordinate, 1_000_000)], fitted, 1000);
    assert.ok(items[0].x >= 0 && items[0].x + items[0].width <= 1000);
    assert.ok(height < MAX_EMPTY_LANE_GAP + 1000);
  }
  const offscreen = layoutCards([card('past', at(1)), card('future', at(9999))], range, 1000);
  assert.ok(offscreen.items[0].x < 0);
  assert.ok(offscreen.items[1].x > 1000);
});

test('invalid duplicate IDs and impossible geometry fail explicitly', () => {
  assert.throws(() => layoutCards([card('a', 0), card('a', 0)], range, 1000));
  assert.throws(() => layoutCards([card('a', 0, -1)], range, 1000));
  assert.throws(() => layoutCards([{ ...card('a', 0), height: Infinity }], range, 1000));
});

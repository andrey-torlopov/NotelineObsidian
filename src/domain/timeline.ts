/** Calendar coordinates use UTC fields only; they are never interpreted as instants. */
export interface TimeRange { start: number; end: number }
export interface LayoutInput {
  id: string;
  coordinate: number;
  preferredLane: number;
  width: number;
  height: number;
}
export interface LayoutItem extends LayoutInput { lane: number; x: number; y: number }
export interface TimelineTick { coordinate: number; label: string }

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const GAP = 16;
const AXIS_GAP = 24;
export const MIN_SPAN = HOUR;
export const EMPTY_LANE_HEIGHT = 64;
export const MAX_EMPTY_LANE_GAP = 4096;

function calendarCoordinate(year: number, month = 0, day = 1): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime();
}

export const MIN_COORDINATE = calendarCoordinate(1);
export const MAX_COORDINATE = calendarCoordinate(10_000) - 1;
const CALENDAR_SPAN = MAX_COORDINATE - MIN_COORDINATE;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

/** Keeps the duration and center where possible, including at calendar boundaries. */
export function clampRange(range: TimeRange, maxSpan = CALENDAR_SPAN): TimeRange {
  if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.end < range.start) {
    throw new Error("Invalid timeline range");
  }
  if (!Number.isFinite(maxSpan) || maxSpan <= 0) throw new Error("Invalid maximum span");
  const span = clamp(range.end - range.start, MIN_SPAN, clamp(maxSpan, MIN_SPAN, CALENDAR_SPAN));
  const center = range.start + (range.end - range.start) / 2;
  const start = clamp(center - span / 2, MIN_COORDINATE, MAX_COORDINATE - span);
  return { start, end: start + span };
}

export function dateToX(coordinate: number, range: TimeRange, width: number): number {
  if (width <= 0 || !Number.isFinite(width)) return 0;
  if (range.end <= range.start) return width / 2;
  return ((coordinate - range.start) / (range.end - range.start)) * width;
}

export function xToDate(x: number, range: TimeRange, width: number): number {
  if (width <= 0 || !Number.isFinite(width)) return range.start + (range.end - range.start) / 2;
  return range.start + (x / width) * (range.end - range.start);
}

/** A factor above one zooms in. anchorRatio is the pointer position within the viewport. */
export function zoomRange(range: TimeRange, factor: number, anchorRatio: number, maxSpan: number): TimeRange {
  if (!Number.isFinite(factor) || factor <= 0) throw new Error("Invalid zoom factor");
  if (!Number.isFinite(anchorRatio)) throw new Error("Invalid zoom anchor");
  const current = clampRange(range);
  const anchor = clamp(anchorRatio, 0, 1);
  const upperBound = clamp(maxSpan, MIN_SPAN, CALENDAR_SPAN);
  if (!Number.isFinite(maxSpan) || maxSpan <= 0) throw new Error("Invalid maximum span");
  const span = clamp((current.end - current.start) / factor, MIN_SPAN, upperBound);
  const start = current.start + (current.end - current.start) * anchor - span * anchor;
  return clampRange({ start, end: start + span }, upperBound);
}

export function panRange(range: TimeRange, delta: number): TimeRange {
  if (!Number.isFinite(delta)) throw new Error("Invalid pan distance");
  return clampRange({ start: range.start + delta, end: range.end + delta });
}

function monthSpan(reference: number): number {
  const date = new Date(clamp(reference, MIN_COORDINATE, MAX_COORDINATE));
  return calendarCoordinate(date.getUTCFullYear(), date.getUTCMonth() + 1) -
    calendarCoordinate(date.getUTCFullYear(), date.getUTCMonth());
}

function coordinateExtent(coordinates: readonly number[]): TimeRange | undefined {
  let start = Infinity;
  let end = -Infinity;
  for (const coordinate of coordinates) {
    if (Number.isFinite(coordinate)) {
      start = Math.min(start, coordinate);
      end = Math.max(end, coordinate);
    }
  }
  return start === Infinity ? undefined : { start, end };
}

/** One calendar month minimum; a major interval of padding on each side of the data. */
export function maxSpanForCoordinates(coordinates: readonly number[], referenceCoordinate = 0): number {
  const data = coordinateExtent(coordinates);
  const minimum = data?.start ?? referenceCoordinate;
  const maximum = data?.end ?? referenceCoordinate;
  const extent = maximum - minimum;
  const padding = extent >= 365 * DAY ? 366 * DAY : extent >= 28 * DAY ? 31 * DAY : DAY;
  return clamp(Math.max(monthSpan(minimum), extent + 2 * padding), MIN_SPAN, CALENDAR_SPAN);
}

/** Fits edge cards with adaptive padding on narrow screens. A single point gets one day. */
export function fitRange(coordinates: readonly number[], width: number, cardWidth = 300): TimeRange {
  const data = coordinateExtent(coordinates);
  if (!data) return { start: calendarCoordinate(1970), end: calendarCoordinate(1970, 1) };
  const minimum = data.start;
  const maximum = data.end;
  const extent = maximum - minimum;
  // Near full-width cards share horizontal space; edge clamping keeps them visible.
  const available = Math.max(1, width * 0.35, width - Math.max(0, cardWidth) - 2 * GAP);
  const paddingRatio = width > 0 ? Math.max(1, width / available) : 1;
  const span = Math.max(extent > 0 ? extent * paddingRatio : DAY, MIN_SPAN);
  const center = minimum + extent / 2;
  return clampRange({ start: center - span / 2, end: center + span / 2 });
}

type TickUnit = "minute" | "hour" | "day" | "week" | "month" | "year";
interface TickStep { unit: TickUnit; amount: number; approximate: number }
const TICK_STEPS: TickStep[] = [
  ...[1, 5, 15, 30].map(amount => ({ unit: "minute" as const, amount, approximate: amount * MINUTE })),
  ...[1, 3, 6, 12].map(amount => ({ unit: "hour" as const, amount, approximate: amount * HOUR })),
  { unit: "day", amount: 1, approximate: DAY },
  { unit: "week", amount: 1, approximate: 7 * DAY },
  ...[1, 3, 6].map(amount => ({ unit: "month" as const, amount, approximate: amount * 30 * DAY })),
  ...[1, 5, 10, 50, 100, 500, 1000, 2000].map(amount => ({ unit: "year" as const, amount, approximate: amount * 365.2425 * DAY })),
];

function floorTick(coordinate: number, step: TickStep): Date {
  const date = new Date(coordinate);
  date.setUTCSeconds(0, 0);
  if (step.unit === "minute") {
    date.setUTCMinutes(Math.floor(date.getUTCMinutes() / step.amount) * step.amount);
    return date;
  }
  date.setUTCMinutes(0);
  if (step.unit === "hour") {
    date.setUTCHours(Math.floor(date.getUTCHours() / step.amount) * step.amount);
    return date;
  }
  date.setUTCHours(0);
  if (step.unit === "week") date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  if (step.unit === "month") date.setUTCMonth(Math.floor(date.getUTCMonth() / step.amount) * step.amount, 1);
  if (step.unit === "year") {
    date.setUTCFullYear(Math.floor(date.getUTCFullYear() / step.amount) * step.amount, 0, 1);
  }
  return date;
}

function advanceTick(date: Date, step: TickStep): void {
  switch (step.unit) {
    case "minute": date.setUTCMinutes(date.getUTCMinutes() + step.amount); break;
    case "hour": date.setUTCHours(date.getUTCHours() + step.amount); break;
    case "day": date.setUTCDate(date.getUTCDate() + step.amount); break;
    case "week": date.setUTCDate(date.getUTCDate() + 7 * step.amount); break;
    case "month": date.setUTCMonth(date.getUTCMonth() + step.amount); break;
    case "year": date.setUTCFullYear(date.getUTCFullYear() + step.amount); break;
  }
}

function tickLabel(date: Date, unit: TickUnit): string {
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  if (unit === "year") return year;
  if (unit === "month") return `${year}-${month}`;
  const dayLabel = `${year}-${month}-${day}`;
  if (unit !== "minute" && unit !== "hour") return dayLabel;
  return `${dayLabel} ${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

export function generateTicks(range: TimeRange, width: number): TimelineTick[] {
  if (!Number.isFinite(width) || width <= 0 || range.end <= range.start) return [];
  const targetCount = clamp(Math.floor(width / 120), 2, 128);
  const desiredInterval = (range.end - range.start) / targetCount;
  const step = TICK_STEPS.find(candidate => candidate.approximate >= desiredInterval) ?? TICK_STEPS[TICK_STEPS.length - 1]!;
  const date = floorTick(range.start, step);
  if (date.getTime() < range.start) advanceTick(date, step);
  const ticks: TimelineTick[] = [];
  while (date.getTime() <= range.end && date.getTime() <= MAX_COORDINATE && ticks.length < 512) {
    if (date.getTime() >= MIN_COORDINATE) ticks.push({ coordinate: date.getTime(), label: tickLabel(date, step.unit) });
    advanceTick(date, step);
  }
  let previousX = -Infinity;
  return ticks.filter(tick => {
    const x = dateToX(tick.coordinate, range, width);
    if (x - previousX < 115) return false;
    previousX = x;
    return true;
  });
}

/** Empty levels preserve manual placement; very sparse gaps have bounded height. */
export function layoutCards(inputs: readonly LayoutInput[], range: TimeRange, width: number): { items: LayoutItem[]; height: number } {
  const ids = new Set<string>();
  for (const input of inputs) {
    if (ids.has(input.id) || !Number.isFinite(input.coordinate) || !Number.isSafeInteger(input.preferredLane) ||
      input.preferredLane < 0 || !Number.isFinite(input.width) || input.width <= 0 || !Number.isFinite(input.height) || input.height <= 0) {
      throw new Error("Invalid timeline layout input");
    }
    ids.add(input.id);
  }
  const sorted = [...inputs].sort((a, b) => a.preferredLane - b.preferredLane || a.coordinate - b.coordinate || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const lanes = new Map<number, { height: number; items: LayoutItem[] }>();
  const items: LayoutItem[] = [];
  for (const input of sorted) {
    const anchor = dateToX(input.coordinate, range, width);
    let x = anchor - input.width / 2;
    if (anchor >= 0 && anchor <= width && width >= input.width) x = clamp(x, 0, width - input.width);
    let lane = input.preferredLane;
    while (lanes.get(lane)?.items.some(other => x < other.x + other.width + GAP && x + input.width + GAP > other.x)) {
      if (lane === Number.MAX_SAFE_INTEGER) throw new Error("Timeline lane exceeds the supported integer range");
      lane += 1;
    }
    const item: LayoutItem = { ...input, lane, x, y: 0 };
    const level = lanes.get(lane) ?? { height: 0, items: [] };
    level.height = Math.max(level.height, input.height);
    level.items.push(item);
    lanes.set(lane, level);
    items.push(item);
  }
  const occupied = [...lanes.keys()].sort((a, b) => a - b);
  const emptySpace = new Map<number, number>();
  let nextLane = 0;
  let height = AXIS_GAP;
  for (const lane of occupied) {
    const space = Math.min(lane - nextLane, MAX_EMPTY_LANE_GAP / EMPTY_LANE_HEIGHT) * EMPTY_LANE_HEIGHT;
    emptySpace.set(lane, space);
    height += space + lanes.get(lane)!.height + GAP;
    nextLane = lane + 1;
  }
  let bottom = height - AXIS_GAP;
  for (const lane of occupied) {
    const level = lanes.get(lane)!;
    bottom -= emptySpace.get(lane)!;
    for (const item of level.items) item.y = bottom - item.height;
    bottom -= level.height + GAP;
  }
  return { items, height: inputs.length ? height : 0 };
}

import { MAX_COORDINATE, MIN_COORDINATE, MIN_SPAN } from "./timeline.ts";

export interface TimelineEntry {
  entryId: string;
  filePath: string;
  preferredLane: number;
  expanded: boolean;
  fallbackDate?: string;
  [key: string]: unknown;
}

export interface PluginState {
  schemaVersion: 1;
  settings: { dateProperties: string[]; [key: string]: unknown };
  timeline: {
    entries: TimelineEntry[];
    orientation?: 'horizontal' | 'vertical';
    reverse?: boolean;
    viewport?: { start: number; end: number; scrollTop: number; scrollLeft?: number; [key: string]: unknown };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export class StateValidationError extends Error {
  constructor(message: string) { super(message); this.name = "StateValidationError"; }
}

export function createDefaultState(): PluginState {
  return { schemaVersion: 1, settings: { dateProperties: ["timeline-date", "date"] }, timeline: { entries: [] } };
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StateValidationError(`Повреждено состояние Noteline: ${name} должен быть объектом.`);
  }
  return value as Record<string, unknown>;
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1]!;
}

function validPath(value: unknown): value is string {
  return typeof value === "string" && value.endsWith(".md") && !value.startsWith("/") && !value.includes("\\") &&
    !value.includes("\0") && value.split("/").every(segment => segment.length > 0 && segment !== "." && segment !== "..");
}

/** Validate before any save. Compatible fields unknown to this version survive round trips. */
export function validateState(raw: unknown): PluginState {
  if (raw == null) return createDefaultState();
  const source = record(raw, "корень");
  if (source.schemaVersion !== 1) {
    throw new StateValidationError("Версия состояния Noteline не поддерживается. Исходные данные сохранены; автоматический сброс запрещен.");
  }
  const settings = record(source.settings, "settings");
  if (!Array.isArray(settings.dateProperties) || !settings.dateProperties.every(value => typeof value === "string" && value.trim().length > 0)) {
    throw new StateValidationError("Повреждено состояние Noteline: неверный список свойств даты.");
  }
  if (new Set(settings.dateProperties).size !== settings.dateProperties.length) {
    throw new StateValidationError("Повреждено состояние Noteline: свойства даты повторяются.");
  }
  const timeline = record(source.timeline, "timeline");
  if (timeline.orientation !== undefined && timeline.orientation !== 'horizontal' && timeline.orientation !== 'vertical') throw new StateValidationError('Неподдерживаемая ориентация временной оси.');
  if (timeline.reverse !== undefined && typeof timeline.reverse !== 'boolean') throw new StateValidationError('Неверное направление временной оси.');
  if (!Array.isArray(timeline.entries)) throw new StateValidationError("Повреждено состояние Noteline: entries должен быть массивом.");
  const ids = new Set<string>();
  const paths = new Set<string>();
  const entries: TimelineEntry[] = timeline.entries.map((value, index) => {
    const entry = record(value, `entries[${index}]`);
    if (typeof entry.entryId !== "string" || !entry.entryId.trim() || !validPath(entry.filePath) ||
      typeof entry.preferredLane !== "number" || !Number.isSafeInteger(entry.preferredLane) || entry.preferredLane < 0 ||
      typeof entry.expanded !== "boolean" || (entry.fallbackDate !== undefined && !isDate(entry.fallbackDate))) {
      throw new StateValidationError(`Повреждено состояние Noteline: неверная запись ${index + 1}.`);
    }
    if (ids.has(entry.entryId) || paths.has(entry.filePath)) throw new StateValidationError("Повреждено состояние Noteline: повтор ID или пути заметки.");
    ids.add(entry.entryId);
    paths.add(entry.filePath);
    return { ...entry } as TimelineEntry;
  });
  let viewport: PluginState["timeline"]["viewport"];
  if (timeline.viewport !== undefined) {
    const value = record(timeline.viewport, "viewport");
    if (typeof value.start !== "number" || !Number.isFinite(value.start) || value.start < MIN_COORDINATE ||
      typeof value.end !== "number" || !Number.isFinite(value.end) || value.end > MAX_COORDINATE || value.end - value.start < MIN_SPAN ||
      typeof value.scrollTop !== "number" || !Number.isFinite(value.scrollTop) || value.scrollTop < 0 ||
      (value.scrollLeft !== undefined && (typeof value.scrollLeft !== 'number' || !Number.isFinite(value.scrollLeft) || value.scrollLeft < 0))) {
      throw new StateValidationError("Повреждено состояние Noteline: неверная область просмотра.");
    }
    viewport = { ...value } as PluginState["timeline"]["viewport"];
  }
  const result: PluginState = {
    ...source,
    schemaVersion: 1,
    settings: { ...settings, dateProperties: [...settings.dateProperties] as string[] },
    timeline: { ...timeline, entries },
  };
  if (viewport) result.timeline.viewport = viewport;
  return result;
}

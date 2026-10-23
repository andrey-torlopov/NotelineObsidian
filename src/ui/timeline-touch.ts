import type { Component } from 'obsidian';
import { panRange, type TimeRange } from '../domain/timeline.ts';

interface TouchCamera {
  range: TimeRange;
  extent: number;
  vertical: boolean;
  reverse: boolean;
}

interface Gesture extends TouchCamera {
  pointerId: number;
  x: number;
  y: number;
  surface: HTMLElement;
  dragging: boolean;
}

/** Touch pans calendar coordinates; the browser retains cross-axis and nested text scrolling. */
export function bindTimelineTouch(
  owner: Component,
  surfaces: readonly [HTMLElement, ...HTMLElement[]],
  readCamera: () => TouchCamera,
  applyRange: (range: TimeRange) => void,
  onFinish: () => void,
): (persist?: boolean) => void {
  const document = surfaces[0].ownerDocument;
  let gesture: Gesture | undefined;
  let suppressClick = false;

  const finish = (persist = true): void => {
    const previous = gesture;
    gesture = undefined;
    if (!previous) return;
    previous.surface.classList.remove('is-panning');
    if (previous.surface.hasPointerCapture(previous.pointerId)) previous.surface.releasePointerCapture(previous.pointerId);
    if (previous.dragging && persist) onFinish();
  };
  const position = (event: PointerEvent): void => {
    const current = gesture;
    if (!current || current.pointerId !== event.pointerId) return;
    const camera = readCamera();
    if (camera.vertical !== current.vertical || camera.reverse !== current.reverse || camera.extent !== current.extent) { finish(); return; }
    const along = current.vertical ? event.clientY - current.y : event.clientX - current.x;
    const across = current.vertical ? event.clientX - current.x : event.clientY - current.y;
    if (!current.dragging) {
      // Do not steal taps or the perpendicular gesture handled by the native scroll container.
      if (Math.abs(along) < 6 || Math.abs(along) < Math.abs(across)) return;
      try { current.surface.setPointerCapture(event.pointerId); }
      catch { finish(); return; } // The browser may already have canceled this pointer for native scrolling.
      current.dragging = true;
      current.surface.classList.add('is-panning');
      suppressClick = true;
    }
    const delta = -along * (current.range.end - current.range.start) / current.extent * (current.reverse ? -1 : 1);
    applyRange(panRange(current.range, delta));
  };

  owner.registerDomEvent(document, 'pointerdown', event => {
    if (event.pointerType === 'touch' && !event.isPrimary) { finish(); return; }
    suppressClick = false;
  }, { capture: true });
  owner.registerDomEvent(document, 'pointermove', position);
  owner.registerDomEvent(document, 'pointerup', event => {
    if (gesture?.pointerId !== event.pointerId) return;
    position(event); finish();
  });
  owner.registerDomEvent(document, 'pointercancel', event => { if (gesture?.pointerId === event.pointerId) finish(); });

  for (const surface of surfaces) {
    owner.registerDomEvent(surface, 'pointerdown', event => {
      if (event.pointerType !== 'touch' || !event.isPrimary || event.button !== 0) return;
      const target = event.target as Element | null;
      if (target?.closest('.noteline-card-body, .noteline-card-controls, .noteline-card.is-overflowing, button:not(.noteline-card-title), a, input, textarea, select, [contenteditable="true"]')) return;
      const camera = readCamera();
      if (!Number.isFinite(camera.extent) || camera.extent <= 0) return;
      gesture = { ...camera, range: { ...camera.range }, pointerId: event.pointerId, x: event.clientX, y: event.clientY, surface, dragging: false };
    });
    owner.registerDomEvent(surface, 'lostpointercapture', event => {
      // Promoting implicit capture from a title/child also bubbles lostpointercapture here.
      if (event.target === surface && gesture?.pointerId === event.pointerId && gesture.dragging) finish();
    });
    owner.registerDomEvent(surface, 'click', event => {
      if (!suppressClick || event.detail === 0) return;
      suppressClick = false; event.preventDefault(); event.stopImmediatePropagation();
    }, { capture: true });
    // Obsidian's surrounding mobile workspace must not interpret a timeline swipe as navigation.
    for (const name of ['touchstart', 'touchmove', 'touchend'] as const) owner.registerDomEvent(surface, name, event => event.stopPropagation(), { passive: true });
  }
  owner.register(finish);
  return finish;
}

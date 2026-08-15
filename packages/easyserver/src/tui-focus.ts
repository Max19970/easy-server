export interface TuiFocusWindow {
  readonly cursor: number;
  readonly start: number;
  readonly end: number;
  readonly hiddenBefore: number;
  readonly hiddenAfter: number;
}

export interface TuiBoundedFocusWindow extends TuiFocusWindow {
  readonly showBefore: boolean;
  readonly showAfter: boolean;
}

export function clampTuiFocus(cursor: number, itemCount: number): number {
  if (itemCount <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(cursor, itemCount - 1));
}

export function moveTuiFocus(
  cursor: number,
  itemCount: number,
  delta: -1 | 1,
): number {
  return clampTuiFocus(cursor + delta, itemCount);
}

export function tuiFocusWindowWithinRows(
  cursor: number,
  itemCount: number,
  rowCapacity: number,
  previousStart = 0,
): TuiBoundedFocusWindow {
  const safeRows = Math.max(1, Math.floor(rowCapacity));
  const markerBudget =
    itemCount > safeRows ? Math.min(2, Math.max(0, safeRows - 1)) : 0;
  const window = tuiFocusWindow(
    cursor,
    itemCount,
    Math.max(1, safeRows - markerBudget),
    previousStart,
  );
  if (markerBudget === 0) {
    return { ...window, showBefore: false, showAfter: false };
  }
  if (markerBudget === 1) {
    const showAfter = window.hiddenAfter > 0;
    return {
      ...window,
      showBefore: !showAfter && window.hiddenBefore > 0,
      showAfter,
    };
  }
  return {
    ...window,
    showBefore: window.hiddenBefore > 0,
    showAfter: window.hiddenAfter > 0,
  };
}

export function tuiFocusWindow(
  cursor: number,
  itemCount: number,
  capacity: number,
  previousStart = 0,
): TuiFocusWindow {
  const safeCount = Math.max(0, itemCount);
  const safeCursor = clampTuiFocus(cursor, safeCount);
  const safeCapacity = Math.max(1, Math.floor(capacity));
  const maxStart = Math.max(0, safeCount - safeCapacity);
  let start = Math.max(0, Math.min(previousStart, maxStart));

  if (safeCursor < start) {
    start = safeCursor;
  } else if (safeCursor >= start + safeCapacity) {
    start = safeCursor - safeCapacity + 1;
  }

  start = Math.max(0, Math.min(start, maxStart));
  const end = Math.min(safeCount, start + safeCapacity);

  return {
    cursor: safeCursor,
    start,
    end,
    hiddenBefore: start,
    hiddenAfter: Math.max(0, safeCount - end),
  };
}

export interface TuiFocusWindow {
  readonly cursor: number;
  readonly start: number;
  readonly end: number;
  readonly hiddenBefore: number;
  readonly hiddenAfter: number;
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

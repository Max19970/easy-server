export type TuiWidthClass = "compact" | "standard" | "wide";

export interface TuiResourceRow {
  readonly marker: string;
  readonly primary: string;
  readonly secondary?: string;
  readonly state: string;
  readonly compactPrimary?: string;
}

export function tuiWidthClass(columns: number): TuiWidthClass {
  if (columns < 72) {
    return "compact";
  }
  if (columns < 104) {
    return "standard";
  }
  return "wide";
}

export function tuiReadableMeasure(columns: number): number {
  return Math.max(20, Math.min(columns, 96));
}

export function tuiResourceRow(row: TuiResourceRow, columns: number): string {
  const width = Math.max(20, columns);
  const widthClass = tuiWidthClass(width);
  const marker = row.marker;
  const stateWidth = Math.min(24, Math.max(10, row.state.length));
  if (widthClass === "compact") {
    const primaryWidth = Math.max(6, width - marker.length - stateWidth - 2);
    return `${marker}${fitCell(row.compactPrimary ?? row.primary, primaryWidth)}  ${fitCell(row.state, stateWidth, "right")}`;
  }

  const secondaryDesired = row.secondary === undefined
    ? 0
    : widthClass === "wide"
      ? 28
      : 22;
  const separators = row.secondary === undefined ? 2 : 4;
  const primaryWidth = Math.max(
    10,
    width - marker.length - stateWidth - secondaryDesired - separators,
  );
  if (row.secondary === undefined) {
    return `${marker}${fitCell(row.primary, primaryWidth)}  ${fitCell(row.state, stateWidth, "right")}`;
  }
  return `${marker}${fitCell(row.primary, primaryWidth)}  ${fitCell(row.secondary, secondaryDesired)}  ${fitCell(row.state, stateWidth, "right")}`;
}

export function tuiTableColumnWidths(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  columns: number,
  prefixWidth = 6,
): readonly number[] {
  if (headers.length === 0) {
    return [];
  }
  const gapWidth = Math.max(0, headers.length - 1) * 2;
  const available = Math.max(headers.length * 4, columns - prefixWidth - gapWidth);
  const widths = headers.map((header, index) => {
    const longest = Math.max(
      header.length,
      ...rows.map((row) => row[index]?.length ?? 0),
    );
    return Math.min(28, Math.max(4, longest));
  });
  let total = widths.reduce((sum, width) => sum + width, 0);
  while (total > available) {
    let widestIndex = -1;
    let widest = 4;
    for (let index = 0; index < widths.length; index += 1) {
      if ((widths[index] ?? 4) > widest) {
        widest = widths[index] ?? 4;
        widestIndex = index;
      }
    }
    if (widestIndex < 0) {
      break;
    }
    widths[widestIndex] = Math.max(4, (widths[widestIndex] ?? 4) - 1);
    total -= 1;
  }
  return widths;
}

export function tuiTableRow(
  values: readonly string[],
  widths: readonly number[],
): string {
  return widths
    .map((width, index) => fitCell(values[index] ?? "", width))
    .join("  ");
}

function fitCell(
  value: string,
  width: number,
  align: "left" | "right" = "left",
): string {
  const safeWidth = Math.max(1, width);
  const fitted = truncateCell(value, safeWidth);
  return align === "right" ? fitted.padStart(safeWidth) : fitted.padEnd(safeWidth);
}

function truncateCell(value: string, width: number): string {
  if (value.length <= width) {
    return value;
  }
  if (width <= 1) {
    return value.slice(0, width);
  }
  return `${value.slice(0, width - 1)}…`;
}

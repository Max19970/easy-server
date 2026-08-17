export const TUI_ACCENTS = ["cyan", "blue", "magenta", "white"] as const;

export type TuiAccent = (typeof TUI_ACCENTS)[number];

export type TuiSemanticRole =
  | "accent"
  | "muted"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "border";

export type TuiSemanticTone = "info" | "success" | "warning" | "danger";

export interface TuiAppearance {
  readonly colorEnabled: boolean;
  readonly accent?: string;
  readonly muted?: string;
  readonly info?: string;
  readonly success?: string;
  readonly warning?: string;
  readonly danger?: string;
  readonly border?: string;
}

const COLOR_APPEARANCE: Omit<TuiAppearance, "colorEnabled" | "accent"> = {
  muted: "gray",
  info: "blue",
  success: "green",
  warning: "yellow",
  danger: "red",
  border: "gray",
};

export function tuiAppearance(
  colorEnabled: boolean,
  accent: TuiAccent = "cyan",
): TuiAppearance {
  return colorEnabled
    ? { colorEnabled: true, accent, ...COLOR_APPEARANCE }
    : { colorEnabled: false };
}

export function tuiRoleColor(
  appearance: TuiAppearance,
  role: TuiSemanticRole,
): string | undefined {
  return appearance[role];
}

export function tuiToneColor(
  appearance: TuiAppearance,
  tone: TuiSemanticTone,
): string | undefined {
  return appearance[tone];
}

export function tuiFocusColor(
  appearance: TuiAppearance,
  focused: boolean,
): string | undefined {
  return focused ? appearance.accent : undefined;
}

export function tuiResourceTone(
  state: string | undefined,
): TuiSemanticTone | undefined {
  switch (state) {
    case "running":
    case "ready":
    case "live":
    case "completed":
    case "loaded":
      return "success";
    case "stale":
    case "unobserved":
    case "starting":
    case "closing":
    case "credentials-missing":
    case "outcome-unknown":
      return "warning";
    case "failed":
    case "error":
    case "unreachable":
      return "danger";
    case "stopped":
    case "disabled":
      return "info";
    default:
      return undefined;
  }
}

export function tuiResourceColor(
  appearance: TuiAppearance,
  state: string | undefined,
): string | undefined {
  const tone = tuiResourceTone(state);
  return tone === undefined ? undefined : tuiToneColor(appearance, tone);
}

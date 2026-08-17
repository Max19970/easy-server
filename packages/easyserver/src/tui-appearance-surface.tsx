import React from "react";
import { Box, Text } from "ink";
import {
  TUI_ACCENTS,
  tuiAppearance,
  tuiFocusColor,
  type TuiAccent,
} from "./tui-appearance.js";
import {
  DEFAULT_TUI_APPEARANCE,
  type TuiAppearancePreferences,
} from "./tui-appearance-settings.js";
import {
  TUI_DENSITIES,
  tuiSpacing,
  type TuiDensity,
} from "./tui-layout.js";

export type TuiAppearanceChoice =
  | { readonly kind: "accent"; readonly value: TuiAccent; readonly label: string }
  | { readonly kind: "density"; readonly value: TuiDensity; readonly label: string }
  | { readonly kind: "reset"; readonly label: string };

const ACCENT_LABELS: Record<TuiAccent, string> = {
  cyan: "Cyan (default)",
  blue: "Blue",
  magenta: "Magenta",
  white: "White",
};

const DENSITY_LABELS: Record<TuiDensity, string> = {
  comfortable: "Comfortable (default)",
  compact: "Compact",
};

export const TUI_APPEARANCE_CHOICES: readonly TuiAppearanceChoice[] = [
  ...TUI_ACCENTS.map((value) => ({
    kind: "accent" as const,
    value,
    label: ACCENT_LABELS[value],
  })),
  ...TUI_DENSITIES.map((value) => ({
    kind: "density" as const,
    value,
    label: DENSITY_LABELS[value],
  })),
  { kind: "reset", label: "Reset to defaults" },
];

export function appearanceChoiceAt(cursor: number): TuiAppearanceChoice | undefined {
  return TUI_APPEARANCE_CHOICES[Math.max(0, Math.min(cursor, TUI_APPEARANCE_CHOICES.length - 1))];
}

export function applyAppearanceChoice(
  preferences: TuiAppearancePreferences,
  choice: TuiAppearanceChoice,
): TuiAppearancePreferences {
  switch (choice.kind) {
    case "accent":
      return { ...preferences, accent: choice.value };
    case "density":
      return { ...preferences, density: choice.value };
    case "reset":
      return DEFAULT_TUI_APPEARANCE;
  }
}

export function AppearanceSurface({
  preferences,
  cursor,
  colorEnabled,
}: {
  readonly preferences: TuiAppearancePreferences;
  readonly cursor: number;
  readonly colorEnabled: boolean;
}): React.ReactElement {
  const appearance = tuiAppearance(colorEnabled, preferences.accent);
  const spacing = tuiSpacing(preferences.density);
  let choiceIndex = 0;
  return (
    <Box flexDirection="column">
      <Text>
        Personalize focus color and spacing. Success, warning and danger colors stay semantic.
      </Text>
      <Box flexDirection="column" marginTop={spacing.sectionGap}>
        <Text bold>Accent</Text>
        {TUI_ACCENTS.map((accent) => {
          const index = choiceIndex++;
          const focused = index === cursor;
          return (
            <Text key={accent} bold={focused} color={tuiFocusColor(appearance, focused)}>
              {focused ? "> " : "  "}{preferences.accent === accent ? "[x] " : "[ ] "}{ACCENT_LABELS[accent]}
            </Text>
          );
        })}
      </Box>
      <Box flexDirection="column" marginTop={spacing.sectionGap}>
        <Text bold>Density</Text>
        {TUI_DENSITIES.map((density) => {
          const index = choiceIndex++;
          const focused = index === cursor;
          return (
            <Text key={density} bold={focused} color={tuiFocusColor(appearance, focused)}>
              {focused ? "> " : "  "}{preferences.density === density ? "[x] " : "[ ] "}{DENSITY_LABELS[density]}
            </Text>
          );
        })}
      </Box>
      <Box marginTop={spacing.sectionGap} flexDirection="column">
        <Text
          bold={choiceIndex === cursor}
          color={tuiFocusColor(appearance, choiceIndex === cursor)}
        >
          {choiceIndex === cursor ? "> " : "  "}Reset to defaults
        </Text>
        <Text color={appearance.muted}>↑/↓ choose · Enter apply · Esc back</Text>
      </Box>
    </Box>
  );
}

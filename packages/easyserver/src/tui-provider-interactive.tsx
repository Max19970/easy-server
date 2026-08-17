import React, { useEffect, useState } from "react";
import {
  Box,
  Text,
  useApp,
  useInput,
  useWindowSize,
} from "ink";
import type {
  ProviderInteractiveEvent,
  ProviderInteractiveField,
  ProviderInteractiveFieldValue,
  ProviderInteractiveScreen,
} from "@easyai101/easyserver-plugin-sdk";
import {
  moveTuiFocus,
  tuiFocusWindowWithinRows,
} from "./tui-focus.js";
import { escapeTerminalText } from "./terminal-text.js";

export interface ProviderInteractiveSurfaceProps {
  readonly screen: ProviderInteractiveScreen;
  readonly colorEnabled?: boolean;
  readonly disabled?: boolean;
  readonly height?: number;
  readonly screenReader?: boolean;
  onEvent(event: ProviderInteractiveEvent): void;
  onClose(): void;
}

interface DraftValue {
  readonly fieldId: string;
  readonly kind: "text" | "integer" | "decimal";
  readonly repeatable: boolean;
  readonly value: string;
}

export function ProviderInteractiveSurface({
  screen,
  colorEnabled = true,
  disabled = false,
  height,
  screenReader = false,
  onEvent,
  onClose,
}: ProviderInteractiveSurfaceProps): React.ReactElement {
  const { exit } = useApp();
  const windowSize = useWindowSize();
  const terminalRows = height ?? windowSize.rows ?? 24;
  const [cursor, setCursor] = useState(() =>
    screen.kind === "review" ? screen.items.length : 0,
  );
  const [choiceCursor, setChoiceCursor] = useState(0);
  const [choiceFieldId, setChoiceFieldId] = useState<string | undefined>();
  const [draft, setDraft] = useState<DraftValue | undefined>();

  const contentCount =
    screen.kind === "form"
      ? screen.fields.length
      : screen.kind === "table"
        ? screen.rows.length
        : screen.items.length;
  const actions = screen.actions.filter((action) => !action.disabled);
  const selectableCount = contentCount + actions.length;
  const activeField =
    screen.kind === "form" && cursor < screen.fields.length
      ? screen.fields[cursor]
      : undefined;
  const activeFieldDetail = activeField === undefined
    ? undefined
    : fieldDetailText(activeField);
  const fixedRows =
    2 +
    (screen.description === undefined ? 0 : 1) +
    (screen.kind === "table" ? 1 + (screen.loading ? 1 : 0) : 0) +
    (activeFieldDetail === undefined ? 0 : 1) +
    (actions.length === 0 ? 0 : actions.length + 1);
  const contentRowBudget = screenReader
    ? Math.max(1, contentCount)
    : Math.max(1, terminalRows - fixedRows);
  const contentCursor =
    contentCount === 0
      ? 0
      : screen.kind === "review" && cursor >= contentCount
        ? 0
        : Math.min(cursor, contentCount - 1);
  const contentWindow = tuiFocusWindowWithinRows(
    contentCursor,
    contentCount,
    contentRowBudget,
  );

  useEffect(() => {
    setCursor(screen.kind === "review" ? screen.items.length : 0);
    setChoiceCursor(0);
    setChoiceFieldId(undefined);
    setDraft(undefined);
  }, [screen.id, screen.kind]);

  useEffect(() => {
    if (selectableCount === 0) {
      setCursor(0);
      return;
    }
    setCursor((current) => Math.min(current, selectableCount - 1));
  }, [selectableCount]);

  const activeAction =
    cursor >= contentCount ? actions[cursor - contentCount] : undefined;
  const activeChoices =
    activeField?.kind === "single-choice" ||
    activeField?.kind === "multiple-choice"
      ? activeField.choices.filter((choice) => !choice.disabled)
      : [];

  useEffect(() => {
    if (activeChoices.length === 0) {
      setChoiceCursor(0);
      return;
    }
    setChoiceCursor((current) => Math.min(current, activeChoices.length - 1));
  }, [cursor, activeChoices.length]);

  useInput((input, key) => {
    if (disabled) {
      return;
    }

    if (key.ctrl && input === "c") {
      exit();
      return;
    }

    if (draft !== undefined) {
      if (key.escape) {
        setDraft(undefined);
        return;
      }
      if (key.return) {
        const clearingOptionalNumber =
          !draft.repeatable &&
          (draft.kind === "integer" || draft.kind === "decimal") &&
          draft.value.trim().length === 0;
        const value = parseDraft(draft);
        if (value !== undefined || clearingOptionalNumber) {
          onEvent({
            kind: "field-change",
            fieldId: draft.fieldId,
            value,
          });
          setDraft(undefined);
        }
        return;
      }
      if (key.backspace || key.delete) {
        setDraft((current) =>
          current === undefined
            ? current
            : { ...current, value: current.value.slice(0, -1) },
        );
        return;
      }
      if (!key.ctrl && !key.tab && input.length > 0) {
        setDraft((current) =>
          current === undefined
            ? current
            : { ...current, value: `${current.value}${input}` },
        );
      }
      return;
    }

    if (choiceFieldId !== undefined) {
      const choiceField =
        screen.kind === "form"
          ? screen.fields.find((field) => field.id === choiceFieldId)
          : undefined;
      const choices =
        choiceField?.kind === "single-choice" ||
        choiceField?.kind === "multiple-choice"
          ? choiceField.choices.filter((choice) => !choice.disabled)
          : [];

      if (key.escape || choiceField === undefined || choices.length === 0) {
        setChoiceFieldId(undefined);
        return;
      }
      if (key.downArrow) {
        setChoiceCursor((current) => moveTuiFocus(current, choices.length, 1));
        return;
      }
      if (key.upArrow) {
        setChoiceCursor((current) => moveTuiFocus(current, choices.length, -1));
        return;
      }
      if (key.return) {
        const choice = choices[choiceCursor];
        if (choice === undefined) {
          return;
        }
        if (choiceField.kind === "single-choice") {
          onEvent({
            kind: "field-change",
            fieldId: choiceField.id,
            value: choice.id,
          });
          setChoiceFieldId(undefined);
          return;
        }
        if (choiceField.kind === "multiple-choice") {
          const selected = new Set<string>(choiceField.value ?? []);
          if (selected.has(choice.id)) {
            selected.delete(choice.id);
          } else {
            selected.add(choice.id);
          }
          onEvent({
            kind: "field-change",
            fieldId: choiceField.id,
            value: [...selected],
          });
        }
      }
      return;
    }

    if (input === "q") {
      exit();
      return;
    }

    if (key.escape) {
      const back = actions.find((action) => action.kind === "back");
      if (back !== undefined) {
        onEvent({ kind: "action", actionId: back.id });
      } else {
        onClose();
      }
      return;
    }

    if (key.downArrow && selectableCount > 0) {
      setCursor((current) => moveTuiFocus(current, selectableCount, 1));
      return;
    }
    if (key.upArrow && selectableCount > 0) {
      setCursor((current) => moveTuiFocus(current, selectableCount, -1));
      return;
    }

    if (activeAction !== undefined) {
      if (key.return) {
        onEvent({ kind: "action", actionId: activeAction.id });
      }
      return;
    }

    if (screen.kind === "table") {
      const row = screen.rows[cursor];
      if (key.return || input === " ") {
        if (row === undefined || row.disabled) {
          return;
        }
        const selected = new Set(screen.selectedRowIds);
        if (screen.selection === "single") {
          onEvent({ kind: "table-selection", rowIds: [row.id] });
        } else {
          if (selected.has(row.id)) {
            selected.delete(row.id);
          } else {
            selected.add(row.id);
          }
          onEvent({ kind: "table-selection", rowIds: [...selected] });
        }
      }
      return;
    }

    if (screen.kind !== "form") {
      return;
    }

    const field = screen.fields[cursor];
    if (field === undefined || field.disabled) {
      return;
    }

    if (
      field.kind === "single-choice" ||
      field.kind === "multiple-choice"
    ) {
      if (key.return && activeChoices.length > 0) {
        const selectedIndex =
          field.kind === "single-choice"
            ? activeChoices.findIndex((choice) => choice.id === field.value)
            : activeChoices.findIndex((choice) => (field.value ?? []).includes(choice.id));
        setChoiceCursor(selectedIndex < 0 ? 0 : selectedIndex);
        setChoiceFieldId(field.id);
      }
      return;
    }

    if (field.kind === "boolean" && (key.return || input === " ")) {
      onEvent({
        kind: "field-change",
        fieldId: field.id,
        value: !(field.value ?? false),
      });
      return;
    }

    if (
      key.return &&
      (field.kind === "text" ||
        field.kind === "integer" ||
        field.kind === "decimal")
    ) {
      setDraft(fieldDraft(field));
    }
  });

  const accent = colorEnabled ? "cyan" : undefined;
  const muted = colorEnabled ? "gray" : undefined;
  const choiceField =
    choiceFieldId === undefined || screen.kind !== "form"
      ? undefined
      : screen.fields.find((field) => field.id === choiceFieldId);

  if (
    choiceField?.kind === "single-choice" ||
    choiceField?.kind === "multiple-choice"
  ) {
    return (
      <ChoicePicker
        field={choiceField}
        cursor={choiceCursor}
        height={terminalRows}
        colorEnabled={colorEnabled}
      />
    );
  }

  return (
    <Box
      flexDirection="column"
      height={screenReader ? undefined : terminalRows}
      overflowY={screenReader ? undefined : "hidden"}
    >
      <Text bold color={accent} wrap="truncate">{safe(screen.title)}</Text>
      {screen.description === undefined ? null : (
        <Text color={muted} wrap="truncate">{safe(screen.description)}</Text>
      )}
      <Box flexDirection="column">
        {screen.kind === "form" ? (
          <>
            {contentWindow.showBefore ? (
              <Text color={muted}>↑ {contentWindow.hiddenBefore} more</Text>
            ) : null}
            {screen.fields
              .slice(contentWindow.start, contentWindow.end)
              .map((field, visibleIndex) => {
                const index = contentWindow.start + visibleIndex;
                return (
                  <FieldLine
                    key={field.id}
                    field={field}
                    focused={index === cursor}
                    draft={draft?.fieldId === field.id ? draft.value : undefined}
                  />
                );
              })}
            {contentWindow.showAfter ? (
              <Text color={muted}>↓ {contentWindow.hiddenAfter} more</Text>
            ) : null}
          </>
        ) : screen.kind === "table" ? (
          <TableView
            screen={screen}
            cursor={cursor}
            windowStart={contentWindow.start}
            windowEnd={contentWindow.end}
            hiddenBefore={contentWindow.showBefore ? contentWindow.hiddenBefore : 0}
            hiddenAfter={contentWindow.showAfter ? contentWindow.hiddenAfter : 0}
            colorEnabled={colorEnabled}
          />
        ) : (
          <>
            {contentWindow.showBefore ? (
              <Text color={muted}>↑ {contentWindow.hiddenBefore} more review items</Text>
            ) : null}
            {screen.items
              .slice(contentWindow.start, contentWindow.end)
              .map((item, visibleIndex) => {
                const index = contentWindow.start + visibleIndex;
                const focused = index === cursor;
                return (
                  <Text key={`${item.label}:${index}`} bold={focused} wrap="truncate">
                    {focused ? "> " : "  "}{safe(item.label)}: {safe(item.value)}
                  </Text>
                );
              })}
            {contentWindow.showAfter ? (
              <Text color={muted}>↓ {contentWindow.hiddenAfter} more review items</Text>
            ) : null}
          </>
        )}
      </Box>
      {activeFieldDetail === undefined ? null : (
        <Text color={muted} wrap="truncate">{activeFieldDetail}</Text>
      )}
      {actions.length === 0 ? null : (
        <Box flexDirection="column">
          <Text bold>Actions</Text>
          {actions.map((action, index) => {
            const focused = cursor === contentCount + index;
            return (
              <Text
                key={action.id}
                bold={focused}
                color={focused ? accent : undefined}
                wrap="truncate"
              >
                {focused ? "> " : "  "}{safe(action.label)}
              </Text>
            );
          })}
        </Box>
      )}
      <Box>
        <Text color={muted} wrap="truncate">
          {draft === undefined
            ? "↑/↓ move · Enter select/edit/action · Esc back · Ctrl+C quit"
            : "Enter apply · Backspace edit · Esc cancel input"}
        </Text>
      </Box>
    </Box>
  );
}

function FieldLine({
  field,
  focused,
  draft,
}: {
  readonly field: ProviderInteractiveField;
  readonly focused: boolean;
  readonly draft?: string;
}): React.ReactElement {
  const value = draft ?? fieldDisplayValue(field);
  return (
    <Text bold={focused} wrap="truncate">
      {focused ? "> " : "  "}{safe(field.label)}{field.required ? " *" : ""}: {safe(value)}
    </Text>
  );
}

function fieldDetailText(field: ProviderInteractiveField): string | undefined {
  const parts: string[] = [];
  if (field.description !== undefined) {
    parts.push(safe(field.description));
  }
  if (field.validation?.state === "invalid") {
    parts.push(
      `Invalid${field.validation.message === undefined ? "" : `: ${safe(field.validation.message)}`}`,
    );
  } else if (field.validation?.state === "pending") {
    parts.push("Validating…");
  }
  return parts.length === 0 ? undefined : parts.join(" · ");
}

function ChoicePicker({
  field,
  cursor,
  height,
  colorEnabled,
}: {
  readonly field: Extract<ProviderInteractiveField, {
    readonly kind: "single-choice" | "multiple-choice";
  }>;
  readonly cursor: number;
  readonly height: number;
  readonly colorEnabled: boolean;
}): React.ReactElement {
  const choices = field.choices.filter((choice) => !choice.disabled);
  const focusedChoice =
    choices.length === 0
      ? undefined
      : choices[Math.max(0, Math.min(cursor, choices.length - 1))];
  const fixedRows =
    2 +
    (field.description === undefined ? 0 : 1) +
    (focusedChoice?.description === undefined ? 0 : 1);
  const window = tuiFocusWindowWithinRows(
    cursor,
    choices.length,
    Math.max(1, height - fixedRows),
  );
  const selected = new Set(
    field.kind === "single-choice"
      ? field.value === undefined
        ? []
        : [field.value]
      : field.value ?? [],
  );
  const muted = colorEnabled ? "gray" : undefined;
  const accent = colorEnabled ? "cyan" : undefined;

  return (
    <Box flexDirection="column" height={height} overflowY="hidden">
      <Text bold color={accent} wrap="truncate">Choose {safe(field.label)}</Text>
      {field.description === undefined ? null : (
        <Text color={muted} wrap="truncate">{safe(field.description)}</Text>
      )}
      <Box flexDirection="column">
        {window.showBefore ? <Text color={muted}>↑ {window.hiddenBefore} more</Text> : null}
        {choices.slice(window.start, window.end).map((choice, visibleIndex) => {
          const index = window.start + visibleIndex;
          const focused = index === window.cursor;
          return (
            <Text key={choice.id} bold={focused} color={focused ? accent : undefined}>
              {focused ? "> " : "  "}{selected.has(choice.id) ? "[x] " : "[ ] "}{safe(choice.label)}
            </Text>
          );
        })}
        {window.showAfter ? <Text color={muted}>↓ {window.hiddenAfter} more</Text> : null}
      </Box>
      {focusedChoice?.description === undefined ? null : (
        <Text wrap="truncate">{safe(focusedChoice.description)}</Text>
      )}
      <Box>
        <Text color={muted} wrap="truncate">
          {field.kind === "single-choice"
            ? "↑/↓ move · Enter choose · Esc back"
            : "↑/↓ move · Enter toggle · Esc done"}
        </Text>
      </Box>
    </Box>
  );
}

function TableView({
  screen,
  cursor,
  windowStart,
  windowEnd,
  hiddenBefore,
  hiddenAfter,
  colorEnabled,
}: {
  readonly screen: Extract<ProviderInteractiveScreen, { readonly kind: "table" }>;
  readonly cursor: number;
  readonly windowStart: number;
  readonly windowEnd: number;
  readonly hiddenBefore: number;
  readonly hiddenAfter: number;
  readonly colorEnabled: boolean;
}): React.ReactElement {
  const selected = new Set(screen.selectedRowIds);
  const muted = colorEnabled ? "gray" : undefined;
  return (
    <Box flexDirection="column">
      <Text wrap="truncate">{screen.columns.map((column) => safe(column.label)).join(" · ")}</Text>
      {hiddenBefore > 0 ? <Text color={muted}>↑ {hiddenBefore} more offers</Text> : null}
      {screen.rows.slice(windowStart, windowEnd).map((row, visibleIndex) => {
        const index = windowStart + visibleIndex;
        return (
          <Text key={row.id} bold={index === cursor} wrap="truncate">
            {index === cursor ? "> " : "  "}{selected.has(row.id) ? "[x] " : "[ ] "}
            {screen.columns
              .map((column) => safe(String(row.cells[column.id] ?? "")))
              .join(" · ")}
            {row.disabled ? " · unavailable" : ""}
          </Text>
        );
      })}
      {hiddenAfter > 0 ? <Text color={muted}>↓ {hiddenAfter} more offers</Text> : null}
      {screen.loading ? <Text>Loading provider results…</Text> : null}
    </Box>
  );
}

function fieldDraft(
  field: Extract<ProviderInteractiveField, {
    readonly kind: "text" | "integer" | "decimal";
  }>,
): DraftValue {
  const repeatable = field.repeatable === true;
  const raw = field.value;
  return {
    fieldId: field.id,
    kind: field.kind,
    repeatable,
    value: Array.isArray(raw) ? raw.join(", ") : raw === undefined ? "" : String(raw),
  };
}

function parseDraft(draft: DraftValue): ProviderInteractiveFieldValue | undefined {
  const rawValues = draft.repeatable
    ? draft.value.split(",").map((value) => value.trim()).filter((value) => value.length > 0)
    : [draft.value];
  if (draft.kind === "text") {
    return draft.repeatable ? rawValues : rawValues[0] ?? "";
  }
  if (!draft.repeatable && draft.value.trim().length === 0) {
    return undefined;
  }
  const numbers = rawValues.map(Number);
  if (
    numbers.some((value) =>
      draft.kind === "integer" ? !Number.isInteger(value) : !Number.isFinite(value),
    )
  ) {
    return undefined;
  }
  return draft.repeatable ? numbers : numbers[0];
}

function fieldDisplayValue(field: ProviderInteractiveField): string {
  if (field.kind === "boolean") {
    return field.value ? "yes" : "no";
  }
  if (field.kind === "single-choice") {
    const selected = field.choices.find((choice) => choice.id === field.value);
    return selected?.label ?? "not selected";
  }
  if (field.kind === "multiple-choice") {
    const selected = new Set(field.value ?? []);
    const labels = field.choices
      .filter((choice) => selected.has(choice.id))
      .map((choice) => choice.label);
    return labels.length === 0 ? "none" : labels.join(", ");
  }
  if (Array.isArray(field.value)) {
    return field.value.join(", ");
  }
  return field.value === undefined ? "" : String(field.value);
}

function safe(value: string): string {
  return escapeTerminalText(value);
}

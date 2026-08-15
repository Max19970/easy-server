import React, { useEffect, useMemo, useState } from "react";
import {
  Box,
  Text,
  useApp,
  useInput,
} from "ink";
import type {
  ProviderInteractiveAction,
  ProviderInteractiveEvent,
  ProviderInteractiveField,
  ProviderInteractiveFieldValue,
  ProviderInteractiveScreen,
} from "@easyai101/easyserver-plugin-sdk";
import { escapeTerminalText } from "./terminal-text.js";

export interface ProviderInteractiveSurfaceProps {
  readonly screen: ProviderInteractiveScreen;
  readonly colorEnabled?: boolean;
  readonly disabled?: boolean;
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
  onEvent,
  onClose,
}: ProviderInteractiveSurfaceProps): React.ReactElement {
  const { exit } = useApp();
  const [cursor, setCursor] = useState(0);
  const [choiceCursor, setChoiceCursor] = useState(0);
  const [draft, setDraft] = useState<DraftValue | undefined>();

  const contentCount =
    screen.kind === "form"
      ? screen.fields.length
      : screen.kind === "table"
        ? screen.rows.length
        : 0;
  const actions = screen.actions.filter((action) => !action.disabled);
  const selectableCount = contentCount + actions.length;

  useEffect(() => {
    setCursor(0);
    setChoiceCursor(0);
    setDraft(undefined);
  }, [screen.id, screen.kind]);

  useEffect(() => {
    if (selectableCount === 0) {
      setCursor(0);
      return;
    }
    setCursor((current) => Math.min(current, selectableCount - 1));
  }, [selectableCount]);

  const activeField =
    screen.kind === "form" && cursor < screen.fields.length
      ? screen.fields[cursor]
      : undefined;
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
      setCursor((current) => (current + 1) % selectableCount);
      return;
    }
    if (key.upArrow && selectableCount > 0) {
      setCursor((current) => (current - 1 + selectableCount) % selectableCount);
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
      if (key.rightArrow && activeChoices.length > 0) {
        const nextIndex = (choiceCursor + 1) % activeChoices.length;
        setChoiceCursor(nextIndex);
        if (field.kind === "single-choice") {
          onEvent({
            kind: "field-change",
            fieldId: field.id,
            value: activeChoices[nextIndex]!.id,
          });
        }
        return;
      }
      if (key.leftArrow && activeChoices.length > 0) {
        const nextIndex =
          (choiceCursor - 1 + activeChoices.length) % activeChoices.length;
        setChoiceCursor(nextIndex);
        if (field.kind === "single-choice") {
          onEvent({
            kind: "field-change",
            fieldId: field.id,
            value: activeChoices[nextIndex]!.id,
          });
        }
        return;
      }
      if (
        field.kind === "multiple-choice" &&
        (key.return || input === " ") &&
        activeChoices[choiceCursor] !== undefined
      ) {
        const selected = new Set<string>(field.value ?? []);
        const id = activeChoices[choiceCursor]!.id;
        if (selected.has(id)) {
          selected.delete(id);
        } else {
          selected.add(id);
        }
        onEvent({
          kind: "field-change",
          fieldId: field.id,
          value: [...selected],
        });
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

  return (
    <Box flexDirection="column">
      <Text bold color={accent}>{safe(screen.title)}</Text>
      {screen.description === undefined ? null : (
        <Text color={muted}>{safe(screen.description)}</Text>
      )}
      <Box marginTop={1} flexDirection="column">
        {screen.kind === "form" ? (
          screen.fields.map((field, index) => (
            <FieldLine
              key={field.id}
              field={field}
              focused={index === cursor}
              choiceCursor={index === cursor ? choiceCursor : 0}
              draft={draft?.fieldId === field.id ? draft.value : undefined}
            />
          ))
        ) : screen.kind === "table" ? (
          <TableView screen={screen} cursor={cursor} />
        ) : (
          screen.items.map((item, index) => (
            <Text key={`${item.label}:${index}`}>
              {safe(item.label)}: {safe(item.value)}
            </Text>
          ))
        )}
      </Box>
      {actions.length === 0 ? null : (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Actions</Text>
          {actions.map((action, index) => {
            const focused = cursor === contentCount + index;
            return (
              <Text key={action.id} bold={focused} color={focused ? accent : undefined}>
                {focused ? "> " : "  "}{safe(action.label)}
              </Text>
            );
          })}
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={muted} wrap="wrap">
          {draft === undefined
            ? "↑/↓ move · ←/→ change choice · Enter select/edit/action · Esc back · Ctrl+C quit"
            : "Enter apply · Backspace edit · Esc cancel input"}
        </Text>
      </Box>
    </Box>
  );
}

function FieldLine({
  field,
  focused,
  choiceCursor,
  draft,
}: {
  readonly field: ProviderInteractiveField;
  readonly focused: boolean;
  readonly choiceCursor: number;
  readonly draft?: string;
}): React.ReactElement {
  const value = draft ?? fieldDisplayValue(field, choiceCursor);
  const choiceDescription =
    focused &&
    (field.kind === "single-choice" || field.kind === "multiple-choice")
      ? field.choices.filter((choice) => !choice.disabled)[choiceCursor]?.description
      : undefined;
  return (
    <Box flexDirection="column">
      <Text bold={focused}>
        {focused ? "> " : "  "}{safe(field.label)}{field.required ? " *" : ""}: {safe(value)}
      </Text>
      {field.description === undefined ? null : (
        <Text>    {safe(field.description)}</Text>
      )}
      {choiceDescription === undefined ? null : (
        <Text>    {safe(choiceDescription)}</Text>
      )}
      {field.validation?.state === "invalid" ? (
        <Text>    Invalid{field.validation.message === undefined ? "" : `: ${safe(field.validation.message)}`}</Text>
      ) : field.validation?.state === "pending" ? (
        <Text>    Validating…</Text>
      ) : null}
    </Box>
  );
}

function TableView({
  screen,
  cursor,
}: {
  readonly screen: Extract<ProviderInteractiveScreen, { readonly kind: "table" }>;
  readonly cursor: number;
}): React.ReactElement {
  const selected = new Set(screen.selectedRowIds);
  return (
    <Box flexDirection="column">
      <Text>{screen.columns.map((column) => safe(column.label)).join(" · ")}</Text>
      {screen.rows.map((row, index) => (
        <Text key={row.id} bold={index === cursor}>
          {index === cursor ? "> " : "  "}{selected.has(row.id) ? "[x] " : "[ ] "}
          {screen.columns
            .map((column) => safe(String(row.cells[column.id] ?? "")))
            .join(" · ")}
          {row.disabled ? " · unavailable" : ""}
        </Text>
      ))}
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

function fieldDisplayValue(
  field: ProviderInteractiveField,
  choiceCursor: number,
): string {
  if (field.kind === "boolean") {
    return field.value ? "yes" : "no";
  }
  if (field.kind === "single-choice") {
    const selected = field.choices.find((choice) => choice.id === field.value);
    const cursorChoice = field.choices.filter((choice) => !choice.disabled)[choiceCursor];
    return selected?.label ?? cursorChoice?.label ?? "not selected";
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

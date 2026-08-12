import React, { useMemo, useState } from "react";
import {
  Box,
  Text,
  render,
  type Instance as InkInstance,
  useApp,
  useInput,
  useWindowSize,
} from "ink";
import { TuiOperationDrawer } from "./tui-operation-drawer.js";
import {
  isTuiOperationPresentation,
  type TuiOperationActionKind,
  type TuiOperationPresentation,
} from "./tui-operation-model.js";
import { EASYSERVER_VERSION } from "./version.js";

interface TuiRoute {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly body: string;
}

const routes: readonly TuiRoute[] = [
  {
    id: "overview",
    label: "Overview",
    description: "EasyServer at a glance",
    body: "Choose a section to inspect or manage your EasyServer environment.",
  },
  {
    id: "instances",
    label: "Instances",
    description: "Compute inventory and lifecycle",
    body: "Instance inventory and lifecycle workflows will appear on this surface.",
  },
  {
    id: "providers",
    label: "Providers",
    description: "Plugins, setup and acquisition",
    body: "Provider readiness, credentials and provider-owned flows will appear here.",
  },
  {
    id: "sessions",
    label: "Sessions",
    description: "Connections and Endpoint intents",
    body: "Connection sessions and persistent Endpoint intents will appear here.",
  },
  {
    id: "diagnostics",
    label: "Diagnostics",
    description: "Health and support information",
    body: "Privacy-safe health and support information will appear here.",
  },
];

export interface TuiShellProps {
  readonly width?: number;
  readonly colorEnabled?: boolean;
  readonly screenReader?: boolean;
  readonly operation?: TuiOperationPresentation;
  readonly onOperationAction?: (action: TuiOperationActionKind) => void;
}

export function TuiShell({
  width,
  colorEnabled = true,
  screenReader = false,
  operation,
  onOperationAction,
}: TuiShellProps): React.ReactElement {
  if (operation !== undefined && !isTuiOperationPresentation(operation)) {
    throw new TypeError("TUI operation presentation must come from the presentation model");
  }

  const { exit } = useApp();
  const windowSize = useWindowSize();
  const columns = width ?? windowSize.columns ?? 80;
  const narrow = columns < 72;
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);
  const [status, setStatus] = useState("Ready.");
  const activeRoute = routes[activeIndex] ?? routes[0];
  const operationInteractionOpen = operation?.interaction !== undefined;

  const navigation = useMemo(
    () =>
      routes.map((route, index) => ({
        ...route,
        active: index === activeIndex,
        focused: index === focusedIndex,
      })),
    [activeIndex, focusedIndex],
  );

  useInput((input, key) => {
    if ((key.ctrl && input === "c") || input === "q") {
      exit();
      return;
    }

    if (operation !== undefined) {
      const action = operationActionForInput(operation, input, key);
      if (action !== undefined) {
        onOperationAction?.(action);
        return;
      }
      if (operationInteractionOpen) {
        return;
      }
    }

    if (input === "?") {
      setHelpOpen((open) => !open);
      return;
    }

    if (key.escape) {
      if (helpOpen) {
        setHelpOpen(false);
      } else if (activeIndex !== 0 || focusedIndex !== 0) {
        setActiveIndex(0);
        setFocusedIndex(0);
        setStatus("Returned to Overview.");
      }
      return;
    }

    if (helpOpen) {
      return;
    }

    if (input === "r") {
      setStatus(`Refresh requested for ${activeRoute.label}.`);
      return;
    }

    if (key.return) {
      setActiveIndex(focusedIndex);
      setStatus(`Opened ${routes[focusedIndex]?.label ?? "Overview"}.`);
      return;
    }

    const backwards = key.upArrow || key.leftArrow || (key.tab && key.shift);
    const forwards = key.downArrow || key.rightArrow || (key.tab && !key.shift);
    if (!backwards && !forwards) {
      return;
    }

    setFocusedIndex((current) => {
      if (backwards) {
        return (current - 1 + routes.length) % routes.length;
      }
      return (current + 1) % routes.length;
    });
  });

  const accent = colorEnabled ? "cyan" : undefined;
  const muted = colorEnabled ? "gray" : undefined;

  return (
    <Box flexDirection="column" width="100%" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color={accent} aria-label={`EasyServer ${EASYSERVER_VERSION}`}>
          EasyServer
        </Text>
        <Text color={muted}>v{EASYSERVER_VERSION}</Text>
      </Box>
      <Text color={muted}>
        Control center · {narrow ? "compact layout" : "wide layout"}
      </Text>

      <Box
        flexDirection={narrow ? "column" : "row"}
        marginTop={1}
        gap={narrow ? 1 : 3}
      >
        <Box
          flexDirection="column"
          width={narrow ? "100%" : 25}
          aria-role="tablist"
        >
          {navigation.map((route) => (
            <Box
              key={route.id}
              aria-role="tab"
              aria-state={{ selected: route.active }}
              aria-label={`${route.label}${route.active ? ", active" : ""}${route.focused ? ", focused" : ""}`}
            >
              <Text
                bold={route.focused}
                color={route.focused ? accent : undefined}
              >
                {route.focused ? "> " : "  "}
                {route.label}
                {route.active ? " [active]" : ""}
              </Text>
            </Box>
          ))}
        </Box>

        <Box flexDirection="column" flexGrow={1} minWidth={0}>
          {helpOpen ? (
            <HelpPanel colorEnabled={colorEnabled} />
          ) : (
            <Box flexDirection="column">
              <Text bold>{activeRoute.label}</Text>
              <Text color={muted}>{activeRoute.description}</Text>
              <Box marginTop={1}>
                <Text wrap="wrap">{activeRoute.body}</Text>
              </Box>
            </Box>
          )}
        </Box>
      </Box>

      {operation === undefined ? null : (
        <Box marginTop={1}>
          <TuiOperationDrawer operation={operation} colorEnabled={colorEnabled} />
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text aria-label={`Status: ${status}`}>Status: {status}</Text>
        {operationInteractionOpen ? (
          <Text color={muted} wrap="wrap">
            Confirmation has focus · use the actions shown above · q quit
          </Text>
        ) : operation !== undefined ? (
          <Text color={muted} wrap="wrap">
            Operation status shown · Tab/Shift+Tab or arrows still navigate · drawer actions use the keys shown above · q quit
          </Text>
        ) : screenReader ? (
          <Text>
            Commands: Tab or arrows move focus; Enter opens; Escape returns or closes help; question mark opens help; R refreshes; Q quits.
          </Text>
        ) : (
          <Text color={muted} wrap="wrap">
            Tab/Shift+Tab or arrows move · Enter open · Esc back · ? help · r refresh · q quit
          </Text>
        )}
      </Box>
    </Box>
  );
}

function operationActionForInput(
  operation: TuiOperationPresentation,
  input: string,
  key: { readonly escape: boolean; readonly return: boolean },
): TuiOperationActionKind | undefined {
  const available = new Set(operation.actions.map((action) => action.kind));

  if (key.return) {
    if (available.has("confirm")) {
      return "confirm";
    }
    if (available.has("trust")) {
      return "trust";
    }
    return undefined;
  }

  if (key.escape && available.has("decline")) {
    return "decline";
  }

  if (input === "c" && available.has("cancel")) {
    return "cancel";
  }
  if (input === "x" && available.has("dismiss")) {
    return "dismiss";
  }
  if (input === "o" && available.has("observe")) {
    return "observe";
  }
  if (input === "R" && available.has("refresh")) {
    return "refresh";
  }
  if (input === "R" && available.has("retry")) {
    return "retry";
  }
  return undefined;
}

function HelpPanel({ colorEnabled }: { readonly colorEnabled: boolean }): React.ReactElement {
  const accent = colorEnabled ? "cyan" : undefined;
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={accent}
      paddingX={1}
      aria-role="menu"
    >
      <Text bold>Keyboard help</Text>
      <Text>Tab / Shift+Tab — move focus</Text>
      <Text>Arrow keys — move focus</Text>
      <Text>Enter — open focused section</Text>
      <Text>Esc — close help or return to Overview</Text>
      <Text>? — toggle this help</Text>
      <Text>r — refresh current section</Text>
      <Text>q / Ctrl+C — quit EasyServer</Text>
    </Box>
  );
}

export interface TuiRuntimeOptions {
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly stderr?: NodeJS.WriteStream;
  readonly env?: NodeJS.ProcessEnv;
}

export function renderTui(options: TuiRuntimeOptions = {}): InkInstance {
  const env = options.env ?? process.env;
  const screenReader = env.INK_SCREEN_READER === "true";
  const colorEnabled = env.NO_COLOR === undefined;
  return render(
    <TuiShell colorEnabled={colorEnabled} screenReader={screenReader} />,
    {
      stdin: options.stdin ?? process.stdin,
      stdout: options.stdout ?? process.stdout,
      stderr: options.stderr ?? process.stderr,
      alternateScreen: !screenReader,
      isScreenReaderEnabled: screenReader,
      incrementalRendering: true,
      interactive: true,
      maxFps: screenReader ? 10 : 30,
    },
  );
}

export async function runTui(): Promise<void> {
  const app = renderTui();
  await app.waitUntilExit();
}

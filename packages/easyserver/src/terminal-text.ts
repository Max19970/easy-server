const TERMINAL_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu;

export function escapeTerminalText(value: string): string {
  return value.replace(TERMINAL_CONTROL_PATTERN, (character) => {
    if (character === "\n") {
      return "\\n";
    }
    if (character === "\r") {
      return "\\r";
    }
    if (character === "\t") {
      return "\\t";
    }

    return `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`;
  });
}

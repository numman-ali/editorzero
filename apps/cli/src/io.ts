/**
 * CLI output helpers — AXI-shaped envelopes on stdout (ADR 0021, ADR 0025).
 *
 * AXI commitments this module encodes:
 *   - Errors go to stdout (not stderr) in a structured envelope with a
 *     typed `code` + actionable `help` suggestion. Stderr is reserved
 *     for diagnostic output (not wired here).
 *   - JSON is the interim format until the agent-mode output-format eval
 *     lands (ADR 0021 Decision §6). One-line-per-value keeps the output
 *     trivially parseable and avoids unterminated reads on closed pipes.
 *
 * `emit` writes a success value; `emitError` writes an `{ error: { code,
 * help, ...extras } }` envelope. Both append a trailing newline so
 * downstream tools can `read -r` line-by-line.
 */

export interface ErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly help: string;
    readonly [k: string]: unknown;
  };
}

export function emit(data: unknown, stdout: NodeJS.WritableStream = process.stdout): void {
  stdout.write(`${JSON.stringify(data)}\n`);
}

export function emitError(
  code: string,
  help: string,
  extra: Readonly<Record<string, unknown>> = {},
  stdout: NodeJS.WritableStream = process.stdout,
): void {
  const envelope: ErrorEnvelope = { error: { code, help, ...extra } };
  stdout.write(`${JSON.stringify(envelope)}\n`);
}

/**
 * True when stdout is being piped or captured (agent harness, CI,
 * script) rather than a human TTY. AXI governs agent mode; clig.dev
 * governs TTY. Slice-1 behaviour is mode-agnostic (JSON on stdout
 * either way); the distinction exists so the interactive password
 * prompt can refuse to run in agent mode and direct callers to
 * `--password-stdin` instead.
 */
export function isAgentMode(stdout: NodeJS.WriteStream = process.stdout): boolean {
  return stdout.isTTY !== true;
}

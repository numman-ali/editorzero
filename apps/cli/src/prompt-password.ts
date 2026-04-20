/**
 * Password input helpers (ADR 0025 §load-bearing commitment 3).
 *
 * Two modes, picked by the calling command based on TTY detection:
 *
 *   - `readPasswordFromStdin` — non-TTY / agent mode. Reads the full
 *     stdin stream to EOF and strips a trailing newline. AXI
 *     commitment: no interactive prompts in agent mode. The standard
 *     Unix idiom is `echo $PASS | ez auth login --email ... --password-stdin`
 *     or `ez auth login --email ... --password-stdin < secret.txt`.
 *     Mirrors `podman login --password-stdin` / `docker login
 *     --password-stdin`.
 *
 *   - `promptPasswordInteractive` — TTY only. Raw-mode stdin reads one
 *     keypress at a time; input is not echoed. Enter / Return /
 *     Ctrl-D finish the prompt; Backspace / DEL remove the last char.
 *     Not unit-tested — raw-mode TTY semantics are awkward to mock
 *     deterministically, and the interactive flow is exercised via
 *     manual smoke. The non-TTY path (`--password-stdin`) is the one
 *     the integration test runs through.
 */

export async function readPasswordFromStdin(
  stdin: NodeJS.ReadableStream = process.stdin,
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  // Strip the trailing newline if present — callers typically pipe
  // `echo $PASS`, which appends `\n`. A password that genuinely ends
  // in `\n` isn't expressible through stdin; that's a Unix idiom
  // constraint, not a bug.
  return Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/u, "");
}

/* v8 ignore start -- @preserve: raw-mode TTY prompt; exercised manually, not unit-tested */
export async function promptPasswordInteractive(
  stdin: NodeJS.ReadStream = process.stdin,
  stdout: NodeJS.WriteStream = process.stdout,
): Promise<string> {
  stdout.write("Password: ");
  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve) => {
    const chars: string[] = [];
    const onData = (ch: string): void => {
      if (ch === "\r" || ch === "\n" || ch === "\x04") {
        stdin.setRawMode?.(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        stdout.write("\n");
        resolve(chars.join(""));
        return;
      }
      if (ch === "\x7f" || ch === "\b") {
        chars.pop();
        return;
      }
      // Ctrl-C → re-raise as SIGINT so parent shell handles it.
      if (ch === "\x03") {
        stdin.setRawMode?.(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.kill(process.pid, "SIGINT");
        return;
      }
      chars.push(ch);
    };
    stdin.on("data", onData);
  });
}
/* v8 ignore stop */

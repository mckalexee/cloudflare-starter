// Runs commands for the steps. Each command is printed before it runs, with names only: a secret
// value never appears in the printed line or in the arguments, because it travels on standard
// input or in a temporary file outside the repository. A command that fails stops the step with
// its exit code, and its output is already on the screen.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Thrown when a step can't finish. The message says what failed and what to do next. */
export class StepError extends Error {
  override readonly name = "StepError";
}

/** Thrown by a part of the script that the remote half of setup still has to build. */
export class NotBuiltError extends StepError {
  constructor(what: string) {
    super(
      `${what} belongs to the remote half of the setup script, which isn't built yet. Run the script with SETUP_FIXTURE=<file> to test the local half.`,
    );
  }
}

/** Options for one command. */
export type RunOptions = {
  /** Text for standard input, such as a secret value. It's never printed. */
  stdin?: string;
  /** Extra environment variables. Their names are printed, never their values. */
  env?: Record<string, string>;
  /** Capture standard output instead of showing it, for commands whose output the step parses. */
  capture?: boolean;
  /** The text to print instead of the command, when the arguments name a temporary path. */
  display?: string;
};

/** Prints lines of the step's log. */
export function say(...lines: string[]): void {
  for (const line of lines) {
    console.log(line);
  }
}

function quote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
}

/**
 * Runs a command in `cwd` after printing it, and returns its standard output when `capture` is
 * set. Throws a `StepError` when the command exits with a nonzero code.
 */
export function run(
  cwd: string,
  command: string,
  args: string[],
  options: RunOptions = {},
): string {
  const envNames = Object.keys(options.env ?? {});
  const shown = options.display ?? [command, ...args].map(quote).join(" ");
  say(
    `$ ${envNames.map((name) => `${name}=<set>`).join(" ")}${envNames.length > 0 ? " " : ""}${shown}`,
  );
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...options.env },
    input: options.stdin,
    stdio: [
      options.stdin === undefined ? "inherit" : "pipe",
      options.capture === true ? "pipe" : "inherit",
      "inherit",
    ],
    encoding: "utf8",
  });
  if (result.error !== undefined) {
    throw new StepError(`${command} couldn't start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    if (options.capture === true && result.stdout !== "") {
      say(result.stdout);
    }
    throw new StepError(
      `\`${shown}\` exited with code ${String(result.status)}. Its output is in this step.`,
    );
  }
  return options.capture === true ? result.stdout : "";
}

/** Runs a command without printing it, and returns its standard output, for the probes. */
export function read(cwd: string, command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited with code ${String(result.status)}: ${result.stderr}`,
    );
  }
  return result.stdout;
}

/**
 * Writes `contents` to a file in a new temporary directory outside the repository, readable only
 * by its owner, calls `use` with its path, and deletes the directory afterward, even on failure.
 * Use it for commands that read secrets from a file, such as `wrangler secret bulk`.
 */
export function withSecretFile<T>(name: string, contents: string, use: (file: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), "setup-secrets-"));
  const file = path.join(dir, name);
  try {
    writeFileSync(file, contents, { mode: 0o600 });
    return use(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

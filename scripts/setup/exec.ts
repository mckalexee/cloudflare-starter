// Runs commands and HTTP requests for the probes and the steps. Every outside effect goes through
// `tools()`, so the tests can swap in fakes. A step prints each command before it runs, with names
// only: a secret value never appears in the printed line or in the arguments, because it travels
// on standard input or in a temporary file outside the repository. A command that fails stops the
// step with its exit code, and its output is already on the screen.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Thrown when a step can't finish. The message says what failed and what to do next. */
export class StepError extends Error {
  override readonly name = "StepError";
}

/** The result of a command. */
export type ExecResult = { status: number; stdout: string; stderr: string };

/** Options for a command. */
export type ExecOptions = {
  cwd: string;
  /** Extra environment variables. */
  env?: Record<string, string>;
  /** Text for standard input, such as a secret value. */
  stdin?: string;
  /** Show the command's output as it runs instead of capturing it. */
  inherit?: boolean;
};

/** An HTTP request. Redirects are never followed. */
export type HttpRequest = {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
};

/** An HTTP response, or status 0 with the error in `body` when the request failed. */
export type HttpResponse = { status: number; headers: Record<string, string>; body: string };

/** The outside world, as the setup script sees it. */
export type Tools = {
  exec: (command: string, args: string[], options: ExecOptions) => ExecResult;
  http: (request: HttpRequest) => HttpResponse;
};

// Runs `fetch` in a child process, so the probes stay synchronous. The request travels on standard
// input, so a token in a header never appears in the process arguments.
const FETCH_SCRIPT = `
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
try {
  const response = await fetch(request.url, {
    method: request.method ?? "GET",
    headers: request.headers,
    body: request.body,
    redirect: "manual",
    signal: AbortSignal.timeout(30000),
  });
  const headers = Object.fromEntries(response.headers);
  process.stdout.write(JSON.stringify({ status: response.status, headers, body: await response.text() }));
} catch (error) {
  process.stdout.write(JSON.stringify({ status: 0, headers: {}, body: String(error) }));
}
`;

const REAL_TOOLS: Tools = {
  exec: (command, args, options) => {
    const result = spawnSync(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      input: options.stdin,
      stdio: [
        options.stdin === undefined ? (options.inherit === true ? "inherit" : "ignore") : "pipe",
        options.inherit === true ? "inherit" : "pipe",
        options.inherit === true ? "inherit" : "pipe",
      ],
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error !== undefined) {
      return { status: 127, stdout: "", stderr: result.error.message };
    }
    return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  },
  http: (request) => {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", FETCH_SCRIPT], {
      input: JSON.stringify(request),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    try {
      const parsed: unknown = JSON.parse(result.stdout);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "status" in parsed &&
        typeof parsed.status === "number" &&
        "body" in parsed &&
        typeof parsed.body === "string" &&
        "headers" in parsed &&
        typeof parsed.headers === "object" &&
        parsed.headers !== null
      ) {
        const headers = Object.fromEntries(
          Object.entries(parsed.headers).map(([name, value]) => [name, String(value)]),
        );
        return { status: parsed.status, headers, body: parsed.body };
      }
    } catch {
      // The child failed before it printed a response.
    }
    return { status: 0, headers: {}, body: result.stderr };
  },
};

let current: Tools = REAL_TOOLS;

/** The tools that probes and steps use. */
export function tools(): Tools {
  return current;
}

/** Swaps the tools, for tests. Returns a function that restores the earlier ones. */
export function useTools(replacement: Tools): () => void {
  const previous = current;
  current = replacement;
  return () => {
    current = previous;
  };
}

/** The real tools, so a fake can pass some commands through. */
export function realTools(): Tools {
  return REAL_TOOLS;
}

/** Prints lines of the step's log. */
export function say(...lines: string[]): void {
  for (const line of lines) {
    console.log(line);
  }
}

/** Options for a printed command. */
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
  say(`$ ${envNames.map((name) => `${name}=<set> `).join("")}${shown}`);
  const result = tools().exec(command, args, {
    cwd,
    env: options.env,
    stdin: options.stdin,
    inherit: options.capture !== true,
  });
  if (result.status !== 0) {
    if (options.capture === true) {
      say(...[result.stdout, result.stderr].filter((text) => text.trim() !== ""));
    }
    throw new StepError(
      `\`${shown}\` exited with code ${String(result.status)}. Its output is in this step.`,
    );
  }
  return options.capture === true ? result.stdout : "";
}

/** Runs a local command without printing it, and returns its standard output. */
export function read(cwd: string, command: string, args: string[]): string {
  const result = REAL_TOOLS.exec(command, args, { cwd });
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

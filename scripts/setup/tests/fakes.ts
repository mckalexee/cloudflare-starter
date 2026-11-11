// Fake commands and HTTP for the remote tests. A fake records every call with its arguments,
// standard input, and environment, answers from the handlers that a test gives, and passes Git
// and Node through to the real tools, so steps that commit or run `prune.ts` still work.
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  realTools,
  useTools,
  type ExecOptions,
  type ExecResult,
  type HttpRequest,
  type HttpResponse,
} from "../exec.ts";
import type { Context } from "../types.ts";
import { freshContext, type WorldOptions } from "./world.ts";

/** One recorded command. */
export type Call = {
  command: string;
  args: string[];
  stdin: string | undefined;
  env: Record<string, string>;
  /** The contents of the files that the arguments name, read while the command ran. */
  files: Record<string, string>;
};

/** A handler answers a command, or returns `undefined` to let the next handler try. */
export type ExecHandler = (call: Call) => Partial<ExecResult> | undefined;

/** A handler answers an HTTP request, or returns `undefined` to let the next handler try. */
export type HttpHandler = (request: HttpRequest) => Partial<HttpResponse> | undefined;

/** What a fake recorded. */
export type Recorder = {
  calls: Call[];
  requests: HttpRequest[];
  printed: string[];
  restore: () => void;
};

const PASS_THROUGH = new Set(["git", process.execPath]);

/**
 * Installs fake tools and captures `console.log`. A command without a handler succeeds with no
 * output. Call `restore()` in a `finally` block.
 */
export function fake(exec: ExecHandler[] = [], http: HttpHandler[] = []): Recorder {
  const recorder: Recorder = { calls: [], requests: [], printed: [], restore: () => undefined };
  const undoTools = useTools({
    exec: (command: string, args: string[], options: ExecOptions) => {
      const files: Record<string, string> = {};
      for (const arg of args) {
        if (path.isAbsolute(arg) && existsSync(arg) && statSync(arg).isFile()) {
          files[arg] = readFileSync(arg, "utf8");
        }
      }
      const call: Call = { command, args, stdin: options.stdin, env: options.env ?? {}, files };
      if (PASS_THROUGH.has(command) && !(command === "git" && args[0] === "push")) {
        return realTools().exec(command, args, { ...options, inherit: false });
      }
      recorder.calls.push(call);
      for (const handler of exec) {
        const result = handler(call);
        if (result !== undefined) {
          return { status: 0, stdout: "", stderr: "", ...result };
        }
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    http: (request: HttpRequest) => {
      recorder.requests.push(request);
      for (const handler of http) {
        const result = handler(request);
        if (result !== undefined) {
          return { status: 200, headers: {}, body: "", ...result };
        }
      }
      return { status: 404, headers: {}, body: "" };
    },
  });
  const log = console.log;
  console.log = (...parts: unknown[]) => {
    recorder.printed.push(parts.map(String).join(" "));
  };
  recorder.restore = () => {
    console.log = log;
    undoTools();
  };
  return recorder;
}

/** A context whose repository is a real temporary folder with `.dev.vars` and a token file. */
export function contextWithFiles(
  answers: Record<string, string>,
  devVars: Record<string, string> = {},
  options: WorldOptions = {},
): Context {
  const ctx = freshContext(options);
  const root = mkdtempSync(path.join(tmpdir(), "setup-remote-test-"));
  ctx.repo.root = root;
  mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
  for (const name of ["wrangler", "cf"]) {
    writeFileSync(path.join(root, "node_modules", ".bin", name), "");
  }
  writeFileSync(
    path.join(root, ".dev.vars"),
    Object.entries(devVars)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
  );
  ctx.repo.apiTokenFile = path.join(root, "token");
  Object.assign(ctx.answers, answers);
  ctx.facts.github = { login: "octocat" };
  ctx.facts.wrangler = { accounts: [{ id: "0123456789abcdef0123456789abcdef", name: "Acme" }] };
  ctx.facts.cf = { accountIds: ["0123456789abcdef0123456789abcdef"] };
  ctx.facts.workersSubdomain = "acme";
  return ctx;
}

/** Whether a recorded command is the named Wrangler or `cf` call. */
export function isTool(call: Call, name: "wrangler" | "cf", ...args: string[]): boolean {
  return call.command.endsWith(`/${name}`) && args.every((arg, index) => call.args[index] === arg);
}

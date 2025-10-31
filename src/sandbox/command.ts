import Dockerode from "dockerode";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { finished } from "stream/promises";
import type { Writable } from "stream";
import { v4 as uuid } from "uuid";

type CommandLogEntry = {
  data: string;
  stream: "stdout" | "stderr";
};

type CommandSnapshot = {
  args: string[];
  cmd: string;
  cwd: string;
  env: Record<string, string>;
  sudo: boolean;
};

type CommandForwardTargets = {
  stderr?: Writable;
  stdout?: Writable;
};

type CommandCtorParams = {
  container: Dockerode.Container;
  exec: Dockerode.Exec;
  forward?: CommandForwardTargets;
  sandboxId: string;
  snapshot: CommandSnapshot;
};

type CommandCloneParams = CommandCtorParams & {
  exitCode: number;
  logs: CommandLogEntry[];
  pid: number | null;
};

type Abortable = {
  signal?: AbortSignal;
};

type DisposableLogStream = AsyncGenerator<CommandLogEntry, void, void> & {
  close(): void;
  [Symbol.dispose](): void;
};

type SandboxSignal = NodeJS.Signals | number;

class SandboxAbortError extends Error {
  constructor(message: string, public readonly reason?: unknown) {
    super(message);
    this.name = "SandboxAbortError";
  }
}

const LOG_EVENTS = {
  end: "exit",
  error: "error",
  log: "log",
} as const;

const DEFAULT_WAIT_POLL_MS = 250;

function normalizeSignal(signal?: SandboxSignal): string {
  if (typeof signal === "number") {
    return String(signal);
  }

  if (!signal) {
    return "SIGTERM";
  }

  return signal.toUpperCase();
}

function getModem(container: Dockerode.Container) {
  const candidate = container as Dockerode.Container & {
    modem?: {
      demuxStream(stream: NodeJS.ReadableStream, stdout: NodeJS.WritableStream, stderr: NodeJS.WritableStream): void;
    };
  };

  if (!candidate.modem) {
    throw new Error("Docker modem is not available on the container instance");
  }

  return candidate.modem;
}

async function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise;
  }

  if (signal.aborted) {
    throw new SandboxAbortError("Operation aborted", signal.reason);
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new SandboxAbortError("Operation aborted", signal.reason));
    };

    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };

    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForInspect(exec: Dockerode.Exec, signal?: AbortSignal) {
  return withAbort(exec.inspect(), signal);
}

/**
 * Represents a command running inside a local sandbox container.
 *
 * @example
 * ```ts
 * const sandbox = await Sandbox.create();
 * const command = await sandbox.runCommand("node", ["--version"]);
 * console.log(await command.stdout());
 * ```
 */
export class Command {
  public exitCode: number | null = null;

  protected readonly container: Dockerode.Container;
  protected readonly eventEmitter = new EventEmitter();
  protected readonly exec: Dockerode.Exec;
  protected readonly forward?: CommandForwardTargets;
  protected readonly logsBuffer: CommandLogEntry[] = [];
  protected readonly sandboxId: string;
  protected readonly snapshot: CommandSnapshot;

  private completionPromise: Promise<void> | null = null;
  private pid: number | null = null;
  private readonly startId = uuid();
  private started = false;

  constructor(params: CommandCtorParams) {
    this.container = params.container;
    this.exec = params.exec;
    this.forward = params.forward;
    this.sandboxId = params.sandboxId;
    this.snapshot = params.snapshot;
  }

  get cmdId() {
    return this.startId;
  }

  get cwd() {
    return this.snapshot.cwd;
  }

  get startedAt() {
    return this.started ? Date.now() : 0;
  }

  /**
   * Starts streaming the command output. This method is invoked internally by the sandbox implementation.
   *
   * @internal
   */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;

    const stream = await this.exec.start({
      Detach: false,
      hijack: true,
      stdin: false,
      Tty: false,
    });

    const modem = getModem(this.container);
    const stdout = new PassThrough();
    const stderr = new PassThrough();

    modem.demuxStream(stream, stdout, stderr);

    stdout.on("data", (chunk: Buffer) => {
      this.handleLog(chunk.toString("utf8"), "stdout");
    });

    stderr.on("data", (chunk: Buffer) => {
      this.handleLog(chunk.toString("utf8"), "stderr");
    });

    this.completionPromise = this.trackCompletion(stream);
  }

  /**
   * Waits for the command to finish executing.
   *
   * @param params Optional abort configuration.
   * @returns A finished command with populated exit code and captured logs.
   */
  async wait(params?: Abortable): Promise<CommandFinished> {
    if (!this.started) {
      throw new Error("Command has not been started yet");
    }

    if (!this.completionPromise) {
      throw new Error("Command is missing completion state");
    }

    await withAbort(this.completionPromise, params?.signal);

    if (this.exitCode === null) {
      throw new Error("Command finished without an exit code");
    }

    return this.cloneFinished();
  }

  /**
   * Streams log entries for the lifetime of the command.
   *
   * @param opts Optional abort configuration.
   * @returns An async iterator that yields log entries as they become available.
   */
  logs(opts?: Abortable): DisposableLogStream {
    const abortController = new AbortController();

    if (opts?.signal) {
      if (opts.signal.aborted) {
        abortController.abort(opts.signal.reason);
      } else {
        const onAbort = () => {
          abortController.abort(opts.signal?.reason);
        };
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    const iterator = this.consumeLogs(abortController.signal);

    const stream = iterator as DisposableLogStream;

    stream.close = () => {
      abortController.abort();
    };

    stream[Symbol.dispose] = () => {
      abortController.abort();
    };

    return stream;
  }

  /**
   * Collects output for one or both streams as a UTF-8 string.
   *
   * @param stream Select which stream to read.
   * @param opts Optional abort configuration.
   */
  async output(stream: "stdout" | "stderr" | "both" = "both", opts?: Abortable): Promise<string> {
    await this.wait(opts);

    const builder: string[] = [];

    for (let index = 0; index < this.logsBuffer.length; index += 1) {
      const entry = this.logsBuffer[index];
      if (stream === "both" || entry.stream === stream) {
        builder.push(entry.data);
      }
    }

    return builder.join("");
  }

  /**
   * Reads the stdout stream once the command finishes.
   *
   * @param opts Optional abort configuration.
   */
  stdout(opts?: Abortable): Promise<string> {
    return this.output("stdout", opts);
  }

  /**
   * Reads the stderr stream once the command finishes.
   *
   * @param opts Optional abort configuration.
   */
  stderr(opts?: Abortable): Promise<string> {
    return this.output("stderr", opts);
  }

  /**
   * Sends a signal to the process running the command.
   *
   * @param signal Signal to send (defaults to SIGTERM).
   * @param opts Optional abort configuration.
   */
  async kill(signal?: SandboxSignal, opts?: { abortSignal?: AbortSignal }): Promise<void> {
    const normalizedSignal = normalizeSignal(signal);

    const inspect = await waitForInspect(this.exec, opts?.abortSignal);

    if (!inspect.Running || typeof inspect.Pid !== "number" || inspect.Pid <= 0) {
      return;
    }

    const killArgs = typeof signal === "number"
      ? ["sudo", "kill", `-${normalizedSignal}`, String(inspect.Pid)]
      : ["sudo", "kill", "-s", normalizedSignal, String(inspect.Pid)];

    const killer = await this.container.exec({
      AttachStderr: false,
      AttachStdout: false,
      Cmd: killArgs,
      Env: [],
      Privileged: true,
      User: "vercel-sandbox",
      WorkingDir: this.snapshot.cwd,
    });

    const stream = await killer.start({
      Detach: false,
      hijack: false,
      stdin: false,
      Tty: false,
    });

    await withAbort(finished(stream), opts?.abortSignal);
  }

  protected markExit(exitCode: number | null, pid: number | null): void {
    this.exitCode = exitCode;
    this.pid = pid;
    this.eventEmitter.emit(LOG_EVENTS.end);
  }

  protected cloneFinished(): CommandFinished {
    if (this.exitCode === null) {
      throw new Error("Cannot clone finished command without an exit code");
    }

    return new CommandFinished({
      container: this.container,
      exec: this.exec,
      exitCode: this.exitCode,
      forward: this.forward,
      logs: [...this.logsBuffer],
      pid: this.pid,
      sandboxId: this.sandboxId,
      snapshot: this.snapshot,
    });
  }

  private async *consumeLogs(signal: AbortSignal): AsyncGenerator<CommandLogEntry, void, void> {
    let offset = 0;

    while (offset < this.logsBuffer.length) {
      yield this.logsBuffer[offset];
      offset += 1;
    }

    while (true) {
      const next = await this.waitForNextLog(signal);

      if (!next) {
        return;
      }

      yield next;
      offset += 1;
    }
  }

  private async waitForNextLog(signal: AbortSignal): Promise<CommandLogEntry | null> {
    if (signal.aborted) {
      throw new SandboxAbortError("Log streaming aborted", signal.reason);
    }

    return new Promise<CommandLogEntry | null>((resolve, reject) => {
      const onLog = (entry: CommandLogEntry) => {
        cleanup();
        resolve(entry);
      };

      const onEnd = () => {
        cleanup();
        resolve(null);
      };

      const onError = (error: unknown) => {
        cleanup();
        reject(error);
      };

      const onAbort = () => {
        cleanup();
        reject(new SandboxAbortError("Log streaming aborted", signal.reason));
      };

      const cleanup = () => {
        this.eventEmitter.off(LOG_EVENTS.log, onLog);
        this.eventEmitter.off(LOG_EVENTS.end, onEnd);
        this.eventEmitter.off(LOG_EVENTS.error, onError);
        signal.removeEventListener("abort", onAbort);
      };

      this.eventEmitter.on(LOG_EVENTS.log, onLog);
      this.eventEmitter.once(LOG_EVENTS.end, onEnd);
      this.eventEmitter.once(LOG_EVENTS.error, onError);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private handleLog(data: string, stream: "stdout" | "stderr"): void {
    const entry: CommandLogEntry = { data, stream };
    this.logsBuffer.push(entry);

    if (stream === "stdout" && this.forward?.stdout) {
      this.forward.stdout.write(data);
    }

    if (stream === "stderr" && this.forward?.stderr) {
      this.forward.stderr.write(data);
    }

    this.eventEmitter.emit(LOG_EVENTS.log, entry);
  }

  private async trackCompletion(stream: NodeJS.ReadableStream): Promise<void> {
    try {
      await finished(stream);
    } catch (error) {
      this.eventEmitter.emit(LOG_EVENTS.error, error);
      throw error;
    } finally {
      await this.updateExitState();
    }
  }

  private async updateExitState(): Promise<void> {
    let attempt = 0;

    while (attempt < 5) {
      try {
        const inspect = await this.exec.inspect();
        const exit = typeof inspect.ExitCode === "number" ? inspect.ExitCode : null;
        const pid = typeof inspect.Pid === "number" ? inspect.Pid : null;
        this.markExit(exit, pid);
        return;
      } catch (error) {
        attempt += 1;
        if (attempt >= 5) {
          this.eventEmitter.emit(LOG_EVENTS.error, error);
          this.markExit(null, null);
          return;
        }

        await new Promise((resolve) => {
          setTimeout(resolve, DEFAULT_WAIT_POLL_MS);
        });
      }
    }
  }
}

/**
 * Represents a command that has already completed.
 *
 * @example
 * ```ts
 * const sandbox = await Sandbox.create();
 * const result = await sandbox.runCommand("node", ["--version"]);
 * console.log(result.exitCode);
 * ```
 */
export class CommandFinished extends Command {
  constructor(params: CommandCloneParams) {
    super(params);
    this.exitCode = params.exitCode;

    for (let index = 0; index < params.logs.length; index += 1) {
      this.logsBuffer.push(params.logs[index]);
    }

    this.markExit(params.exitCode, params.pid);
  }

  /**
   * Returns the finished command without waiting, since it is already completed.
   */
  override wait(): Promise<CommandFinished> {
    return Promise.resolve(this);
  }
}

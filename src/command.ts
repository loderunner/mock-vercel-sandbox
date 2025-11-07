import { Duplex, Transform } from 'node:stream';

import Docker from 'dockerode';

import type { CommandData, Signal } from './types';

type LogEntry = { data: string; stream: 'stdout' | 'stderr' };

/**
 * A command executed in a Sandbox.
 *
 * For detached commands, you can {@link wait} to get a {@link CommandFinished} instance
 * with the populated exit code. For non-detached commands, {@link Sandbox.runCommand}
 * automatically waits and returns a {@link CommandFinished} instance.
 *
 * You can iterate over command output with {@link logs}.
 */
export class Command {
  protected docker: Docker;
  protected containerId: string;
  protected cmd: CommandData;
  protected execId: string;
  public exitCode: number | null = null;

  private logBuffer: LogEntry[] = [];
  private streamStarted: boolean = false;
  private streamEnded: boolean = false;

  /**
   * ID of the command execution.
   */
  get cmdId(): string {
    return this.cmd.id;
  }

  /**
   * Current working directory of the command.
   */
  get cwd(): string {
    return this.cmd.cwd;
  }

  /**
   * Timestamp when the command started.
   */
  get startedAt(): number {
    return this.cmd.startedAt;
  }

  /**
   * Create a new Command instance.
   *
   * @param params - Object containing docker client, container ID, command data, and exec ID.
   * @param params.docker - Docker client instance.
   * @param params.containerId - The ID of the container where the command is running.
   * @param params.cmd - Command metadata.
   * @param params.execId - Docker exec instance ID.
   */
  constructor({
    docker,
    containerId,
    cmd,
    execId,
  }: {
    docker: Docker;
    containerId: string;
    cmd: CommandData;
    execId: string;
  }) {
    this.docker = docker;
    this.containerId = containerId;
    this.cmd = cmd;
    this.execId = execId;
  }

  /**
   * Internal method to start streaming and buffering logs from Docker exec.
   * This is called automatically by sandbox._runCommand and should only be called once.
   *
   * @internal
   */
  _startLogStream(stream: Duplex): void {
    if (this.streamStarted) {
      return;
    }
    this.streamStarted = true;

    const modem = this.docker.modem;

    // Create transform streams to capture stdout and stderr
    const stdout = new Transform({
      objectMode: true,
      transform: (chunk: Buffer, _encoding, callback) => {
        const entry: LogEntry = { stream: 'stdout', data: chunk.toString() };
        this.logBuffer.push(entry);
        callback(null, entry);
      },
    });

    const stderr = new Transform({
      objectMode: true,
      transform: (chunk: Buffer, _encoding, callback) => {
        const entry: LogEntry = { stream: 'stderr', data: chunk.toString() };
        this.logBuffer.push(entry);
        callback(null, entry);
      },
    });

    // Use dockerode's demuxStream to separate stdout and stderr
    modem.demuxStream(stream, stdout, stderr);

    // Track when the stream ends
    stream.once('end', () => {
      this.streamEnded = true;
      stdout.end();
      stderr.end();
    });

    stream.once('error', () => {
      this.streamEnded = true;
      stdout.destroy();
      stderr.destroy();
    });
  }

  /**
   * Iterate over the output of this command.
   *
   * ```
   * for await (const log of cmd.logs()) {
   *   if (log.stream === "stdout") {
   *     process.stdout.write(log.data);
   *   } else {
   *     process.stderr.write(log.data);
   *   }
   * }
   * ```
   *
   * @param opts - Optional parameters.
   * @param opts.signal - An AbortSignal to cancel log streaming.
   * @returns An async iterable of log entries from the command output.
   */
  logs(opts?: {
    signal?: AbortSignal;
  }): AsyncGenerator<
    { data: string; stream: 'stdout' | 'stderr' },
    void,
    void
  > &
    Disposable & { close: () => void } {
    let cancelled = false;
    let abortHandler: (() => void) | null = null;

    const close = () => {
      cancelled = true;
      if (abortHandler && opts?.signal) {
        opts.signal.removeEventListener('abort', abortHandler);
        abortHandler = null;
      }
    };

    const logBuffer = this.logBuffer;
    const getStreamEnded = () => this.streamEnded;

    const generator = (async function* () {
      try {
        // Set up abort handler
        if (opts?.signal) {
          if (opts.signal.aborted) {
            return;
          }
          abortHandler = () => {
            cancelled = true;
          };
          opts.signal.addEventListener('abort', abortHandler, { once: true });
        }

        let lastIndex = 0;

        // Yield buffered logs and continue yielding new ones as they arrive
        while (true) {
          // Yield any new buffered logs
          while (lastIndex < logBuffer.length) {
            if (cancelled) {
              return;
            }
            yield logBuffer[lastIndex];
            lastIndex++;
          }

          // If stream has ended, we're done
          if (getStreamEnded()) {
            break;
          }

          if (cancelled) {
            return;
          }

          // Wait a bit before checking for more logs
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      } finally {
        close();
      }
    })();

    const disposable = Object.assign(generator, {
      close,
      [Symbol.dispose]: close,
    });
    return disposable;
  }

  /**
   * Wait for a command to exit and populate its exit code.
   *
   * This method is useful for detached commands where you need to wait
   * for completion. For non-detached commands, {@link Sandbox.runCommand}
   * automatically waits and returns a {@link CommandFinished} instance.
   *
   * @param params - Optional parameters.
   * @param params.signal - An AbortSignal to cancel waiting.
   * @returns A {@link CommandFinished} instance with populated exit code.
   */
  async wait(params?: { signal?: AbortSignal }): Promise<CommandFinished> {
    const exec = this.docker.getExec(this.execId);
    let inspectData = await exec.inspect({ abortSignal: params?.signal });

    if (!inspectData.Running) {
      const exitCode = inspectData.ExitCode ?? 0;
      this.exitCode = exitCode;
      return new CommandFinished({
        docker: this.docker,
        containerId: this.containerId,
        cmd: this.cmd,
        execId: this.execId,
        exitCode,
      });
    }

    while (inspectData.Running) {
      if (params?.signal?.aborted) {
        throw new Error('Aborted');
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      inspectData = await exec.inspect({ abortSignal: params?.signal });
    }

    const exitCode = inspectData.ExitCode ?? 0;
    this.exitCode = exitCode;
    return new CommandFinished({
      docker: this.docker,
      containerId: this.containerId,
      cmd: this.cmd,
      execId: this.execId,
      exitCode,
    });
  }

  /**
   * Get the output of `stdout`, `stderr`, or both as a string.
   *
   * NOTE: This may throw string conversion errors if the command does
   * not output valid Unicode.
   *
   * @param stream - The output stream to read: "stdout", "stderr", or "both".
   * @param opts - Optional parameters.
   * @param opts.signal - An AbortSignal to cancel output streaming.
   * @returns The output of the specified stream(s) as a string.
   */
  async output(
    stream: 'stdout' | 'stderr' | 'both' = 'both',
    opts?: { signal?: AbortSignal },
  ): Promise<string> {
    let output = '';

    for await (const log of this.logs(opts)) {
      if (stream === 'both' || stream === log.stream) {
        output += log.data;
      }
    }

    return output;
  }

  /**
   * Get the output of `stdout` as a string.
   *
   * NOTE: This may throw string conversion errors if the command does
   * not output valid Unicode.
   *
   * @param opts - Optional parameters.
   * @param opts.signal - An AbortSignal to cancel output streaming.
   * @returns The standard output of the command.
   */
  async stdout(opts?: { signal?: AbortSignal }): Promise<string> {
    return this.output('stdout', opts);
  }

  /**
   * Get the output of `stderr` as a string.
   *
   * NOTE: This may throw string conversion errors if the command does
   * not output valid Unicode.
   *
   * @param opts - Optional parameters.
   * @param opts.signal - An AbortSignal to cancel output streaming.
   * @returns The standard error output of the command.
   */
  async stderr(opts?: { signal?: AbortSignal }): Promise<string> {
    return this.output('stderr', opts);
  }

  /**
   * Kill a running command in a sandbox.
   *
   * @param signal - The signal to send the running process. Defaults to SIGTERM.
   * @param opts - Optional parameters.
   * @param opts.abortSignal - An AbortSignal to cancel the kill operation.
   * @returns Promise<void>.
   */
  async kill(
    signal: Signal = 'SIGTERM',
    opts?: { abortSignal?: AbortSignal },
  ): Promise<void> {
    // Get the PID from the exec instance
    const exec = this.docker.getExec(this.execId);
    const inspectData = await exec.inspect({ abortSignal: opts?.abortSignal });

    if (!inspectData.Running || !inspectData.Pid) {
      return;
    }

    // Send kill signal to the process
    const container = this.docker.getContainer(this.containerId);
    await container.exec({
      Cmd: ['kill', `-${signal}`, String(inspectData.Pid)],
      AttachStdout: false,
      AttachStderr: false,
      abortSignal: opts?.abortSignal,
    });
  }
}

/**
 * A command that has finished executing.
 *
 * The exit code is immediately available and populated upon creation.
 * Unlike {@link Command}, you don't need to call wait() - the command
 * has already completed execution.
 */
export class CommandFinished extends Command {
  /**
   * The exit code of the command. This is always populated for
   * CommandFinished instances.
   */
  public exitCode: number;

  /**
   * Create a new CommandFinished instance.
   *
   * @param params - Object containing client, container ID, command data, exec ID, and exit code.
   * @param params.docker - Docker client instance.
   * @param params.containerId - The ID of the container where the command ran.
   * @param params.cmd - Command metadata.
   * @param params.execId - Docker exec instance ID.
   * @param params.exitCode - The exit code of the completed command.
   */
  constructor(params: {
    docker: Docker;
    containerId: string;
    cmd: CommandData;
    execId: string;
    exitCode: number;
  }) {
    super(params);
    this.exitCode = params.exitCode;
  }

  /**
   * The wait method is not needed for CommandFinished instances since
   * the command has already completed and exitCode is populated.
   *
   * @deprecated This method is redundant for CommandFinished instances.
   * The exitCode is already available.
   * @returns This CommandFinished instance.
   */
  async wait(): Promise<CommandFinished> {
    return this;
  }
}

import Docker from "dockerode";
import type { CommandData, Signal } from "./types.js";

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
    { data: string; stream: "stdout" | "stderr" },
    void,
    void
  > & { close: () => void } {
    const exec = this.docker.getExec(this.execId);
    
    let stream: any;
    const close = () => {
      if (stream && typeof stream.destroy === "function") {
        stream.destroy();
      }
    };

    const generator = (async function* () {
      stream = await exec.start({ hijack: true, stdin: false });

      if (opts?.signal) {
        opts.signal.addEventListener("abort", close);
      }

      try {
        for await (const chunk of stream as any) {
          if (opts?.signal?.aborted) {
            break;
          }

          // Docker multiplexes stdout/stderr in its stream format
          // Header format: [stream_type, 0, 0, 0, size1, size2, size3, size4, ...data]
          const buffer = Buffer.from(chunk);
          
          for (let i = 0; i < buffer.length; ) {
            if (buffer.length - i < 8) {
              break;
            }

            const header = buffer.subarray(i, i + 8);
            const streamType = header[0];
            const size =
              (header[4] << 24) |
              (header[5] << 16) |
              (header[6] << 8) |
              header[7];

            if (buffer.length - i < 8 + size) {
              break;
            }

            const data = buffer.subarray(i + 8, i + 8 + size).toString("utf-8");
            const streamName = streamType === 1 ? "stdout" : "stderr";

            yield { data, stream: streamName };

            i += 8 + size;
          }
        }
      } finally {
        close();
      }
    })() as AsyncGenerator<
      { data: string; stream: "stdout" | "stderr" },
      void,
      void
    > & { close: () => void };

    generator.close = close;
    return generator;
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
    const inspectData = await exec.inspect();

    if (!inspectData.Running) {
      this.exitCode = inspectData.ExitCode ?? 0;
      return new CommandFinished({
        docker: this.docker,
        containerId: this.containerId,
        cmd: this.cmd,
        execId: this.execId,
        exitCode: this.exitCode,
      });
    }

    // Poll until command finishes
    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(async () => {
        try {
          if (params?.signal?.aborted) {
            clearInterval(checkInterval);
            reject(new Error("Aborted"));
            return;
          }

          const data = await exec.inspect();
          if (!data.Running) {
            clearInterval(checkInterval);
            this.exitCode = data.ExitCode ?? 0;
            resolve(
              new CommandFinished({
                docker: this.docker,
                containerId: this.containerId,
                cmd: this.cmd,
                execId: this.execId,
                exitCode: this.exitCode,
              })
            );
          }
        } catch (err) {
          clearInterval(checkInterval);
          reject(err);
        }
      }, 100);

      if (params?.signal) {
        params.signal.addEventListener("abort", () => {
          clearInterval(checkInterval);
          reject(new Error("Aborted"));
        });
      }
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
    stream: "stdout" | "stderr" | "both" = "both",
    opts?: { signal?: AbortSignal }
  ): Promise<string> {
    let output = "";

    for await (const log of this.logs(opts)) {
      if (stream === "both" || stream === log.stream) {
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
    return this.output("stdout", opts);
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
    return this.output("stderr", opts);
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
    signal: Signal = "SIGTERM",
    opts?: { abortSignal?: AbortSignal }
  ): Promise<void> {
    // Get the PID from the exec instance
    const exec = this.docker.getExec(this.execId);
    const inspectData = await exec.inspect();

    if (!inspectData.Running || !inspectData.Pid) {
      return;
    }

    // Send kill signal to the process
    const container = this.docker.getContainer(this.containerId);
    await container.exec({
      Cmd: ["kill", `-${signal}`, String(inspectData.Pid)],
      AttachStdout: false,
      AttachStderr: false,
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

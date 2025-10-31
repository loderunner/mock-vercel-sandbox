import Docker from "dockerode";
import type { Writable } from "stream";
import { Readable, Writable as WritableStream } from "stream";
import { Command, CommandFinished } from "./command.js";
import type {
  SandboxMetaData,
  SandboxRouteData,
  SandboxRuntime,
  SandboxStatus,
  Credentials,
  WithPrivate,
  CommandData,
} from "./types.js";

/**
 * Parameters for creating a sandbox
 */
export type CreateSandboxParams = {
  /**
   * The source of the sandbox.
   *
   * Omit this parameter start a sandbox without a source.
   *
   * For git sources:
   * - `depth`: Creates shallow clones with limited commit history (minimum: 1)
   * - `revision`: Clones and checks out a specific commit, branch, or tag
   */
  source?:
    | {
        type: "git";
        url: string;
        depth?: number;
        revision?: string;
      }
    | {
        type: "git";
        url: string;
        username: string;
        password: string;
        depth?: number;
        revision?: string;
      }
    | {
        type: "tarball";
        url: string;
      };
  /**
   * Array of port numbers to expose from the sandbox. Sandboxes can
   * expose up to 4 ports.
   */
  ports?: number[];
  /**
   * Timeout in milliseconds before the sandbox auto-terminates.
   */
  timeout?: number;
  /**
   * Resources to allocate to the sandbox.
   *
   * Your sandbox will get the amount of vCPUs you specify here and
   * 2048 MB of memory per vCPU.
   */
  resources?: {
    vcpus: number;
  };
  /**
   * The runtime of the sandbox, currently only `node22` and `python3.13` are supported.
   * If not specified, the default runtime `node22` will be used.
   */
  runtime?: SandboxRuntime;
  /**
   * An AbortSignal to cancel sandbox creation.
   */
  signal?: AbortSignal;
};

type GetSandboxParams = {
  /**
   * Unique identifier of the sandbox.
   */
  sandboxId: string;
  /**
   * An AbortSignal to cancel the operation.
   */
  signal?: AbortSignal;
};

type RunCommandParams = {
  /**
   * The command to execute
   */
  cmd: string;
  /**
   * Arguments to pass to the command
   */
  args?: string[];
  /**
   * Working directory to execute the command in
   */
  cwd?: string;
  /**
   * Environment variables to set for this command
   */
  env?: Record<string, string>;
  /**
   * If true, execute this command with root privileges. Defaults to false.
   */
  sudo?: boolean;
  /**
   * If true, the command will return without waiting for `exitCode`
   */
  detached?: boolean;
  /**
   * A `Writable` stream where `stdout` from the command will be piped
   */
  stdout?: Writable;
  /**
   * A `Writable` stream where `stderr` from the command will be piped
   */
  stderr?: Writable;
  /**
   * An AbortSignal to cancel the command execution
   */
  signal?: AbortSignal;
};

/**
 * Docker client wrapper for managing containers
 */
class DockerManager {
  private docker: Docker;
  private imageTag = "mock-vercel-sandbox";
  private imageBuilt = false;

  constructor() {
    this.docker = new Docker();
  }

  /**
   * Build the Docker image if not already built
   */
  async ensureImage(): Promise<void> {
    if (this.imageBuilt) {
      return;
    }

    try {
      await this.docker.getImage(this.imageTag).inspect();
      this.imageBuilt = true;
      return;
    } catch {
      // Image doesn't exist, need to build it
    }

    return new Promise((resolve, reject) => {
      // Find Dockerfile in the project root (where package.json is)
      // Try to find it relative to common locations
      const dockerfilePath = process.cwd();
      this.docker.buildImage(
        {
          context: dockerfilePath,
          src: ["Dockerfile"],
        },
        {
          t: this.imageTag,
        },
        (err, stream) => {
          if (err) {
            reject(err);
            return;
          }

          if (!stream) {
            reject(new Error("No build stream"));
            return;
          }

          // Consume the stream to wait for build completion
          this.docker.modem.followProgress(stream, (err, output) => {
            if (err) {
              reject(err);
            } else {
              this.imageBuilt = true;
              resolve();
            }
          });
        }
      );
    });
  }

  /**
   * Create a new container
   */
  async createContainer(sandboxId: string, runtime: string): Promise<Docker.Container> {
    await this.ensureImage();

    const container = await this.docker.createContainer({
      Image: this.imageTag,
      name: `mock-sandbox-${sandboxId}`,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      OpenStdin: true,
      StdinOnce: false,
      Env: [`RUNTIME=${runtime}`],
      User: "vercel-sandbox",
      WorkingDir: "/home/vercel-sandbox",
    });

    return container;
  }

  /**
   * Start a container
   */
  async startContainer(container: Docker.Container): Promise<void> {
    await container.start();
  }

  /**
   * Stop a container
   */
  async stopContainer(container: Docker.Container): Promise<void> {
    await container.stop();
  }

  /**
   * Remove a container
   */
  async removeContainer(container: Docker.Container): Promise<void> {
    await container.remove({ force: true });
  }

  /**
   * Get a container by name
   */
  async getContainer(sandboxId: string): Promise<Docker.Container | null> {
    try {
      const container = this.docker.getContainer(`mock-sandbox-${sandboxId}`);
      await container.inspect();
      return container;
    } catch {
      return null;
    }
  }

  /**
   * Execute a command in a container
   */
  async execCommand(
    container: Docker.Container,
    options: {
      cmd: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
      sudo?: boolean;
    }
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const exec = await container.exec({
      Cmd: options.sudo
        ? ["sudo", options.cmd, ...(options.args || [])]
        : [options.cmd, ...(options.args || [])],
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: options.cwd || "/home/vercel-sandbox",
      Env: Object.entries(options.env || {}).map(([k, v]) => `${k}=${v}`),
    });

    return new Promise((resolve, reject) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      const stdoutStream = new WritableStream({
        write(chunk, encoding, callback) {
          stdoutChunks.push(Buffer.from(chunk));
          callback();
        },
      });

      const stderrStream = new WritableStream({
        write(chunk, encoding, callback) {
          stderrChunks.push(Buffer.from(chunk));
          callback();
        },
      });

      exec.start({ hijack: true, stdin: false }, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }

        if (!stream) {
          reject(new Error("No exec stream"));
          return;
        }

        // Use dockerode's modem to demux stdout and stderr
        const modem = this.docker.modem;
        modem.demuxStream(stream, stdoutStream, stderrStream);

        stream.on("end", async () => {
          const stdout = Buffer.concat(stdoutChunks).toString();
          const stderr = Buffer.concat(stderrChunks).toString();
          const inspect = await exec.inspect();
          resolve({
            stdout,
            stderr,
            exitCode: inspect.ExitCode || 0,
          });
        });

        stream.on("error", (err) => {
          reject(err);
        });
      });
    });
  }
}

// Singleton Docker manager
const dockerManager = new DockerManager();

/**
 * A Sandbox is an isolated Linux MicroVM to run commands in.
 *
 * Use {@link Sandbox.create} or {@link Sandbox.get} to construct.
 */
export class Sandbox {
  private sandbox: SandboxMetaData;
  private container: Docker.Container | null = null;

  /**
   * Routes from ports to subdomains.
   */
  readonly routes: SandboxRouteData[];

  /**
   * Create a new sandbox.
   *
   * @param params - Creation parameters and optional credentials.
   * @returns A promise resolving to the created {@link Sandbox}.
   */
  static async create(
    params?: WithPrivate<CreateSandboxParams | (CreateSandboxParams & Credentials)>
  ): Promise<Sandbox> {
    const p = params || {};
    const sandboxId = `sandbox-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const runtime = p.runtime || "node22";
    const timeout = p.timeout || 3600000; // 1 hour default
    const vcpus = p.resources?.vcpus || 1;
    const memory = vcpus * 2048;

    // Create container
    const container = await dockerManager.createContainer(sandboxId, runtime);
    await dockerManager.startContainer(container);

    // Generate routes for ports
    const routes: SandboxRouteData[] =
      p.ports?.map((port, idx) => ({
        port,
        subdomain: `sandbox-${sandboxId.substring(0, 8)}-${idx}`,
      })) || [];

    const sandbox: SandboxMetaData = {
      id: sandboxId,
      status: "running",
      timeout,
      cwd: "/home/vercel-sandbox",
      memory,
      vcpus,
      runtime,
      requestedAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: Date.now(),
    };

    // Handle source if provided
    if (p.source) {
      // In a real implementation, we would clone the source into the container
      // For now, we'll skip this in the mock
    }

    return new Sandbox({
      sandbox,
      routes,
      container,
    });
  }

  /**
   * Retrieve an existing sandbox.
   *
   * @param params - Get parameters and optional credentials.
   * @returns A promise resolving to the {@link Sandbox}.
   */
  static async get(
    params: GetSandboxParams | (GetSandboxParams & Credentials)
  ): Promise<Sandbox> {
    const container = await dockerManager.getContainer(params.sandboxId);
    if (!container) {
      throw new Error(`Sandbox ${params.sandboxId} not found`);
    }

    const inspect = await container.inspect();
    const sandbox: SandboxMetaData = {
      id: params.sandboxId,
      status: inspect.State?.Running ? "running" : "stopped",
      timeout: 3600000,
      cwd: "/home/vercel-sandbox",
      memory: 2048,
      vcpus: 1,
      runtime: "node22",
      requestedAt: new Date(inspect.Created).getTime(),
      createdAt: new Date(inspect.Created).getTime(),
      updatedAt: Date.now(),
    };

    return new Sandbox({
      sandbox,
      routes: [],
      container,
    });
  }

  /**
   * Allow to get a list of sandboxes for a team narrowed to the given params.
   */
  static async list(
    params: { limit?: number; offset?: number } & Partial<Credentials>
  ): Promise<{
    sandboxes: SandboxMetaData[];
    pagination: {
      count: number;
      next: number | null;
      prev: number | null;
    };
  }> {
    // In mock implementation, we don't track sandboxes globally
    // Return empty list
    return {
      sandboxes: [],
      pagination: {
        count: 0,
        next: null,
        prev: null,
      },
    };
  }

  private constructor({
    sandbox,
    routes,
    container,
  }: {
    sandbox: SandboxMetaData;
    routes: SandboxRouteData[];
    container: Docker.Container | null;
  }) {
    this.sandbox = sandbox;
    this.routes = routes;
    this.container = container;
  }

  /**
   * Unique ID of this sandbox.
   */
  get sandboxId(): string {
    return this.sandbox.id;
  }

  /**
   * The status of the sandbox.
   */
  get status(): SandboxStatus {
    return this.sandbox.status;
  }

  /**
   * The timeout of the sandbox in milliseconds.
   */
  get timeout(): number {
    return this.sandbox.timeout;
  }

  /**
   * Get a previously run command by its ID.
   *
   * @param cmdId - ID of the command to retrieve
   * @param opts - Optional parameters.
   * @param opts.signal - An AbortSignal to cancel the operation.
   * @returns A {@link Command} instance representing the command
   */
  async getCommand(
    cmdId: string,
    opts?: { signal?: AbortSignal }
  ): Promise<Command> {
    if (opts?.signal?.aborted) {
      throw new Error("Operation aborted");
    }

    // In mock implementation, we don't track commands by ID
    // Return a command with the given ID
    const cmd: CommandData = {
      id: cmdId,
      cwd: this.sandbox.cwd,
      startedAt: Date.now(),
      exitCode: null,
    };

    return new Command({ sandboxId: this.sandboxId, cmd });
  }

  /**
   * Internal helper to start a command in the sandbox.
   *
   * @param params - Command execution parameters.
   * @returns A {@link Command} or {@link CommandFinished}, depending on `detached`.
   */
  async _runCommand(params: RunCommandParams): Promise<Command | CommandFinished> {
    if (!this.container) {
      throw new Error("Sandbox container not available");
    }

    if (params.signal?.aborted) {
      throw new Error("Operation aborted");
    }

    const cmdId = `cmd-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const cmd: CommandData = {
      id: cmdId,
      cwd: params.cwd || this.sandbox.cwd,
      startedAt: Date.now(),
      exitCode: null,
    };

    if (params.detached) {
      // Start command in background
      // In real implementation, this would start the command without waiting
      return new Command({ sandboxId: this.sandboxId, cmd });
    }

    // Execute command and wait for completion
    const result = await dockerManager.execCommand(this.container, {
      cmd: params.cmd,
      args: params.args,
      cwd: params.cwd,
      env: params.env,
      sudo: params.sudo,
    });

    // Pipe output if streams provided
    if (params.stdout) {
      params.stdout.write(result.stdout);
    }
    if (params.stderr) {
      params.stderr.write(result.stderr);
    }

    cmd.exitCode = result.exitCode;

    return new CommandFinished({
      sandboxId: this.sandboxId,
      cmd,
      exitCode: result.exitCode,
    });
  }

  /**
   * Start executing a command in this sandbox.
   *
   * @param command - The command to execute.
   * @param args - Arguments to pass to the command.
   * @param opts - Optional parameters.
   * @param opts.signal - An AbortSignal to cancel the command execution.
   * @returns A {@link CommandFinished} result once execution is done.
   */
  async runCommand(
    command: string,
    args?: string[],
    opts?: { signal?: AbortSignal }
  ): Promise<CommandFinished>;

  /**
   * Start executing a command in detached mode.
   *
   * @param params - The command parameters.
   * @returns A {@link Command} instance for the running command.
   */
  async runCommand(params: RunCommandParams & { detached: true }): Promise<Command>;

  /**
   * Start executing a command in this sandbox.
   *
   * @param params - The command parameters.
   * @returns A {@link CommandFinished} result once execution is done.
   */
  async runCommand(params: RunCommandParams): Promise<CommandFinished>;

  async runCommand(
    commandOrParams: string | RunCommandParams,
    args?: string[],
    opts?: { signal?: AbortSignal }
  ): Promise<Command | CommandFinished> {
    if (typeof commandOrParams === "string") {
      return this._runCommand({
        cmd: commandOrParams,
        args,
        signal: opts?.signal,
      });
    }

    return this._runCommand(commandOrParams);
  }

  /**
   * Create a directory in the filesystem of this sandbox.
   *
   * @param path - Path of the directory to create
   * @param opts - Optional parameters.
   * @param opts.signal - An AbortSignal to cancel the operation.
   */
  async mkDir(path: string, opts?: { signal?: AbortSignal }): Promise<void> {
    if (opts?.signal?.aborted) {
      throw new Error("Operation aborted");
    }

    if (!this.container) {
      throw new Error("Sandbox container not available");
    }

    await dockerManager.execCommand(this.container, {
      cmd: "mkdir",
      args: ["-p", path],
    });
  }

  /**
   * Read a file from the filesystem of this sandbox.
   *
   * @param file - File to read, with path and optional cwd
   * @param opts - Optional parameters.
   * @param opts.signal - An AbortSignal to cancel the operation.
   * @returns A promise that resolves to a ReadableStream containing the file contents
   */
  async readFile(
    file: { path: string; cwd?: string },
    opts?: { signal?: AbortSignal }
  ): Promise<NodeJS.ReadableStream | null> {
    if (opts?.signal?.aborted) {
      throw new Error("Operation aborted");
    }

    if (!this.container) {
      throw new Error("Sandbox container not available");
    }

    // In mock implementation, read file from container
    const result = await dockerManager.execCommand(this.container, {
      cmd: "cat",
      args: [file.path],
      cwd: file.cwd,
    });

    // Convert string to ReadableStream
    return Readable.from([result.stdout]);
  }

  /**
   * Write files to the filesystem of this sandbox.
   * Defaults to writing to /vercel/sandbox unless an absolute path is specified.
   * Writes files using the `vercel-sandbox` user.
   *
   * @param files - Array of files with path and stream/buffer contents
   * @param opts - Optional parameters.
   * @param opts.signal - An AbortSignal to cancel the operation.
   * @returns A promise that resolves when the files are written
   */
  async writeFiles(
    files: { path: string; content: Buffer }[],
    opts?: { signal?: AbortSignal }
  ): Promise<void> {
    if (opts?.signal?.aborted) {
      throw new Error("Operation aborted");
    }

    if (!this.container) {
      throw new Error("Sandbox container not available");
    }

    // Write files to container
    for (const file of files) {
      // Create directory if needed
      const dir = file.path.substring(0, file.path.lastIndexOf("/"));
      if (dir) {
        await this.mkDir(dir);
      }

      // Write file using docker exec with cat
      await dockerManager.execCommand(this.container!, {
        cmd: "sh",
        args: [
          "-c",
          `cat > "${file.path}" <<'EOF'\n${file.content.toString()}\nEOF`,
        ],
      });
    }
  }

  /**
   * Get the public domain of a port of this sandbox.
   *
   * @param p - Port number to resolve
   * @returns A full domain (e.g. `https://subdomain.vercel.run`)
   * @throws If the port has no associated route
   */
  domain(p: number): string {
    const route = this.routes.find((r) => r.port === p);
    if (!route) {
      throw new Error(`No route found for port ${p}`);
    }
    return `https://${route.subdomain}.vercel.run`;
  }

  /**
   * Stop the sandbox.
   *
   * @param opts - Optional parameters.
   * @param opts.signal - An AbortSignal to cancel the operation.
   * @returns A promise that resolves when the sandbox is stopped
   */
  async stop(opts?: { signal?: AbortSignal }): Promise<void> {
    if (opts?.signal?.aborted) {
      throw new Error("Operation aborted");
    }

    if (!this.container) {
      return;
    }

    await dockerManager.stopContainer(this.container);
    this.sandbox.status = "stopped";
    this.sandbox.stoppedAt = Date.now();
  }

  /**
   * Extend the timeout of the sandbox by the specified duration.
   *
   * This allows you to extend the lifetime of a sandbox up until the maximum
   * execution timeout for your plan.
   *
   * @param duration - The duration in milliseconds to extend the timeout by
   * @param opts - Optional parameters.
   * @param opts.signal - An AbortSignal to cancel the operation.
   * @returns A promise that resolves when the timeout is extended
   */
  async extendTimeout(
    duration: number,
    opts?: { signal?: AbortSignal }
  ): Promise<void> {
    if (opts?.signal?.aborted) {
      throw new Error("Operation aborted");
    }

    this.sandbox.timeout += duration;
    this.sandbox.updatedAt = Date.now();
  }
}

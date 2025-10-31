import Docker from "dockerode";
import { Readable, Writable } from "stream";
import { Command, CommandFinished } from "./command.js";
import type {
  CreateSandboxParams,
  GetSandboxParams,
  RunCommandParams,
  SandboxMetaData,
  SandboxRouteData,
  CommandData,
} from "./types.js";
import * as path from "path";
import * as crypto from "crypto";
import * as tar from "tar-stream";

/**
 * A Sandbox is an isolated Docker container to run commands in.
 *
 * Use {@link Sandbox.create} or {@link Sandbox.get} to construct.
 */
export class Sandbox {
  private docker: Docker;
  private containerId: string;
  private metadata: SandboxMetaData;
  private timeoutHandle?: NodeJS.Timeout;

  /**
   * Routes from ports to subdomains.
   */
  readonly routes: SandboxRouteData[];

  /**
   * Unique ID of this sandbox.
   */
  get sandboxId(): string {
    return this.metadata.id;
  }

  /**
   * The status of the sandbox.
   */
  get status(): SandboxMetaData["status"] {
    return this.metadata.status;
  }

  /**
   * The timeout of the sandbox in milliseconds.
   */
  get timeout(): number {
    return this.metadata.timeout;
  }

  /**
   * Create a new sandbox.
   *
   * @param params - Creation parameters.
   * @returns A promise resolving to the created {@link Sandbox}.
   */
  static async create(
    params: CreateSandboxParams = {}
  ): Promise<Sandbox> {
    const docker = new Docker();
    const sandboxId = `sandbox-${crypto.randomBytes(8).toString("hex")}`;
    const imageName = "mock-vercel-sandbox";

    // Check if image exists, build if not
    try {
      await docker.getImage(imageName).inspect();
    } catch (err) {
      // Image doesn't exist, build it
      const stream = await docker.buildImage(
        {
          context: process.cwd(),
          src: ["Dockerfile"],
        },
        { t: imageName }
      );

      await new Promise<void>((resolve, reject) => {
        docker.modem.followProgress(
          stream,
          (err: Error | null) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });
    }

    // Create container
    const portBindings: Record<string, Array<{ HostPort: string }>> = {};
    const exposedPorts: Record<string, {}> = {};
    const routes: SandboxRouteData[] = [];

    if (params.ports) {
      for (const port of params.ports) {
        const containerPort = `${port}/tcp`;
        exposedPorts[containerPort] = {};
        portBindings[containerPort] = [{ HostPort: String(port) }];
        routes.push({
          port,
          subdomain: `localhost:${port}`,
        });
      }
    }

    const container = await docker.createContainer({
      Image: imageName,
      name: sandboxId,
      ExposedPorts: exposedPorts,
      HostConfig: {
        PortBindings: portBindings,
        AutoRemove: true,
      },
      Labels: {
        "mock-vercel-sandbox": "true",
        sandboxId,
      },
    });

    // Start container
    await container.start();

    // Handle source if provided
    if (params.source) {
      await Sandbox._handleSource(docker, container.id, params.source);
    }

    const now = Date.now();
    const metadata: SandboxMetaData = {
      id: sandboxId,
      status: "running",
      timeout: params.timeout || 300000, // Default 5 minutes
      cwd: "/vercel/sandbox",
      memory: (params.resources?.vcpus || 1) * 2048,
      vcpus: params.resources?.vcpus || 1,
      runtime: params.runtime || "node22",
      region: "local",
      requestedAt: now,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
    };

    const sandbox = new Sandbox({
      docker,
      containerId: container.id,
      metadata,
      routes,
    });

    // Set up auto-termination timeout
    if (metadata.timeout > 0) {
      sandbox.timeoutHandle = setTimeout(() => {
        sandbox.stop().catch(console.error);
      }, metadata.timeout);
    }

    return sandbox;
  }

  /**
   * Handle source cloning/extraction.
   */
  private static async _handleSource(
    docker: Docker,
    containerId: string,
    source: CreateSandboxParams["source"]
  ): Promise<void> {
    if (!source) return;

    const container = docker.getContainer(containerId);

    if (source.type === "git") {
      const cloneCmd = ["git", "clone"];

      if (source.depth) {
        cloneCmd.push("--depth", String(source.depth));
      }

      if ("username" in source && source.username) {
        // Extract protocol and rest of URL
        const urlMatch = source.url.match(/^(https?:\/\/)(.*)/);
        if (urlMatch) {
          const [, protocol, rest] = urlMatch;
          const authenticatedUrl = `${protocol}${encodeURIComponent(source.username)}:${encodeURIComponent(source.password)}@${rest}`;
          cloneCmd.push(authenticatedUrl);
        } else {
          cloneCmd.push(source.url);
        }
      } else {
        cloneCmd.push(source.url);
      }

      cloneCmd.push("/vercel/sandbox");

      const exec = await container.exec({
        Cmd: cloneCmd,
        AttachStdout: true,
        AttachStderr: true,
        WorkingDir: "/tmp",
      });

      await exec.start({ Detach: false });

      if (source.revision) {
        const checkoutExec = await container.exec({
          Cmd: ["git", "checkout", source.revision],
          AttachStdout: true,
          AttachStderr: true,
          WorkingDir: "/vercel/sandbox",
        });

        await checkoutExec.start({ Detach: false });
      }
    } else if (source.type === "tarball") {
      // Download and extract tarball
      const response = await fetch(source.url);
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      await container.putArchive(buffer, {
        path: "/vercel/sandbox",
      });
    }
  }

  /**
   * Retrieve an existing sandbox.
   *
   * @param params - Get parameters.
   * @returns A promise resolving to the {@link Sandbox}.
   */
  static async get(params: GetSandboxParams): Promise<Sandbox> {
    const docker = new Docker();
    const containers = await docker.listContainers({
      filters: {
        label: [`sandboxId=${params.sandboxId}`],
      },
    });

    if (containers.length === 0) {
      throw new Error(`Sandbox ${params.sandboxId} not found`);
    }

    const containerInfo = containers[0];
    const container = docker.getContainer(containerInfo.Id);
    const inspectData = await container.inspect();

    // Extract metadata from labels and state
    const labels = inspectData.Config.Labels || {};
    const routes: SandboxRouteData[] = [];

    if (inspectData.NetworkSettings?.Ports) {
      for (const [containerPort, hostBindings] of Object.entries(
        inspectData.NetworkSettings.Ports
      )) {
        if (hostBindings && hostBindings.length > 0) {
          const port = parseInt(containerPort.split("/")[0]);
          const hostPort = hostBindings[0].HostPort;
          routes.push({
            port,
            subdomain: `localhost:${hostPort}`,
          });
        }
      }
    }

    const now = Date.now();
    const startedAt = inspectData.State.StartedAt
      ? new Date(inspectData.State.StartedAt).getTime()
      : now;

    const metadata: SandboxMetaData = {
      id: params.sandboxId,
      status: inspectData.State.Running ? "running" : "stopped",
      timeout: 300000,
      cwd: "/vercel/sandbox",
      memory: 2048,
      vcpus: 1,
      runtime: "node22",
      region: "local",
      requestedAt: now,
      createdAt: startedAt,
      updatedAt: now,
      startedAt,
    };

    return new Sandbox({
      docker,
      containerId: containerInfo.Id,
      metadata,
      routes,
    });
  }

  /**
   * List sandboxes.
   *
   * @param params - List parameters.
   * @returns A promise resolving to an object with sandboxes array and pagination data.
   */
  static async list(params?: {
    limit?: number;
    starting_after?: number;
  }): Promise<{
    sandboxes: Array<SandboxMetaData>;
    pagination: { count: number; next: number | null; prev: number | null };
  }> {
    const docker = new Docker();
    const containers = await docker.listContainers({
      all: true,
      filters: {
        label: ["mock-vercel-sandbox=true"],
      },
    });

    const sandboxes: SandboxMetaData[] = [];

    for (const containerInfo of containers) {
      const labels = containerInfo.Labels || {};
      const now = Date.now();
      const startedAt = containerInfo.Created * 1000;

      sandboxes.push({
        id: labels.sandboxId || containerInfo.Id,
        status: containerInfo.State === "running" ? "running" : "stopped",
        timeout: 300000,
        cwd: "/vercel/sandbox",
        memory: 2048,
        vcpus: 1,
        runtime: "node22",
        region: "local",
        requestedAt: startedAt,
        createdAt: startedAt,
        updatedAt: now,
        startedAt,
      });
    }

    return {
      sandboxes,
      pagination: {
        count: sandboxes.length,
        next: null,
        prev: null,
      },
    };
  }

  /**
   * Create a new Sandbox instance.
   *
   * @param params - Sandbox parameters.
   */
  constructor({
    docker,
    containerId,
    metadata,
    routes,
  }: {
    docker: Docker;
    containerId: string;
    metadata: SandboxMetaData;
    routes: SandboxRouteData[];
  }) {
    this.docker = docker;
    this.containerId = containerId;
    this.metadata = metadata;
    this.routes = routes;
  }

  /**
   * Get a previously run command by its ID.
   *
   * @param cmdId - ID of the command to retrieve.
   * @param opts - Optional parameters.
   * @param opts.signal - An AbortSignal to cancel the operation.
   * @returns A {@link Command} instance representing the command.
   */
  async getCommand(
    cmdId: string,
    opts?: { signal?: AbortSignal }
  ): Promise<Command> {
    // In a real implementation, this would track commands
    // For now, throw an error as we'd need to persist command metadata
    throw new Error("getCommand not implemented - command tracking not yet supported");
  }

  /**
   * Start executing a command in this sandbox.
   */
  async runCommand(command: string, args?: string[], opts?: { signal?: AbortSignal }): Promise<CommandFinished>;
  async runCommand(params: RunCommandParams & { detached: true }): Promise<Command>;
  async runCommand(params: RunCommandParams): Promise<CommandFinished>;
  async runCommand(
    commandOrParams: string | RunCommandParams,
    args?: string[],
    opts?: { signal?: AbortSignal }
  ): Promise<Command | CommandFinished> {
    let params: RunCommandParams;

    if (typeof commandOrParams === "string") {
      params = {
        cmd: commandOrParams,
        args,
        signal: opts?.signal,
      };
    } else {
      params = commandOrParams;
    }

    return this._runCommand(params);
  }

  /**
   * Internal helper to start a command in the sandbox.
   *
   * @param params - Command execution parameters.
   * @returns A {@link Command} or {@link CommandFinished}, depending on `detached`.
   */
  async _runCommand(
    params: RunCommandParams
  ): Promise<Command | CommandFinished> {
    const container = this.docker.getContainer(this.containerId);
    const cmd = [params.cmd, ...(params.args || [])];
    const cwd = params.cwd || this.metadata.cwd;

    // Build environment variables
    const env: string[] = [];
    if (params.env) {
      for (const [key, value] of Object.entries(params.env)) {
        env.push(`${key}=${value}`);
      }
    }

    // Create exec instance
    const execOptions: Docker.ExecCreateOptions = {
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: false,
      Tty: false,
      WorkingDir: cwd,
      Env: env.length > 0 ? env : undefined,
      User: params.sudo ? "root" : "vercel-sandbox",
    };

    const exec = await container.exec(execOptions);
    const cmdId = `cmd-${crypto.randomBytes(8).toString("hex")}`;
    const startedAt = Date.now();

    const cmdData: CommandData = {
      id: cmdId,
      cwd,
      startedAt,
    };

    const command = new Command({
      docker: this.docker,
      containerId: this.containerId,
      cmd: cmdData,
      execId: exec.id,
    });

    // Start execution
    const stream = await exec.start({
      hijack: true,
      stdin: false,
    });

    // Handle stdout/stderr streams if provided
    if (params.stdout || params.stderr) {
      this._pipeStreams(stream, params.stdout, params.stderr);
    }

    if (params.detached) {
      return command;
    }

    // Wait for command to complete
    return command.wait({ signal: params.signal });
  }

  /**
   * Pipe exec stream to stdout/stderr writable streams.
   */
  private _pipeStreams(
    stream: NodeJS.ReadableStream,
    stdout?: Writable,
    stderr?: Writable
  ): void {
    const streamAsync = stream as AsyncIterable<Buffer>;

    (async () => {
      for await (const chunk of streamAsync) {
        const buffer = Buffer.from(chunk);

        for (let i = 0; i < buffer.length; ) {
          if (buffer.length - i < 8) break;

          const header = buffer.subarray(i, i + 8);
          const streamType = header[0];
          const size =
            (header[4] << 24) |
            (header[5] << 16) |
            (header[6] << 8) |
            header[7];

          if (buffer.length - i < 8 + size) break;

          const data = buffer.subarray(i + 8, i + 8 + size);

          if (streamType === 1 && stdout) {
            stdout.write(data);
          } else if (streamType === 2 && stderr) {
            stderr.write(data);
          }

          i += 8 + size;
        }
      }
    })().catch(console.error);
  }

  /**
   * Create a directory in the filesystem of this sandbox.
   *
   * @param path - Path of the directory to create.
   * @param opts - Optional parameters.
   * @param opts.signal - An AbortSignal to cancel the operation.
   */
  async mkDir(dirPath: string, opts?: { signal?: AbortSignal }): Promise<void> {
    await this.runCommand("mkdir", ["-p", dirPath], opts);
  }

  /**
   * Read a file from the filesystem of this sandbox.
   *
   * @param file - File to read, with path and optional cwd.
   * @param opts - Optional parameters.
   * @param opts.signal - An AbortSignal to cancel the operation.
   * @returns A promise that resolves to a ReadableStream containing the file contents.
   */
  async readFile(
    file: { path: string; cwd?: string },
    opts?: { signal?: AbortSignal }
  ): Promise<NodeJS.ReadableStream | null> {
    const container = this.docker.getContainer(this.containerId);
    const filePath = file.cwd
      ? path.join(file.cwd, file.path)
      : file.path;

    try {
      const stream = await container.getArchive({ path: filePath });
      
      // Extract the file from the tar stream
      const extract = tar.extract();
      const fileStream = new Readable({ read() {} });

      extract.on("entry", (header, entryStream, next) => {
        entryStream.on("data", (chunk) => {
          fileStream.push(chunk);
        });
        entryStream.on("end", () => {
          fileStream.push(null);
          next();
        });
        entryStream.resume();
      });

      stream.pipe(extract);

      return fileStream;
    } catch (err) {
      return null;
    }
  }

  /**
   * Write files to the filesystem of this sandbox.
   *
   * @param files - Array of files with path and buffer contents.
   * @param opts - Optional parameters.
   * @param opts.signal - An AbortSignal to cancel the operation.
   * @returns A promise that resolves when the files are written.
   */
  async writeFiles(
    files: { path: string; content: Buffer }[],
    opts?: { signal?: AbortSignal }
  ): Promise<void> {
    const container = this.docker.getContainer(this.containerId);

    // Create a tar archive with all files
    const pack = tar.pack();

    for (const file of files) {
      const filePath = file.path.startsWith("/")
        ? file.path.slice(1)
        : file.path;

      pack.entry({ name: filePath }, file.content);
    }

    pack.finalize();

    // Upload to container
    await container.putArchive(pack, {
      path: "/vercel/sandbox",
    });
  }

  /**
   * Get the public domain of a port of this sandbox.
   *
   * @param p - Port number to resolve.
   * @returns A full domain (e.g. `http://localhost:3000`).
   * @throws If the port has no associated route.
   */
  domain(p: number): string {
    const route = this.routes.find((r) => r.port === p);
    if (!route) {
      throw new Error(`No route found for port ${p}`);
    }
    return `http://${route.subdomain}`;
  }

  /**
   * Stop the sandbox.
   *
   * @param opts - Optional parameters.
   * @param opts.signal - An AbortSignal to cancel the operation.
   * @returns A promise that resolves when the sandbox is stopped.
   */
  async stop(opts?: { signal?: AbortSignal }): Promise<void> {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = undefined;
    }

    const container = this.docker.getContainer(this.containerId);
    await container.stop();
    this.metadata.status = "stopped";
    this.metadata.stoppedAt = Date.now();
  }

  /**
   * Extend the timeout of the sandbox by the specified duration.
   *
   * @param duration - The duration in milliseconds to extend the timeout by.
   * @param opts - Optional parameters.
   * @param opts.signal - An AbortSignal to cancel the operation.
   * @returns A promise that resolves when the timeout is extended.
   */
  async extendTimeout(
    duration: number,
    opts?: { signal?: AbortSignal }
  ): Promise<void> {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
    }

    this.metadata.timeout += duration;
    this.metadata.updatedAt = Date.now();

    this.timeoutHandle = setTimeout(() => {
      this.stop().catch(console.error);
    }, duration);
  }
}

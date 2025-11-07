import * as crypto from 'crypto';
import * as path from 'path';
import { PassThrough } from 'stream';

import Docker from 'dockerode';
import * as tar from 'tar-stream';

import { Command, CommandFinished } from './command';
import { nanoid } from './nanoid';
import type {
  CommandData,
  CreateSandboxParams,
  GetSandboxParams,
  RunCommandParams,
  SandboxMetaData,
  SandboxRouteData,
} from './types';

type ContainerState =
  | 'created'
  | 'restarting'
  | 'running'
  | 'removing'
  | 'paused'
  | 'exited'
  | 'dead';

function containerStateToSandboxStatus(
  state: ContainerState,
): SandboxMetaData['status'] {
  switch (state) {
    case 'created':
    case 'restarting':
    case 'paused':
      return 'pending';
    case 'running':
      return 'running';
    case 'removing':
      return 'stopping';
    case 'exited':
      return 'stopped';
    case 'dead':
      return 'failed';
  }
}

/**
 * A Sandbox is an isolated Docker container to run commands in.
 *
 * Use {@link Sandbox.create} or {@link Sandbox.get} to construct.
 */
export class Sandbox {
  private docker: Docker;
  private containerId: string;
  private sandbox: SandboxMetaData;
  private commands: Map<string, Command> = new Map();

  /**
   * Routes from ports to subdomains.
   */
  readonly routes: SandboxRouteData[];

  /**
   * Unique ID of this sandbox.
   */
  get sandboxId(): string {
    return this.sandbox.id;
  }

  /**
   * The status of the sandbox.
   */
  get status(): SandboxMetaData['status'] {
    return this.sandbox.status;
  }

  /**
   * The timeout of the sandbox in milliseconds.
   */
  get timeout(): number {
    return this.sandbox.timeout;
  }

  /**
   * List sandboxes.
   *
   * @param params - List parameters.
   * @returns A promise resolving to an object with sandboxes array and pagination data.
   */
  static async list(params: {
    limit?: number;
    since?: number | Date;
    until?: number | Date;
    signal?: AbortSignal;
  }): Promise<{
    sandboxes: SandboxMetaData[];
    pagination: {
      count: number;
      next: number | null;
      prev: number | null;
      total: number;
    };
  }> {
    const docker = new Docker();
    const containers = await docker.listContainers({
      all: true,
      filters: {
        label: ['mock-vercel-sandbox=true'],
      },
      abortSignal: params.signal,
    });

    if (params.since instanceof Date) {
      params.since = params.since.getTime();
    }
    if (params.until instanceof Date) {
      params.until = params.until.getTime();
    }

    const sandboxes: SandboxMetaData[] = [];

    for (const containerInfo of containers) {
      if (params.limit !== undefined && sandboxes.length >= params.limit) {
        break;
      }
      const createdAt = containerInfo.Created * 1000;
      if (params.until && createdAt >= params.until) {
        continue;
      }
      if (params.since && createdAt <= params.since) {
        continue;
      }

      const labels = containerInfo.Labels;
      const timeoutDuration = await Sandbox._readTimeoutFile({
        containerId: containerInfo.Id,
        signal: params.signal,
      });

      sandboxes.push({
        id: labels.sandboxId,
        status: containerStateToSandboxStatus(
          containerInfo.State as ContainerState,
        ),
        timeout: timeoutDuration,
        cwd: '/vercel/sandbox',
        memory: 0,
        vcpus: 0,
        runtime: labels.runtime ? labels.runtime : 'node22',
        region: 'local',
        requestedAt: createdAt,
        createdAt,
        updatedAt: createdAt,
        startedAt: createdAt,
      });
    }

    return {
      sandboxes,
      pagination: {
        count: sandboxes.length,
        next:
          sandboxes.length > 0
            ? sandboxes[sandboxes.length - 1].createdAt
            : null,
        prev: sandboxes.length > 0 ? sandboxes[0].createdAt : null,
        total: containers.length,
      },
    };
  }

  /**
   * Create a new sandbox.
   *
   * @param params - Creation parameters.
   * @returns A promise resolving to the created {@link Sandbox}.
   */
  static async create(params?: CreateSandboxParams): Promise<Sandbox> {
    const docker = new Docker();
    const sandboxId = `sbx_${nanoid()}`;
    const imageName = 'mock-vercel-sandbox:latest';

    let rebuild = params?.rebuild ?? false;

    // Check if image exists, build if not
    try {
      await docker.getImage(imageName).inspect();
    } catch (err) {
      if (
        err instanceof Error &&
        'reason' in err &&
        err.reason === 'no such image'
      ) {
        rebuild = true;
        // Image doesn't exist, build it
      } else {
        throw err;
      }
    }

    if (rebuild) {
      const stream = await docker.buildImage(
        {
          context: path.resolve(__dirname, '..'),
          src: ['Dockerfile'],
        },
        { t: imageName, abortSignal: params?.signal },
      );

      await new Promise<void>((resolve, reject) => {
        docker.modem.followProgress(stream, (err: Error | null) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    }

    // Create container
    const portBindings: Record<string, Array<{ HostPort: string }>> = {};
    const exposedPorts: Record<string, object> = {};
    const routes: SandboxRouteData[] = [];

    if (params?.ports) {
      for (const port of params.ports) {
        const containerPort = `${port}/tcp`;
        exposedPorts[containerPort] = {};
        portBindings[containerPort] = [{ HostPort: String(port) }];
        routes.push({
          port,
          subdomain: `localhost:${port}`,
          url: `http://localhost:${port}`,
        });
      }
    }

    const timeoutMs = params?.timeout ?? 300000; // Default 5 minutes
    const runtime = params?.runtime ?? 'node22';

    const container = await docker.createContainer({
      Image: imageName,
      name: sandboxId,
      ExposedPorts: exposedPorts,
      HostConfig: {
        PortBindings: portBindings,
        AutoRemove: true,
      },
      Env: [`SANDBOX_TIMEOUT_MS=${timeoutMs}`],
      Labels: {
        'mock-vercel-sandbox': 'true',
        sandboxId,
        runtime,
      },
      abortSignal: params?.signal,
    });

    // Start container
    await container.start({ abortSignal: params?.signal });

    // Handle source if provided
    if (params?.source) {
      await Sandbox._handleSource({
        container,
        source: params.source,
        signal: params.signal,
      });
    }

    const now = Date.now();

    // Read the timeout duration from the file (written by sandbox.sh script)
    // Wait a moment for the script to write it
    await new Promise((resolve) => setTimeout(resolve, 100));
    const actualTimeout = await Sandbox._readTimeoutFile({
      containerId: container.id,
      signal: params?.signal,
    });

    const metadata: SandboxMetaData = {
      id: sandboxId,
      status: 'running',
      timeout: actualTimeout,
      cwd: '/vercel/sandbox',
      memory: 0,
      vcpus: 0,
      runtime,
      region: 'local',
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

    return sandbox;
  }

  /**
   * Handle source cloning/extraction.
   */
  private static async _handleSource({
    container,
    source,
    signal,
  }: {
    container: Docker.Container;
    source: NonNullable<CreateSandboxParams['source']>;
    signal?: AbortSignal;
  }): Promise<void> {
    if (source.type === 'git') {
      const cloneCmd = ['git', 'clone'];

      if (source.depth) {
        cloneCmd.push('--depth', String(source.depth));
      }

      if ('username' in source && source.username) {
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

      cloneCmd.push('/vercel/sandbox');

      const exec = await container.exec({
        Cmd: cloneCmd,
        AttachStdout: true,
        AttachStderr: true,
        WorkingDir: '/tmp',
        abortSignal: signal,
      });

      await exec.start({ Detach: false, abortSignal: signal });

      if (source.revision) {
        const checkoutExec = await container.exec({
          Cmd: ['git', 'checkout', source.revision],
          AttachStdout: true,
          AttachStderr: true,
          WorkingDir: '/vercel/sandbox',
          abortSignal: signal,
        });

        await checkoutExec.start({ Detach: false, abortSignal: signal });
      }
    } else {
      // Download and extract tarball
      const response = await fetch(source.url, { signal });
      if (!response.ok) {
        throw new Error(`Failed to fetch tarball: ${response.statusText}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      await container.putArchive(buffer, {
        path: '/vercel/sandbox',
        abortSignal: signal,
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
        label: [`sandboxId=${params.sandboxId}`, 'mock-vercel-sandbox=true'],
      },
      abortSignal: params.signal,
    });

    if (containers.length === 0) {
      throw new Error(`Sandbox ${params.sandboxId} not found`);
    }

    const containerInfo = containers[0];

    const labels = containerInfo.Labels;
    const routes: SandboxRouteData[] = [];

    for (const port of containerInfo.Ports) {
      routes.push({
        port: port.PrivatePort,
        subdomain: `localhost:${port.PublicPort}`,
        url: `http://localhost:${port.PublicPort}`,
      });
    }

    const now = Date.now();

    const timeoutDuration = await Sandbox._readTimeoutFile({
      containerId: containerInfo.Id,
      signal: params.signal,
    });

    const metadata: SandboxMetaData = {
      id: params.sandboxId,
      status: containerStateToSandboxStatus(
        containerInfo.State as ContainerState,
      ),
      timeout: timeoutDuration,
      cwd: '/vercel/sandbox',
      memory: 0,
      vcpus: 0,
      runtime: labels.runtime ? labels.runtime : 'node22',
      region: 'local',
      requestedAt: now,
      createdAt: containerInfo.Created * 1000,
      updatedAt: containerInfo.Created * 1000,
      startedAt: containerInfo.Created * 1000,
    };

    return new Sandbox({
      docker,
      containerId: containerInfo.Id,
      metadata,
      routes,
    });
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
    this.sandbox = metadata;
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
    _opts?: { signal?: AbortSignal },
  ): Promise<Command> {
    const command = this.commands.get(cmdId);
    if (!command) {
      throw new Error(`Command ${cmdId} not found`);
    }
    return command;
  }

  /**
   * Start executing a command in this sandbox.
   */
  async runCommand(
    command: string,
    args?: string[],
    opts?: { signal?: AbortSignal },
  ): Promise<CommandFinished>;
  async runCommand(
    params: RunCommandParams & { detached: true },
  ): Promise<Command>;
  async runCommand(params: RunCommandParams): Promise<CommandFinished>;
  async runCommand(
    commandOrParams: string | RunCommandParams,
    args?: string[],
    opts?: { signal?: AbortSignal },
  ): Promise<Command | CommandFinished> {
    let params: RunCommandParams;

    if (typeof commandOrParams === 'string') {
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
    params: RunCommandParams,
  ): Promise<Command | CommandFinished> {
    const container = this.docker.getContainer(this.containerId);
    const cmd = [params.cmd, ...(params.args ?? [])];
    const cwd = params.cwd ?? this.sandbox.cwd;

    // Build environment variables
    const env: string[] = params.env
      ? Object.entries(params.env).map(([key, value]) => `${key}=${value}`)
      : [];

    // Create exec instance
    const execOptions: Docker.ExecCreateOptions = {
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: false,
      Tty: false,
      WorkingDir: cwd,
      Env: env.length > 0 ? env : undefined,
      User: params.sudo ? 'root' : 'vercel-sandbox',
      abortSignal: params.signal,
    };

    const exec = await container.exec(execOptions);
    const cmdId = `cmd_${crypto.randomBytes(14).toString('hex')}`;
    const startedAt = Date.now();

    const cmdData: CommandData = {
      id: cmdId,
      name: params.cmd,
      args: params.args ?? [],
      cwd,
      sandboxId: this.sandboxId,
      exitCode: null,
      startedAt,
    };

    const command = new Command({
      docker: this.docker,
      containerId: this.containerId,
      cmd: cmdData,
      execId: exec.id,
    });

    // Track the command
    this.commands.set(cmdId, command);

    // Start execution
    const _stream = await exec.start({
      hijack: true,
      stdin: false,
      abortSignal: params.signal,
    });

    // Start buffering logs from the stream
    // command._startLogStream(stream, params.stdout, params.stderr);

    if (params.detached) {
      return command;
    }

    // Wait for command to complete
    return command.wait({ signal: params.signal });
  }

  /**
   * Create a directory in the filesystem of this sandbox.
   *
   * @param path - Path of the directory to create.
   * @param opts - Optional parameters.
   * @param opts.signal - An AbortSignal to cancel the operation.
   */
  async mkDir(dirPath: string, opts?: { signal?: AbortSignal }): Promise<void> {
    await this.runCommand('mkdir', ['-p', dirPath], opts);
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
    opts?: { signal?: AbortSignal },
  ): Promise<NodeJS.ReadableStream | null> {
    const container = this.docker.getContainer(this.containerId);
    const filePath = file.cwd ? path.join(file.cwd, file.path) : file.path;

    const stream = await container.getArchive({
      path: filePath,
      abortSignal: opts?.signal,
    });

    return new Promise<NodeJS.ReadableStream | null>((resolve) => {
      // Extract the file from the tar stream
      const extract = tar.extract();
      const fileStream = new PassThrough();

      let foundFile = false;

      extract.on('entry', (header, entryStream, next) => {
        if (header.name !== filePath) {
          entryStream.resume();
          return next();
        }

        foundFile = true;

        entryStream.pipe(fileStream);
        next();
      });

      extract.once('finish', () => {
        if (!foundFile) {
          fileStream.end();
        }
      });

      extract.once('error', (err) => {
        fileStream.destroy(err);
        resolve(null);
      });

      stream.pipe(extract);

      resolve(fileStream);
    });
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
    opts?: { signal?: AbortSignal },
  ): Promise<void> {
    const container = this.docker.getContainer(this.containerId);

    // Create a tar archive with all files
    const pack = tar.pack();

    for (const file of files) {
      const filePath = file.path.startsWith('/')
        ? file.path
        : path.join('/vercel/sandbox', file.path);

      pack.entry(
        { name: filePath, uid: 1000, gid: 1000, mode: 0o644 },
        file.content,
      );
    }

    pack.finalize();

    // Upload to container
    await container.putArchive(pack, {
      path: '/',
      abortSignal: opts?.signal,
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
    const route = this.routes.find(({ port }) => port === p);
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
    const container = this.docker.getContainer(this.containerId);
    await container.stop({ abortSignal: opts?.signal });
    this.sandbox.status = 'stopped';
    this.sandbox.stoppedAt = Date.now();
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
    opts?: { signal?: AbortSignal },
  ): Promise<void> {
    const container = this.docker.getContainer(this.containerId);

    // Call sandbox.sh extend-timeout command inside the container
    const exec = await container.exec({
      Cmd: ['/vercel/bin/sandbox.sh', 'extend-timeout', String(duration)],
      AttachStdout: true,
      AttachStderr: true,
      abortSignal: opts?.signal,
    });

    await exec.start({ Detach: false, abortSignal: opts?.signal });

    // Read the updated timeout from the file
    const timeoutDuration = await Sandbox._readTimeoutFile({
      containerId: this.containerId,
      signal: opts?.signal,
    });

    this.sandbox.timeout = timeoutDuration;
    this.sandbox.updatedAt = Date.now();
  }

  /**
   * Write the timeout data file to the container.
   * Format: START_TIMESTAMP:TIMEOUT_DURATION (both in milliseconds)
   * This file is monitored by the sandbox.sh script.
   *
   * @param startTimestamp - Unix timestamp in milliseconds when the sandbox started.
   * @param timeoutDuration - Timeout duration in milliseconds.
   */
  private static async _writeTimeoutFile({
    containerId,
    startTimestamp,
    timeoutDuration,
    signal,
  }: {
    containerId: string;
    startTimestamp: number;
    timeoutDuration: number;
    signal?: AbortSignal;
  }): Promise<void> {
    const docker = new Docker();
    const container = docker.getContainer(containerId);
    const timeoutContent = Buffer.from(`${startTimestamp}:${timeoutDuration}`);

    // Create a tar archive with the timeout file
    const pack = tar.pack();
    pack.entry({ name: '.sandbox_timeout' }, timeoutContent);
    pack.finalize();

    // Upload to /vercel/ directory
    await container.putArchive(pack, { path: '/vercel', abortSignal: signal });
  }

  /**
   * Read the timeout duration from the container.
   * Returns the timeout duration in milliseconds (not absolute timestamp).
   *
   * @param containerId - ID of the container.
   * @param signal - Optional abort signal.
   * @returns The timeout duration in milliseconds.
   * @throws If the timeout file cannot be read or is invalid.
   */
  private static async _readTimeoutFile({
    containerId,
    signal,
  }: {
    containerId: string;
    signal?: AbortSignal;
  }): Promise<number> {
    const docker = new Docker();
    const container = docker.getContainer(containerId);
    
    try {
      const stream = await container.getArchive({
        path: '/vercel/.sandbox_timeout',
        abortSignal: signal,
      });
      const extract = tar.extract();
      let timeoutContent = Buffer.alloc(0);
      let foundFile = false;
      
      extract.on('entry', (header, entryStream, next) => {
        if (header.name !== '.sandbox_timeout') {
          entryStream.resume();
          return next();
        }
        foundFile = true;
        entryStream.on('data', (chunk: Buffer) => {
          timeoutContent = Buffer.concat([timeoutContent, chunk]);
        });
        entryStream.on('error', (err) => {
          next(err);
        });
        entryStream.on('end', () => {
          next();
        });
      });
      
      const p = new Promise<void>((resolve, reject) => {
        extract.once('finish', () => {
          if (!foundFile) {
            reject(new Error('Timeout file not found in archive'));
          } else {
            resolve();
          }
        });
        extract.once('error', reject);
      });
      
      stream.pipe(extract);
      await p;
      
      const content = timeoutContent.toString('utf-8').trim();
      const parts = content.split(':');
      if (parts.length !== 2) {
        throw new Error(`Invalid timeout file format: ${content}`);
      }
      
      const timeoutDuration = Number.parseInt(parts[1], 10);
      if (Number.isNaN(timeoutDuration)) {
        throw new Error(`Invalid timeout duration: ${parts[1]}`);
      }
      
      return timeoutDuration;
    } catch (err) {
      // If file doesn't exist or can't be read, return default timeout
      if (
        err instanceof Error &&
        ('statusCode' in err || err.message.includes('not found'))
      ) {
        return 300000; // Default 5 minutes
      }
      throw err;
    }
  }
}

import Dockerode from "dockerode";
import { promises as fs } from "fs";
import path from "path";
import { Readable } from "stream";
import tar from "tar-stream";
import { v4 as uuid } from "uuid";
import type { Writable } from "stream";
import { Command, CommandFinished } from "./command";

type SandboxStatus = "pending" | "running" | "stopping" | "stopped" | "failed";

type SandboxRouteData = {
  host: string;
  port: number;
  protocol: "http" | "https";
  url: string;
};

type SandboxMetaData = {
  createdAt: number;
  cwd: string;
  duration?: number;
  id: string;
  memory: number;
  region: string;
  requestedAt: number;
  requestedStopAt?: number;
  runtime: string;
  startedAt?: number;
  status: SandboxStatus;
  stoppedAt?: number;
  timeout: number;
  updatedAt: number;
  vcpus: number;
};

type LocalSandboxRecord = {
  commands: Map<string, Command>;
  container: Dockerode.Container;
  imageTag: string;
  metadata: SandboxMetaData;
  routes: SandboxRouteData[];
  timeoutHandle: NodeJS.Timeout | null;
};

type CreateSandboxSource = {
  password?: string;
  revision?: string;
  type: "git" | "tarball";
  url: string;
  username?: string;
  depth?: number;
};

/**
 * Configuration for creating a local sandbox container.
 *
 * @property ports Optional list of TCP ports to expose from the sandbox.
 * @property resources Optional resource limits to emulate remote quotas.
 * @property runtime Runtime label to tag the sandbox with.
 * @property signal Optional abort signal checked before provisioning begins.
 * @property source Optional descriptor mirroring the remote sandbox API. It is currently ignored by the local implementation.
 * @property timeout Optional timeout in milliseconds before the sandbox auto-stops.
 *
 * @example
 * ```ts
 * const sandbox = await Sandbox.create({ ports: [3000], resources: { vcpus: 2 } });
 * ```
 */
export type CreateSandboxParams = {
  ports?: number[];
  resources?: {
    vcpus: number;
  };
  runtime?: "node22" | "python3.13" | (string & {});
  signal?: AbortSignal;
  source?: CreateSandboxSource;
  timeout?: number;
};

type RunCommandParams = {
  args?: string[];
  cmd: string;
  cwd?: string;
  detached?: boolean;
  env?: Record<string, string>;
  signal?: AbortSignal;
  stderr?: Writable;
  stdout?: Writable;
  sudo?: boolean;
};

type SandboxListResult = {
  pagination: {
    count: number;
    next: number | null;
    prev: number | null;
  };
  sandboxes: SandboxMetaData[];
};

const docker = new Dockerode();
const activeSandboxes = new Map<string, LocalSandboxRecord>();
const imageBuildLocks = new Map<string, Promise<void>>();

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const SANDBOX_BASE_PATH = "/vercel/sandbox";
const DEFAULT_REGION = "local";

function getDockerModem(client: Dockerode) {
  const candidate = client as Dockerode & {
    modem?: {
      followProgress(stream: NodeJS.ReadableStream, onFinished: (error?: Error) => void): void;
    };
  };

  if (!candidate.modem) {
    throw new Error("Docker modem is not available");
  }

  return candidate.modem;
}

async function ensureImage(imageTag: string): Promise<void> {
  try {
    await docker.getImage(imageTag).inspect();
    return;
  } catch (error) {
    if (typeof error === "object" && error && "statusCode" in error && (error as { statusCode?: number }).statusCode === 404) {
      // fallthrough to build
    } else {
      throw error;
    }
  }

  let buildPromise = imageBuildLocks.get(imageTag);

  if (!buildPromise) {
    buildPromise = buildImage(imageTag);
    imageBuildLocks.set(imageTag, buildPromise);
  }

  await buildPromise;
}

async function buildImage(imageTag: string): Promise<void> {
  const dockerfilePath = resolveDockerfilePath();
  const dockerfileContents = await fs.readFile(dockerfilePath);
  const pack = tar.pack();

  pack.entry({ name: "Dockerfile" }, dockerfileContents);
  pack.finalize();

  const buildStream = await docker.buildImage(pack, {
    dockerfile: "Dockerfile",
    t: imageTag,
  });

  await new Promise<void>((resolve, reject) => {
    const modem = getDockerModem(docker);

    modem.followProgress(
      buildStream,
      (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      },
    );
  });
}

function resolveDockerfilePath(): string {
  const provided = process.env.MOCK_VERCEL_SANDBOX_DOCKERFILE;

  if (provided) {
    return path.resolve(process.cwd(), provided);
  }

  return path.resolve(process.cwd(), "Dockerfile");
}

function resolveImageTag(): string {
  return process.env.MOCK_VERCEL_SANDBOX_IMAGE ?? "mock-vercel-sandbox:latest";
}

function normalizePorts(ports: number[] | undefined): number[] {
  if (!ports) {
    return [];
  }

  if (ports.length > 4) {
    throw new Error("A sandbox can expose up to 4 ports");
  }

  return [...new Set(ports)].sort((a, b) => a - b);
}

function toEnvList(env: Record<string, string> | undefined): string[] {
  if (!env) {
    return [];
  }

  const entries = Object.entries(env);
  const result: string[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const [key, value] = entries[index];
    result.push(`${key}=${value}`);
  }

  return result;
}

async function createArchive(files: { path: string; content: Buffer }[]): Promise<NodeJS.ReadableStream> {
  const pack = tar.pack();
  const createdDirs = new Set<string>();

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const targetPath = normalizeSandboxPath(file.path);
    const directorySegments = targetPath.split("/");

    let cumulative = "";

    for (let segmentIndex = 0; segmentIndex < directorySegments.length - 1; segmentIndex += 1) {
      cumulative = cumulative ? `${cumulative}/${directorySegments[segmentIndex]}` : directorySegments[segmentIndex];

      if (!createdDirs.has(cumulative)) {
        pack.entry({ name: `${cumulative}/`, type: "directory", mode: 0o755 });
        createdDirs.add(cumulative);
      }
    }

    pack.entry({ name: targetPath, mode: 0o644 }, file.content);
  }

  pack.finalize();

  return pack;
}

async function extractFile(archiveStream: NodeJS.ReadableStream): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const extract = tar.extract();
    const chunks: Buffer[] = [];

    extract.on("entry", (_, stream, next) => {
      stream.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });

      stream.on("end", () => {
        next();
      });

      stream.resume();
    });

    extract.on("finish", () => {
      if (!chunks.length) {
        resolve(null);
      } else {
        resolve(Buffer.concat(chunks));
      }
    });

    extract.on("error", reject);
    archiveStream.on("error", reject);

    archiveStream.pipe(extract);
  });
}

function normalizeSandboxPath(target: string): string {
  const candidate = target.startsWith("/") ? target : `${SANDBOX_BASE_PATH}/${target}`;
  const normalized = path.posix.normalize(candidate);
  return normalized.replace(/^\/+/u, "");
}

async function stopRecord(record: LocalSandboxRecord): Promise<void> {
  if (record.timeoutHandle) {
    clearTimeout(record.timeoutHandle);
    record.timeoutHandle = null;
  }

  const now = Date.now();

  if (record.metadata.status === "stopped" || record.metadata.status === "failed") {
    return;
  }

  record.metadata.status = "stopping";
  record.metadata.requestedStopAt = now;

  try {
    await record.container.stop({ t: 5 });
  } catch (error) {
    record.metadata.status = "failed";
    record.metadata.updatedAt = Date.now();
    throw error;
  }

  record.metadata.status = "stopped";
  record.metadata.stoppedAt = Date.now();
  record.metadata.duration = record.metadata.startedAt ? record.metadata.stoppedAt - record.metadata.startedAt : undefined;
  record.metadata.updatedAt = record.metadata.stoppedAt;
  record.commands.clear();

  try {
    await record.container.remove({ force: true });
  } catch (error) {
    // Ignore removal errors to keep flow similar to remote sandbox behaviour.
    void error;
  }
}

function scheduleTimeout(record: LocalSandboxRecord, sandboxId: string): void {
  if (record.timeoutHandle) {
    clearTimeout(record.timeoutHandle);
  }

  record.timeoutHandle = setTimeout(() => {
    void stopRecord(record).catch(() => {
      // Intentionally swallow; state is set to failed inside stopRecord when needed.
    }).finally(() => {
      activeSandboxes.delete(sandboxId);
    });
  }, record.metadata.timeout);
}

async function createContainer(params: {
  imageTag: string;
  ports: number[];
  timeout: number;
  runtime: string;
  vcpus: number;
}): Promise<LocalSandboxRecord> {
  const sandboxId = uuid();
  const now = Date.now();

  const portBindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = {};
  const exposedPorts: Record<string, {}> = {};

  for (let index = 0; index < params.ports.length; index += 1) {
    const port = params.ports[index];
    const key = `${port}/tcp`;
    exposedPorts[key] = {};
    portBindings[key] = [{ HostIp: "127.0.0.1", HostPort: "" }];
  }

  const container = await docker.createContainer({
    ExposedPorts: Object.keys(exposedPorts).length ? exposedPorts : undefined,
    HostConfig: {
      AutoRemove: false,
      Binds: [`${process.cwd()}:${SANDBOX_BASE_PATH}`],
      PortBindings: Object.keys(portBindings).length ? portBindings : undefined,
      Ulimits: [
        {
          Hard: params.vcpus * 1024,
          Name: "nofile",
          Soft: params.vcpus * 1024,
        },
      ],
    },
    Image: params.imageTag,
    Labels: {
      "mock-vercel-sandbox": "true",
      "mock-vercel-sandbox-id": sandboxId,
    },
    name: `mock-vercel-${sandboxId}`,
    Tty: false,
    User: "vercel-sandbox",
    WorkingDir: SANDBOX_BASE_PATH,
  });

  await container.start();

  const inspect = await container.inspect();
  const routes: SandboxRouteData[] = [];

  if (inspect.NetworkSettings?.Ports) {
    const ports = Object.entries(inspect.NetworkSettings.Ports);

    for (let index = 0; index < ports.length; index += 1) {
      const [key, bindings] = ports[index];

      if (!bindings || !bindings.length) {
        continue;
      }

      const port = Number.parseInt(key, 10);
      const binding = bindings[0];
      const hostPort = binding.HostPort;
      const host = binding.HostIp === "0.0.0.0" ? "127.0.0.1" : binding.HostIp;
      const protocol: "http" | "https" = port === 443 ? "https" : "http";

      routes.push({
        host,
        port,
        protocol,
        url: `${protocol}://${host}:${hostPort}`,
      });
    }
  }

  const metadata: SandboxMetaData = {
    createdAt: now,
    cwd: SANDBOX_BASE_PATH,
    id: sandboxId,
    memory: params.vcpus * 2048,
    region: DEFAULT_REGION,
    requestedAt: now,
    runtime: params.runtime,
    startedAt: Date.now(),
    status: "running",
    timeout: params.timeout,
    updatedAt: now,
    vcpus: params.vcpus,
  };

  const record: LocalSandboxRecord = {
    commands: new Map<string, Command>(),
    container,
    imageTag: params.imageTag,
    metadata,
    routes,
    timeoutHandle: null,
  };

  activeSandboxes.set(sandboxId, record);
  scheduleTimeout(record, sandboxId);

  return record;
}

/**
 * Local implementation of the Vercel Sandbox API backed by Docker.
 *
 * @example
 * ```ts
 * const sandbox = await Sandbox.create({ ports: [3000] });
 * const result = await sandbox.runCommand("node", ["--version"]);
 * console.log(result.exitCode);
 * await sandbox.stop();
 * ```
 */
export class Sandbox {
  private readonly record: LocalSandboxRecord;

  private constructor(record: LocalSandboxRecord) {
    this.record = record;
  }

  /**
   * Lists active sandboxes managed by this process.
   *
   * @returns Metadata describing known sandboxes.
   */
  static async list(): Promise<SandboxListResult> {
    const sandboxes: SandboxMetaData[] = [];

    for (const record of activeSandboxes.values()) {
      sandboxes.push({ ...record.metadata });
    }

    return {
      pagination: {
        count: sandboxes.length,
        next: null,
        prev: null,
      },
      sandboxes,
    };
  }

  /**
   * Provisions a new sandbox container.
   *
   * @param params Optional creation parameters.
   */
  static async create(params?: CreateSandboxParams): Promise<Sandbox> {
    const imageTag = resolveImageTag();
    await ensureImage(imageTag);

    const ports = normalizePorts(params?.ports);
    const timeout = params?.timeout ?? DEFAULT_TIMEOUT_MS;
    const vcpus = params?.resources?.vcpus ?? 1;
    const runtime = params?.runtime ?? "node22";

    const record = await createContainer({
      imageTag,
      ports,
      runtime,
      timeout,
      vcpus,
    });

    return new Sandbox(record);
  }

  /**
   * Retrieves a sandbox by ID.
   *
   * @param params Parameters containing the sandbox identifier.
   */
  static async get(params: { sandboxId: string }): Promise<Sandbox> {
    const record = activeSandboxes.get(params.sandboxId);

    if (!record) {
      throw new Error(`Sandbox ${params.sandboxId} not found`);
    }

    return new Sandbox(record);
  }

  /**
   * Mapping between exposed ports and their host-facing URLs.
   */
  get routes(): SandboxRouteData[] {
    return [...this.record.routes];
  }

  /**
   * Unique identifier of the sandbox.
   */
  get sandboxId(): string {
    return this.record.metadata.id;
  }

  /**
   * Current lifecycle status of the sandbox.
   */
  get status(): SandboxStatus {
    return this.record.metadata.status;
  }

  /**
   * Remaining timeout for the sandbox in milliseconds.
   */
  get timeout(): number {
    return this.record.metadata.timeout;
  }

  /**
   * Looks up a command previously started inside this sandbox.
   *
   * @param cmdId Command identifier returned when the command was started.
   */
  async getCommand(cmdId: string): Promise<Command> {
    const command = this.record.commands.get(cmdId);

    if (!command) {
      throw new Error(`Command ${cmdId} not found for sandbox ${this.sandboxId}`);
    }

    return command;
  }

  /**
   * Runs a command inside the sandbox container.
   *
   * @param command The binary to execute.
   * @param args Optional arguments for the command.
   * @param opts Additional execution options.
   */
  async runCommand(command: string, args?: string[], opts?: Omit<RunCommandParams, "cmd" | "args">): Promise<CommandFinished>;
  async runCommand(params: RunCommandParams & { detached: true }): Promise<Command>;
  async runCommand(params: RunCommandParams): Promise<CommandFinished>;
  async runCommand(first: string | RunCommandParams, args?: string[], opts?: Omit<RunCommandParams, "cmd" | "args">): Promise<Command | CommandFinished> {
    if (typeof first === "string") {
      return this._runCommand({
        args: args ?? [],
        cmd: first,
        cwd: opts?.cwd,
        detached: opts?.detached,
        env: opts?.env,
        signal: opts?.signal,
        stderr: opts?.stderr,
        stdout: opts?.stdout,
        sudo: opts?.sudo,
      });
    }

    return this._runCommand(first);
  }

  /**
   * Creates a directory inside the sandbox filesystem.
   *
   * @param targetPath Path of the directory to create.
   */
  async mkDir(targetPath: string): Promise<void> {
    await this._runCommand({
      args: ["-p", targetPath],
      cmd: "mkdir",
      detached: false,
      sudo: true,
    });
  }

  /**
   * Reads a file from the sandbox filesystem.
   *
   * @param file File descriptor containing the target path and optional cwd.
   * @returns A readable stream with the file contents or null if the file does not exist.
   */
  async readFile(file: { path: string; cwd?: string }): Promise<NodeJS.ReadableStream | null> {
    const target = file.path.startsWith("/") ? file.path : path.posix.join(SANDBOX_BASE_PATH, file.path);

    try {
      const stream = await this.record.container.getArchive({ path: target });
      const buffer = await extractFile(stream);

      if (!buffer) {
        return null;
      }

      return Readable.from(buffer);
    } catch (error) {
      if (typeof error === "object" && error && "statusCode" in error && (error as { statusCode?: number }).statusCode === 404) {
        return null;
      }

      throw error;
    }
  }

  /**
   * Writes multiple files into the sandbox filesystem.
   *
   * @param files Collection of files to write.
   */
  async writeFiles(files: { path: string; content: Buffer }[]): Promise<void> {
    if (!files.length) {
      return;
    }

    const archive = await createArchive(files);

    await this.record.container.putArchive(archive, { path: "/" });
  }

  /**
   * Resolves the local domain that maps to an exposed port.
   *
   * @param port Exposed port.
   */
  domain(port: number): string {
    const route = this.record.routes.find((item) => item.port === port);

    if (!route) {
      throw new Error(`Port ${port} is not exposed for sandbox ${this.sandboxId}`);
    }

    return route.url;
  }

  /**
   * Stops the sandbox and removes the underlying container.
   */
  async stop(): Promise<void> {
    await stopRecord(this.record);
    activeSandboxes.delete(this.sandboxId);
  }

  /**
   * Extends the sandbox timeout by the provided duration.
   *
   * @param duration Duration in milliseconds to add to the timeout.
   */
  async extendTimeout(duration: number): Promise<void> {
    this.record.metadata.timeout += duration;
    this.record.metadata.updatedAt = Date.now();
    scheduleTimeout(this.record, this.sandboxId);
  }

  private async _runCommand(params: RunCommandParams): Promise<Command | CommandFinished> {
    const args = params.args ?? [];
    const cmd = params.cmd;
    const env = toEnvList(params.env);
    const cwd = params.cwd ?? SANDBOX_BASE_PATH;
    const sudo = params.sudo ?? false;

    const exec = await this.record.container.exec({
      AttachStderr: true,
      AttachStdout: true,
      Cmd: sudo ? ["sudo", cmd, ...args] : [cmd, ...args],
      Env: env,
      Privileged: sudo,
      User: sudo ? "root" : "vercel-sandbox",
      WorkingDir: cwd,
    });

    const command = new Command({
      container: this.record.container,
      exec,
      forward: {
        stderr: params.stderr,
        stdout: params.stdout,
      },
      sandboxId: this.sandboxId,
      snapshot: {
        args,
        cmd,
        cwd,
        env: params.env ?? {},
        sudo,
      },
    });

    await command.start();

    this.record.commands.set(command.cmdId, command);

    if (params.detached) {
      return command;
    }

    const finished = await command.wait({ signal: params.signal });
    this.record.commands.set(finished.cmdId, finished);
    return finished;
  }
}

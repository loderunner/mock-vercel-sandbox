import { Sandbox } from "./sandbox.js";
import { Command, CommandFinished } from "./command.js";
import type {
  CreateSandboxParams,
  GetSandboxParams,
  RunCommandParams,
  SandboxMetaData,
  SandboxRouteData,
  CommandData,
} from "./types.js";

/**
 * Mock implementation of Sandbox for testing.
 * 
 * Usage with vitest:
 * ```ts
 * import { vi } from 'vitest';
 * import { createMockSandbox } from 'mock-vercel-sandbox/mock';
 * 
 * vi.mock('mock-vercel-sandbox', () => ({
 *   Sandbox: createMockSandbox()
 * }));
 * ```
 * 
 * Usage with jest:
 * ```ts
 * import { createMockSandbox } from 'mock-vercel-sandbox/mock';
 * 
 * jest.mock('mock-vercel-sandbox', () => ({
 *   Sandbox: createMockSandbox()
 * }));
 * ```
 */
export function createMockSandbox(overrides?: Partial<typeof Sandbox>) {
  const sandboxes = new Map<string, MockSandbox>();

  class MockSandbox {
    public _metadata: SandboxMetaData;
    readonly routes: SandboxRouteData[];
    public commands: Map<string, MockCommand> = new Map();

    get sandboxId(): string {
      return this._metadata.id;
    }

    get status(): SandboxMetaData["status"] {
      return this._metadata.status;
    }

    get timeout(): number {
      return this._metadata.timeout;
    }

    static async create(
      params: CreateSandboxParams = {}
    ): Promise<MockSandbox> {
      const sandboxId = `mock-sandbox-${Date.now()}`;
      const now = Date.now();

      const metadata: SandboxMetaData = {
        id: sandboxId,
        status: "running",
        timeout: params.timeout || 300000,
        cwd: "/vercel/sandbox",
        memory: (params.resources?.vcpus || 1) * 2048,
        vcpus: params.resources?.vcpus || 1,
        runtime: params.runtime || "node22",
        region: "mock",
        requestedAt: now,
        createdAt: now,
        updatedAt: now,
        startedAt: now,
      };

      const routes: SandboxRouteData[] =
        params.ports?.map((port) => ({
          port,
          subdomain: `mock-localhost:${port}`,
        })) || [];

      const sandbox = new MockSandbox(metadata, routes);
      sandboxes.set(sandboxId, sandbox);
      return sandbox;
    }

    static async get(params: GetSandboxParams): Promise<MockSandbox> {
      const sandbox = sandboxes.get(params.sandboxId);
      if (!sandbox) {
        throw new Error(`Sandbox ${params.sandboxId} not found`);
      }
      return sandbox;
    }

    static async list(): Promise<{
      sandboxes: Array<SandboxMetaData>;
      pagination: { count: number; next: number | null; prev: number | null };
    }> {
      const sandboxList = Array.from(sandboxes.values()).map((s) => s._metadata);
      return {
        sandboxes: sandboxList,
        pagination: {
          count: sandboxList.length,
          next: null,
          prev: null,
        },
      };
    }

    constructor(metadata: SandboxMetaData, routes: SandboxRouteData[]) {
      this._metadata = metadata;
      this.routes = routes;
    }

    async getCommand(cmdId: string): Promise<MockCommand> {
      const cmd = this.commands.get(cmdId);
      if (!cmd) {
        throw new Error(`Command ${cmdId} not found`);
      }
      return cmd;
    }

    async runCommand(command: string, args?: string[]): Promise<MockCommandFinished>;
    async runCommand(params: RunCommandParams & { detached: true }): Promise<MockCommand>;
    async runCommand(params: RunCommandParams): Promise<MockCommandFinished>;
    async runCommand(
      commandOrParams: string | RunCommandParams,
      args?: string[]
    ): Promise<MockCommand | MockCommandFinished> {
      let params: RunCommandParams;

      if (typeof commandOrParams === "string") {
        params = {
          cmd: commandOrParams,
          args,
        };
      } else {
        params = commandOrParams;
      }

      const cmdId = `mock-cmd-${Date.now()}-${Math.random()}`;
      const cmdData: CommandData = {
        id: cmdId,
        cwd: params.cwd || this._metadata.cwd,
        startedAt: Date.now(),
      };

      if (params.detached) {
        const command = new MockCommand(cmdData);
        this.commands.set(cmdId, command);
        return command;
      }

      const finished = new MockCommandFinished(cmdData, 0);
      this.commands.set(cmdId, finished);
      return finished;
    }

    async _runCommand(params: RunCommandParams): Promise<MockCommand | MockCommandFinished> {
      return this.runCommand(params);
    }

    async mkDir(): Promise<void> {
      // Mock implementation - no-op
    }

    async readFile(): Promise<NodeJS.ReadableStream | null> {
      // Mock implementation - return null
      return null;
    }

    async writeFiles(): Promise<void> {
      // Mock implementation - no-op
    }

    domain(p: number): string {
      const route = this.routes.find((r) => r.port === p);
      if (!route) {
        throw new Error(`No route found for port ${p}`);
      }
      return `http://${route.subdomain}`;
    }

    async stop(): Promise<void> {
      this._metadata.status = "stopped";
      this._metadata.stoppedAt = Date.now();
      sandboxes.delete(this.sandboxId);
    }

    async extendTimeout(duration: number): Promise<void> {
      this._metadata.timeout += duration;
      this._metadata.updatedAt = Date.now();
    }
  }

  class MockCommand {
    public cmd: CommandData;
    public exitCode: number | null = null;

    get cmdId(): string {
      return this.cmd.id;
    }

    get cwd(): string {
      return this.cmd.cwd;
    }

    get startedAt(): number {
      return this.cmd.startedAt;
    }

    constructor(cmd: CommandData) {
      this.cmd = cmd;
    }

    logs(): AsyncGenerator<
      { data: string; stream: "stdout" | "stderr" },
      void,
      void
    > & { close: () => void } {
      // Mock implementation - yield nothing
      const generator = (async function* () {})() as AsyncGenerator<
        { data: string; stream: "stdout" | "stderr" },
        void,
        void
      > & { close: () => void };

      generator.close = () => {};
      return generator;
    }

    async wait(): Promise<MockCommandFinished> {
      return new MockCommandFinished(this.cmd, 0);
    }

    async output(): Promise<string> {
      return "";
    }

    async stdout(): Promise<string> {
      return "";
    }

    async stderr(): Promise<string> {
      return "";
    }

    async kill(): Promise<void> {
      this.exitCode = 143; // SIGTERM exit code
    }
  }

  class MockCommandFinished extends MockCommand {
    public exitCode: number;

    constructor(cmd: CommandData, exitCode: number) {
      super(cmd);
      this.exitCode = exitCode;
    }

    async wait(): Promise<MockCommandFinished> {
      return this;
    }
  }

  return {
    Sandbox: MockSandbox,
    Command: MockCommand,
    CommandFinished: MockCommandFinished,
    ...overrides,
  };
}

/**
 * Helper to setup mock for vitest.
 * 
 * Usage:
 * ```ts
 * import { vi } from 'vitest';
 * import { setupMockForVitest } from 'mock-vercel-sandbox/mock';
 * 
 * setupMockForVitest(vi);
 * ```
 */
export function setupMockForVitest(vi: any): void {
  vi.mock("mock-vercel-sandbox", () => createMockSandbox());
}

/**
 * Helper to setup mock for jest.
 * 
 * Usage:
 * ```ts
 * import { setupMockForJest } from 'mock-vercel-sandbox/mock';
 * 
 * setupMockForJest();
 * ```
 */
export function setupMockForJest(): void {
  // In jest, this would typically be used in a setup file
  // Users should call jest.mock() directly with createMockSandbox()
}

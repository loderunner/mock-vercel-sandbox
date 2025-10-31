import type { Writable } from "stream";

/**
 * The source of the sandbox.
 *
 * Omit this parameter to start a sandbox without a source.
 */
export type SandboxSource =
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
 * Parameters for creating a sandbox.
 */
export type CreateSandboxParams = {
  /**
   * The source of the sandbox.
   *
   * Omit this parameter to start a sandbox without a source.
   */
  source?: SandboxSource;
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
  runtime?: "node22" | "python3.13" | (string & {});
  /**
   * An AbortSignal to cancel sandbox creation.
   */
  signal?: AbortSignal;
};

/**
 * Parameters for getting an existing sandbox.
 */
export type GetSandboxParams = {
  /**
   * Unique identifier of the sandbox.
   */
  sandboxId: string;
  /**
   * An AbortSignal to cancel the operation.
   */
  signal?: AbortSignal;
};

/**
 * Parameters for running a command in a sandbox.
 */
export type RunCommandParams = {
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
 * Status of a sandbox.
 */
export type SandboxStatus =
  | "pending"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

/**
 * Route data for exposed ports.
 */
export type SandboxRouteData = {
  port: number;
  subdomain: string;
};

/**
 * Metadata about a sandbox.
 */
export type SandboxMetaData = {
  id: string;
  status: SandboxStatus;
  timeout: number;
  cwd: string;
  memory: number;
  vcpus: number;
  runtime: string;
  region: string;
  requestedAt: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  requestedStopAt?: number;
  stoppedAt?: number;
  duration?: number;
};

/**
 * Data about a command execution.
 */
export type CommandData = {
  id: string;
  cwd: string;
  startedAt: number;
};

/**
 * Signal types for killing processes.
 */
export type Signal =
  | "SIGABRT"
  | "SIGALRM"
  | "SIGBUS"
  | "SIGCHLD"
  | "SIGCONT"
  | "SIGFPE"
  | "SIGHUP"
  | "SIGILL"
  | "SIGINT"
  | "SIGKILL"
  | "SIGPIPE"
  | "SIGQUIT"
  | "SIGSEGV"
  | "SIGSTOP"
  | "SIGTERM"
  | "SIGTRAP"
  | "SIGTSTP"
  | "SIGTTIN"
  | "SIGTTOU"
  | "SIGUSR1"
  | "SIGUSR2"
  | "SIGPOLL"
  | "SIGPROF"
  | "SIGSYS"
  | "SIGURG"
  | "SIGVTALRM"
  | "SIGXCPU"
  | "SIGXFSZ";

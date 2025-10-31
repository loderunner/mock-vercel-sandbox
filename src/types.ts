/**
 * Sandbox status types matching Vercel's API
 */
export type SandboxStatus = "pending" | "running" | "stopping" | "stopped" | "failed";

/**
 * Sandbox runtime types
 */
export type SandboxRuntime = "node22" | "python3.13" | (string & {});

/**
 * Sandbox route data mapping ports to subdomains
 */
export type SandboxRouteData = {
  port: number;
  subdomain: string;
};

/**
 * Sandbox metadata
 */
export type SandboxMetaData = {
  id: string;
  status: SandboxStatus;
  timeout: number;
  cwd: string;
  memory: number;
  vcpus: number;
  runtime: string;
  requestedAt: number;
  createdAt: number;
  updatedAt: number;
  duration?: number;
  startedAt?: number;
  requestedStopAt?: number;
  stoppedAt?: number;
  region?: string;
};

/**
 * Command data structure
 */
export type CommandData = {
  id: string;
  cwd: string;
  startedAt: number;
  exitCode: number | null;
};

/**
 * Credentials for authentication (not used in mock, but matches API)
 */
export type Credentials = {
  token?: string;
  teamId?: string;
};

/**
 * Utility type that extends a type to accept private parameters
 */
export type WithPrivate<T> = T & {
  [K in `__${string}`]?: unknown;
};

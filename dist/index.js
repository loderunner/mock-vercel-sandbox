/**
 * Mock Vercel Sandbox Library
 *
 * This library provides a mock implementation of the Vercel Sandbox API
 * for local development and testing. It uses Docker containers via dockerode
 * to simulate the sandbox environment.
 *
 * @example
 * ```typescript
 * import { Sandbox } from 'mock-vercel-sandbox';
 *
 * const sandbox = await Sandbox.create({
 *   runtime: 'node22',
 *   ports: [3000]
 * });
 *
 * const result = await sandbox.runCommand('node', ['--version']);
 * console.log(result.stdout);
 *
 * await sandbox.stop();
 * ```
 */
export { Sandbox } from "./sandbox.js";
export { Command, CommandFinished } from "./command.js";

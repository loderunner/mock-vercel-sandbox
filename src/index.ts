/**
 * Mock Vercel Sandbox - A Docker-based implementation of the Vercel Sandbox API
 *
 * This library provides a local development environment that mimics the Vercel Sandbox
 * interface using Docker containers. It's designed to be a drop-in replacement for
 * `@vercel/sandbox` during local development and testing.
 *
 * @example
 * ```ts
 * import { Sandbox } from 'mock-vercel-sandbox';
 *
 * // Create a new sandbox
 * const sandbox = await Sandbox.create({
 *   runtime: 'node22',
 *   ports: [3000],
 *   timeout: 60000
 * });
 *
 * // Run a command
 * const result = await sandbox.runCommand('npm', ['install']);
 * console.log(result.exitCode);
 *
 * // Write files
 * await sandbox.writeFiles([
 *   { path: 'package.json', content: Buffer.from('{"name":"test"}') }
 * ]);
 *
 * // Stop the sandbox
 * await sandbox.stop();
 * ```
 *
 * @packageDocumentation
 */

export { Sandbox } from './sandbox';
export { Command, CommandFinished } from './command';

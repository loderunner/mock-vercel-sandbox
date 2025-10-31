/**
 * Vitest setup file example
 *
 * This file shows how to mock @vercel/sandbox with mock-vercel-sandbox
 * in your Vitest setup.
 *
 * Add this to your vitest.config.ts:
 * ```typescript
 * import { defineConfig } from 'vitest/config';
 *
 * export default defineConfig({
 *   test: {
 *     setupFiles: ['./vitest.setup.ts']
 *   }
 * });
 * ```
 */

import { vi } from "vitest";
import * as MockSandbox from "mock-vercel-sandbox";

// Mock @vercel/sandbox to use mock-vercel-sandbox instead
vi.mock("@vercel/sandbox", () => ({
  Sandbox: MockSandbox.Sandbox,
  Command: MockSandbox.Command,
  CommandFinished: MockSandbox.CommandFinished,
}));

// Export types for use in tests
export type { Sandbox, Command, CommandFinished } from "mock-vercel-sandbox";

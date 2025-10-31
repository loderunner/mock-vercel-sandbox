/**
 * Jest setup file example
 *
 * This file shows how to mock @vercel/sandbox with mock-vercel-sandbox
 * in your Jest setup.
 *
 * Add this to your jest.config.js:
 * ```javascript
 * module.exports = {
 *   setupFilesAfterEnv: ['<rootDir>/jest.setup.ts']
 * };
 * ```
 */

import * as MockSandbox from "mock-vercel-sandbox";

// Mock @vercel/sandbox to use mock-vercel-sandbox instead
jest.mock("@vercel/sandbox", () => ({
  Sandbox: MockSandbox.Sandbox,
  Command: MockSandbox.Command,
  CommandFinished: MockSandbox.CommandFinished,
}));

// Export types for use in tests
export type { Sandbox, Command, CommandFinished } from "mock-vercel-sandbox";

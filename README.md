# mock-vercel-sandbox

A mock implementation of the Vercel Sandbox API for local development and testing. This library provides the same interface as `@vercel/sandbox` but uses Docker containers via `dockerode` to run commands locally.

## Installation

```bash
pnpm add mock-vercel-sandbox
# or
npm install mock-vercel-sandbox
# or
yarn add mock-vercel-sandbox
```

## Prerequisites

- Docker must be installed and running
- The Dockerfile in this repository will be built automatically on first use

## Usage

### Basic Usage

```typescript
import { Sandbox } from "mock-vercel-sandbox";

// Create a sandbox
const sandbox = await Sandbox.create({
  runtime: "node22",
  ports: [3000],
  timeout: 3600000, // 1 hour
});

// Run a command
const result = await sandbox.runCommand("node", ["--version"]);
console.log(result.stdout); // v22.14.0

// Stop the sandbox
await sandbox.stop();
```

### Mocking in Tests

#### Vitest Setup

Create `vitest.setup.ts`:

```typescript
import { vi } from "vitest";
import * as MockSandbox from "mock-vercel-sandbox";

vi.mock("@vercel/sandbox", () => ({
  Sandbox: MockSandbox.Sandbox,
  Command: MockSandbox.Command,
  CommandFinished: MockSandbox.CommandFinished,
}));
```

Then in your `vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./vitest.setup.ts"],
  },
});
```

#### Jest Setup

Create `jest.setup.ts`:

```typescript
import * as MockSandbox from "mock-vercel-sandbox";

jest.mock("@vercel/sandbox", () => ({
  Sandbox: MockSandbox.Sandbox,
  Command: MockSandbox.Command,
  CommandFinished: MockSandbox.CommandFinished,
}));
```

Then in your `jest.config.js`:

```javascript
module.exports = {
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
};
```

## API

The API matches `@vercel/sandbox` exactly. See the [Vercel Sandbox documentation](https://vercel.com/docs/sandbox) for full details.

### Sandbox Methods

- `Sandbox.create(params?)` - Create a new sandbox
- `Sandbox.get(params)` - Get an existing sandbox
- `Sandbox.list(params?)` - List sandboxes (returns empty list in mock)
- `sandbox.runCommand(command, args?, opts?)` - Run a command
- `sandbox.getCommand(cmdId, opts?)` - Get a command by ID
- `sandbox.mkDir(path, opts?)` - Create a directory
- `sandbox.readFile(file, opts?)` - Read a file
- `sandbox.writeFiles(files, opts?)` - Write files
- `sandbox.domain(port)` - Get domain for a port
- `sandbox.stop(opts?)` - Stop the sandbox
- `sandbox.extendTimeout(duration, opts?)` - Extend timeout

### Command Methods

- `command.logs(opts?)` - Iterate over command output
- `command.wait(opts?)` - Wait for command completion
- `command.stdout(opts?)` - Get stdout as string
- `command.stderr(opts?)` - Get stderr as string
- `command.output(stream?, opts?)` - Get output as string
- `command.kill(signal?, opts?)` - Kill the command

## Examples

See the `examples/` directory for more usage examples.

## Limitations

- Docker containers are created for each sandbox, which may be slower than the real Vercel Sandbox
- Port routing is mocked (domains are generated but not actually accessible)
- Source cloning from git/tarball is not implemented (containers start empty)
- Command logs for detached commands may not stream in real-time

## License

Apache-2.0

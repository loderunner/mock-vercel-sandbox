# Mock Vercel Sandbox

A Docker-based mock implementation of the Vercel Sandbox for local development and testing.

This library provides a local development environment that mimics the Vercel Sandbox interface using Docker containers. It's designed to be a drop-in replacement for `@vercel/sandbox` during local development and testing.

## Features

- ? **Same API as @vercel/sandbox** - Drop-in replacement with identical interface
- ?? **Docker-based** - Uses Docker containers for true isolation
- ?? **Easy to mock** - Built-in mock helpers for jest and vitest
- ?? **Local development** - No need for cloud resources during development
- ?? **Multiple runtimes** - Supports Node.js 22 and Python 3.13

## Prerequisites

- Docker installed and running
- Node.js 18+ (for running the library)

## Installation

```bash
npm install mock-vercel-sandbox
# or
pnpm add mock-vercel-sandbox
# or
yarn add mock-vercel-sandbox
```

## Usage

### Basic Example

```typescript
import { Sandbox } from 'mock-vercel-sandbox';

// Create a new sandbox
const sandbox = await Sandbox.create({
  runtime: 'node22',
  ports: [3000],
  timeout: 60000 // 60 seconds
});

// Run a command
const result = await sandbox.runCommand('node', ['--version']);
console.log('Exit code:', result.exitCode);
console.log('Output:', await result.stdout());

// Write files
await sandbox.writeFiles([
  {
    path: 'package.json',
    content: Buffer.from(JSON.stringify({ name: 'test' }))
  }
]);

// Read files
const stream = await sandbox.readFile({ path: 'package.json' });
if (stream) {
  stream.pipe(process.stdout);
}

// Stop the sandbox
await sandbox.stop();
```

### With Git Source

```typescript
const sandbox = await Sandbox.create({
  source: {
    type: 'git',
    url: 'https://github.com/user/repo.git',
    depth: 1,
    revision: 'main'
  },
  runtime: 'node22'
});
```

### Running Commands

```typescript
// Simple command
const result = await sandbox.runCommand('npm', ['install']);

// With working directory and environment variables
const result = await sandbox.runCommand({
  cmd: 'npm',
  args: ['test'],
  cwd: '/vercel/sandbox',
  env: { NODE_ENV: 'test' },
  sudo: false
});

// Detached command (don't wait for completion)
const command = await sandbox.runCommand({
  cmd: 'npm',
  args: ['run', 'dev'],
  detached: true
});

// Wait for it later
const result = await command.wait();
console.log('Exit code:', result.exitCode);
```

### Streaming Command Output

```typescript
const command = await sandbox.runCommand({
  cmd: 'npm',
  args: ['install'],
  detached: true
});

// Stream logs in real-time
for await (const log of command.logs()) {
  if (log.stream === 'stdout') {
    process.stdout.write(log.data);
  } else {
    process.stderr.write(log.data);
  }
}

await command.wait();
```

### Port Mapping

```typescript
const sandbox = await Sandbox.create({
  ports: [3000, 8080]
});

// Get the URL for a port
const url = sandbox.domain(3000);
console.log('Server URL:', url); // http://localhost:3000
```

### Managing Sandbox Lifecycle

```typescript
// List all sandboxes
const { sandboxes } = await Sandbox.list();
console.log('Active sandboxes:', sandboxes.length);

// Get an existing sandbox
const sandbox = await Sandbox.get({ sandboxId: 'sandbox-abc123' });

// Extend timeout
await sandbox.extendTimeout(30000); // Add 30 seconds

// Stop sandbox
await sandbox.stop();
```

## Testing with Mocks

This library provides built-in mock helpers for jest and vitest, allowing you to test your code without spinning up actual Docker containers.

### Vitest

```typescript
// In your test setup file (e.g., vitest.setup.ts)
import { vi } from 'vitest';
import { createMockSandbox } from 'mock-vercel-sandbox/mock';

vi.mock('mock-vercel-sandbox', () => createMockSandbox());

// In your tests
import { Sandbox } from 'mock-vercel-sandbox';

describe('my tests', () => {
  it('should create a sandbox', async () => {
    const sandbox = await Sandbox.create({
      runtime: 'node22'
    });
    
    expect(sandbox.sandboxId).toBeDefined();
    expect(sandbox.status).toBe('running');
  });

  it('should run commands', async () => {
    const sandbox = await Sandbox.create();
    const result = await sandbox.runCommand('node', ['--version']);
    
    expect(result.exitCode).toBe(0);
  });
});
```

### Jest

```typescript
// In your test setup file (e.g., jest.setup.js)
import { createMockSandbox } from 'mock-vercel-sandbox/mock';

jest.mock('mock-vercel-sandbox', () => createMockSandbox());

// In your tests
import { Sandbox } from 'mock-vercel-sandbox';

describe('my tests', () => {
  it('should create a sandbox', async () => {
    const sandbox = await Sandbox.create({
      runtime: 'node22'
    });
    
    expect(sandbox.sandboxId).toBeDefined();
    expect(sandbox.status).toBe('running');
  });
});
```

## API Reference

### Sandbox

#### Static Methods

- `Sandbox.create(params?: CreateSandboxParams): Promise<Sandbox>` - Create a new sandbox
- `Sandbox.get(params: GetSandboxParams): Promise<Sandbox>` - Get an existing sandbox
- `Sandbox.list(): Promise<{ sandboxes: SandboxMetaData[], pagination: {...} }>` - List all sandboxes

#### Instance Methods

- `runCommand(cmd: string, args?: string[]): Promise<CommandFinished>` - Run a command and wait for completion
- `runCommand(params: RunCommandParams): Promise<CommandFinished | Command>` - Run a command with options
- `mkDir(path: string): Promise<void>` - Create a directory
- `readFile(file: { path: string, cwd?: string }): Promise<NodeJS.ReadableStream | null>` - Read a file
- `writeFiles(files: { path: string, content: Buffer }[]): Promise<void>` - Write files
- `domain(port: number): string` - Get the URL for an exposed port
- `stop(): Promise<void>` - Stop the sandbox
- `extendTimeout(duration: number): Promise<void>` - Extend the timeout

#### Properties

- `sandboxId: string` - Unique ID of the sandbox
- `status: SandboxStatus` - Current status of the sandbox
- `timeout: number` - Timeout in milliseconds
- `routes: SandboxRouteData[]` - Port mappings

### Command

- `wait(): Promise<CommandFinished>` - Wait for command to finish
- `logs(): AsyncGenerator<{ data: string, stream: 'stdout' | 'stderr' }>` - Stream command output
- `stdout(): Promise<string>` - Get stdout as string
- `stderr(): Promise<string>` - Get stderr as string
- `output(stream?: 'stdout' | 'stderr' | 'both'): Promise<string>` - Get output as string
- `kill(signal?: Signal): Promise<void>` - Kill the running command

### CommandFinished

Extends `Command` with a populated `exitCode` property.

## Docker Image

The library uses a custom Docker image that closely mimics the Vercel Sandbox environment:

- Based on Amazon Linux 2023
- Pre-installed Node.js 22.14.0
- Pre-installed Python 3.13.1
- Pre-installed pnpm 10.19.0
- Matches Vercel's user and directory structure
- Includes common development tools

The Docker image is automatically built on first use if it doesn't exist.

## Differences from @vercel/sandbox

While this library aims to be API-compatible with `@vercel/sandbox`, there are some differences:

1. **Network access**: Uses localhost instead of Vercel's domain system
2. **Resource limits**: Respects Docker resource limits instead of Vercel's infrastructure
3. **Authentication**: No authentication required (it's local)
4. **Persistence**: Containers are ephemeral and removed when stopped

## Development

```bash
# Install dependencies
pnpm install

# Build the library
pnpm run build

# Build the Docker image
pnpm run docker:build

# Clean build artifacts
pnpm run clean
```

## License

Apache-2.0

## Author

Charles Francoise

# Implementation Summary

## Overview

This library provides a Docker-based mock implementation of the Vercel Sandbox API for local development and testing. It offers the same interface as `@vercel/sandbox` but runs containers locally using Docker.

## Architecture

### Core Components

1. **Sandbox** (`src/sandbox.ts`)
   - Main class for managing Docker containers
   - Implements the full Vercel Sandbox API
   - Handles container lifecycle (create, start, stop)
   - Manages file operations and command execution
   - Supports git and tarball sources

2. **Command** (`src/command.ts`)
   - Represents a command execution in a sandbox
   - Streams stdout/stderr output
   - Supports detached and synchronous execution
   - Provides process control (wait, kill)

3. **CommandFinished** (`src/command.ts`)
   - Extends Command with a populated exit code
   - Represents a completed command execution

4. **Types** (`src/types.ts`)
   - Complete type definitions matching @vercel/sandbox
   - Includes all params, metadata, and data structures

5. **Mock** (`src/mock.ts`)
   - Mock implementation for testing
   - No Docker required
   - Works with jest and vitest
   - Same API surface as real implementation

## Features Implemented

### Sandbox Management
- ? Create sandboxes with custom configuration
- ? Get existing sandboxes by ID
- ? List all active sandboxes
- ? Stop sandboxes
- ? Extend sandbox timeout
- ? Port mapping and domain resolution

### Source Handling
- ? Git repository cloning (with depth and revision)
- ? Authenticated git access
- ? Tarball extraction
- ? Empty sandboxes (no source)

### Command Execution
- ? Run commands synchronously
- ? Run commands in detached mode
- ? Stream stdout/stderr in real-time
- ? Custom working directory
- ? Environment variables
- ? Sudo support
- ? Process signals (kill)
- ? Exit code handling

### File Operations
- ? Create directories
- ? Read files (returns readable stream)
- ? Write multiple files (using tar)

### Testing Support
- ? Mock implementation for unit tests
- ? Jest integration helpers
- ? Vitest integration helpers
- ? No Docker required for tests

## Docker Image

The library uses a custom Docker image (`mock-vercel-sandbox`) that closely mimics the Vercel Sandbox environment:

### Base
- Amazon Linux 2023 (matches Vercel)

### Runtimes
- Node.js 22.14.0 (compiled, in `/vercel/runtimes/node22`)
- Python 3.13.1 (compiled with optimizations, in `/vercel/runtimes/python`)
- pnpm 10.19.0 (global)
- uv (Python package manager)

### User Setup
- User: `vercel-sandbox` (uid=1000, gid=1000)
- Passwordless sudo enabled
- Home: `/home/vercel-sandbox`
- Working directory: `/vercel/sandbox`

### Tools
- git, curl, tar, unzip, gzip, zstd
- Build tools (gcc, make)
- Network utilities (bind-utils, iputils)
- Process management (procps-ng)

## API Compatibility

This library provides 100% API compatibility with `@vercel/sandbox`:

```typescript
// These work identically:
import { Sandbox } from '@vercel/sandbox';
import { Sandbox } from 'mock-vercel-sandbox';
```

All methods, parameters, and return types are identical.

## Usage Patterns

### Basic Usage
```typescript
import { Sandbox } from 'mock-vercel-sandbox';

const sandbox = await Sandbox.create();
const result = await sandbox.runCommand('node', ['--version']);
await sandbox.stop();
```

### With Git Source
```typescript
const sandbox = await Sandbox.create({
  source: {
    type: 'git',
    url: 'https://github.com/user/repo.git',
    depth: 1
  }
});
```

### Streaming Output
```typescript
const cmd = await sandbox.runCommand({
  cmd: 'npm',
  args: ['install'],
  detached: true
});

for await (const log of cmd.logs()) {
  console.log(log.stream, log.data);
}

await cmd.wait();
```

### Testing
```typescript
import { vi } from 'vitest';
import { createMockSandbox } from 'mock-vercel-sandbox/mock';

vi.mock('mock-vercel-sandbox', () => createMockSandbox());

// Your tests run without Docker!
```

## File Structure

```
/workspace
??? src/
?   ??? index.ts       # Main exports
?   ??? sandbox.ts     # Sandbox class
?   ??? command.ts     # Command classes
?   ??? types.ts       # Type definitions
?   ??? mock.ts        # Mock implementation
??? dist/              # Built JavaScript + declarations
??? Dockerfile         # Sandbox container image
??? package.json       # Package metadata
??? tsconfig.json      # TypeScript config
??? README.md          # User documentation
??? example.ts         # Usage examples
```

## Build System

- TypeScript compilation with declaration files
- ES2022 target with ES modules
- Full type checking and inference
- Declaration maps for debugging

## Package Publishing

The package is ready to publish to npm with:
- Main entry: `./dist/index.js`
- Mock entry: `./dist/mock.js`
- Type declarations for both
- Clean exports configuration

## Testing

### Mock Tests
```bash
pnpm exec tsx test-mock.ts
```

### Real Docker Tests
```bash
pnpm exec tsx example.ts
```

## Differences from @vercel/sandbox

1. **Network**: Uses `localhost` instead of Vercel's domain system
2. **Authentication**: No authentication required (local Docker)
3. **Resources**: Uses Docker resource limits
4. **Persistence**: Containers are ephemeral (removed on stop)
5. **Build**: Image built locally on first use

## Future Enhancements

Potential additions:
- WebSocket support for real-time updates
- Volume mounting for persistent storage
- Custom Dockerfile support
- Network isolation between sandboxes
- Resource usage metrics
- Container health checks
- Automatic cleanup of orphaned containers

## Dependencies

### Runtime
- `dockerode` - Docker client for Node.js
- `tar-stream` - TAR archive handling

### Development
- `typescript` - Type checking and compilation
- `@types/node` - Node.js type definitions
- `@types/dockerode` - Dockerode type definitions
- `@types/tar-stream` - TAR stream type definitions
- `tsx` - TypeScript execution
- `@vercel/sandbox` - Reference implementation

## License

Apache-2.0

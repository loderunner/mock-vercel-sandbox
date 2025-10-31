## Mock Vercel Sandbox

Local-first implementation of the Vercel sandbox API that uses Docker to provision isolated containers. The goal is to mirror the public API shape of `@vercel/sandbox` closely enough that you can swap this library in for local development and testing.

### Installation

- Ensure Docker is available on your machine and the current user can talk to the Docker daemon.
- Install dependencies with `pnpm install`. The Docker image required for the sandbox will be built automatically the first time you create a sandbox.

The library expects a Dockerfile at the project root that provisions a runtime similar to Vercel?s sandbox. You can override the build inputs using environment variables:

- `MOCK_VERCEL_SANDBOX_DOCKERFILE`: Absolute or relative path to the Dockerfile to build.
- `MOCK_VERCEL_SANDBOX_IMAGE`: Image tag to reuse instead of the default `mock-vercel-sandbox:latest`.

### Basic Usage

```ts
import { Sandbox } from "mock-vercel-sandbox";

async function main() {
  const sandbox = await Sandbox.create({ ports: [3000] });

  const command = await sandbox.runCommand("node", ["--version"]);
  console.log(await command.stdout());

  await sandbox.stop();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

### Mocking With Vitest or Jest

Because this package exports the same `Sandbox`, `Command`, and `CommandFinished` symbols as `@vercel/sandbox`, you can drop it into test environments by aliasing the module name during setup.

#### Vitest

Create `vitest.setup.ts`:

```ts
import { afterAll } from "vitest";

vi.mock("@vercel/sandbox", async () => import("mock-vercel-sandbox"));

afterAll(async () => {
  const { Sandbox } = await import("mock-vercel-sandbox");
  const { sandboxes } = await Sandbox.list();

  for (const metadata of sandboxes) {
    const sandbox = await Sandbox.get({ sandboxId: metadata.id });
    await sandbox.stop();
  }
});
```

Then reference the setup file inside `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: "./vitest.setup.ts",
  },
});
```

#### Jest

Create `jest.setup.ts`:

```ts
jest.mock("@vercel/sandbox", () => require("mock-vercel-sandbox"));

afterAll(async () => {
  const { Sandbox } = await import("mock-vercel-sandbox");
  const { sandboxes } = await Sandbox.list();

  for (const metadata of sandboxes) {
    const sandbox = await Sandbox.get({ sandboxId: metadata.id });
    await sandbox.stop();
  }
});
```

And include the setup file in `jest.config.ts`:

```ts
import type { Config } from "jest";

const config: Config = {
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
};

export default config;
```

### Features

- Automatic Docker image build on first use (configurable via environment variables).
- Port exposure with host mappings, mirroring the `domain` lookup from the real sandbox.
- Command execution with streaming logs, detach / wait support, and signal handling.
- File helpers: `writeFiles`, `readFile`, `mkDir`.
- Timeout management with automatic shutdown.

### Caveats

- The `source` parameter is currently ignored. Source checkout must be present locally and is bind-mounted into the container at `/vercel/sandbox`.
- `Sandbox.getCommand` can only return commands started in the current process.
- You need Docker running locally for the library to function.

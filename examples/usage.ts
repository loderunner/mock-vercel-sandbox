/**
 * Example usage of mock-vercel-sandbox
 *
 * This demonstrates how to use the mock sandbox library
 * in your application code.
 */

import { Sandbox } from "mock-vercel-sandbox";

async function example() {
  // Create a new sandbox
  const sandbox = await Sandbox.create({
    runtime: "node22",
    ports: [3000],
    timeout: 3600000, // 1 hour
  });

  console.log(`Created sandbox: ${sandbox.sandboxId}`);
  console.log(`Status: ${sandbox.status}`);

  // Run a command
  const result = await sandbox.runCommand("node", ["--version"]);
  console.log(`Node version: ${result.stdout}`);

  // Run a command with options
  const pwdResult = await sandbox.runCommand("pwd");
  console.log(`Working directory: ${pwdResult.stdout.trim()}`);

  // Run a detached command
  const detachedCmd = await sandbox.runCommand({
    cmd: "sleep",
    args: ["5"],
    detached: true,
  });
  console.log(`Detached command ID: ${detachedCmd.cmdId}`);

  // Wait for detached command to complete
  const finished = await detachedCmd.wait();
  console.log(`Exit code: ${finished.exitCode}`);

  // Write files
  await sandbox.writeFiles([
    {
      path: "/home/vercel-sandbox/test.txt",
      content: Buffer.from("Hello, World!"),
    },
  ]);

  // Read file
  const fileStream = await sandbox.readFile({
    path: "/home/vercel-sandbox/test.txt",
  });
  if (fileStream) {
    const chunks: Buffer[] = [];
    for await (const chunk of fileStream) {
      chunks.push(chunk);
    }
    console.log(`File contents: ${Buffer.concat(chunks).toString()}`);
  }

  // Create directory
  await sandbox.mkDir("/home/vercel-sandbox/my-project");

  // Get domain for port
  try {
    const domain = sandbox.domain(3000);
    console.log(`Domain: ${domain}`);
  } catch (err) {
    console.log("No route for port 3000");
  }

  // Stop the sandbox
  await sandbox.stop();
  console.log("Sandbox stopped");
}

// Run example
example().catch(console.error);

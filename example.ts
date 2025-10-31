/**
 * Example usage of mock-vercel-sandbox
 * 
 * Run with: tsx example.ts
 */

import { Sandbox } from "./src/index.js";

async function main() {
  console.log("Creating sandbox...");
  
  const sandbox = await Sandbox.create({
    runtime: "node22",
    ports: [3000],
    timeout: 300000, // 5 minutes
  });

  console.log(`Sandbox created with ID: ${sandbox.sandboxId}`);
  console.log(`Status: ${sandbox.status}`);

  // Test basic command
  console.log("\nRunning: node --version");
  const nodeVersion = await sandbox.runCommand("node", ["--version"]);
  console.log(`Exit code: ${nodeVersion.exitCode}`);
  console.log(`Output: ${await nodeVersion.stdout()}`);

  // Test Python
  console.log("\nRunning: python --version");
  const pythonVersion = await sandbox.runCommand("python", ["--version"]);
  console.log(`Exit code: ${pythonVersion.exitCode}`);
  console.log(`Output: ${await pythonVersion.stdout()}`);

  // Write a file
  console.log("\nWriting test.txt...");
  await sandbox.writeFiles([
    {
      path: "test.txt",
      content: Buffer.from("Hello from mock-vercel-sandbox!"),
    },
  ]);

  // Read the file back
  console.log("Reading test.txt...");
  const catResult = await sandbox.runCommand("cat", ["test.txt"]);
  console.log(`File contents: ${await catResult.stdout()}`);

  // Test port domain
  if (sandbox.routes.length > 0) {
    console.log(`\nPort 3000 domain: ${sandbox.domain(3000)}`);
  }

  // List all sandboxes
  console.log("\nListing all sandboxes...");
  const { sandboxes } = await Sandbox.list();
  console.log(`Found ${sandboxes.length} sandbox(es)`);

  // Clean up
  console.log("\nStopping sandbox...");
  await sandbox.stop();
  console.log("Sandbox stopped successfully!");
}

main().catch(console.error);

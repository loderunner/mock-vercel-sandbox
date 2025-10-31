/**
 * A command executed in a Sandbox.
 *
 * For detached commands, you can {@link wait} to get a {@link CommandFinished} instance
 * with the populated exit code. For non-detached commands, {@link Sandbox.runCommand}
 * automatically waits and returns a {@link CommandFinished} instance.
 *
 * You can iterate over command output with {@link logs}.
 *
 * @see {@link Sandbox.runCommand} to start a command.
 */
export class Command {
    sandboxId;
    cmd;
    /**
     * Exit code of the command. Null if command hasn't finished yet.
     */
    exitCode;
    constructor(params) {
        this.sandboxId = params.sandboxId;
        this.cmd = params.cmd;
        this.exitCode = params.cmd.exitCode;
    }
    /**
     * ID of the command execution.
     */
    get cmdId() {
        return this.cmd.id;
    }
    get cwd() {
        return this.cmd.cwd;
    }
    get startedAt() {
        return this.cmd.startedAt;
    }
    /**
     * Iterate over the output of this command.
     *
     * @param opts - Optional parameters.
     * @param opts.signal - An AbortSignal to cancel log streaming.
     * @returns An async iterable of log entries from the command output.
     */
    async *logs(opts) {
        // Check if aborted
        if (opts?.signal?.aborted) {
            return;
        }
        // In the mock implementation, we don't stream logs in real-time
        // This would need to be implemented by reading from Docker container logs
        // For now, return empty generator
        yield* [];
    }
    /**
     * Wait for a command to exit and populate its exit code.
     *
     * @param params - Optional parameters.
     * @param params.signal - An AbortSignal to cancel waiting.
     * @returns A {@link CommandFinished} instance with populated exit code.
     */
    async wait(params) {
        if (params?.signal?.aborted) {
            throw new Error("Operation aborted");
        }
        // Wait for command to complete
        // In real implementation, this would poll the container
        while (this.exitCode === null) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            if (params?.signal?.aborted) {
                throw new Error("Operation aborted");
            }
        }
        return new CommandFinished({
            sandboxId: this.sandboxId,
            cmd: { ...this.cmd, exitCode: this.exitCode },
            exitCode: this.exitCode,
        });
    }
    /**
     * Get the output of `stdout`, `stderr`, or both as a string.
     *
     * @param stream - The output stream to read: "stdout", "stderr", or "both".
     * @param opts - Optional parameters.
     * @param opts.signal - An AbortSignal to cancel output streaming.
     * @returns The output of the specified stream(s) as a string.
     */
    async output(stream = "both", opts) {
        if (opts?.signal?.aborted) {
            throw new Error("Operation aborted");
        }
        // In mock implementation, this would read from Docker container logs
        // For now, return empty string
        return "";
    }
    /**
     * Get the output of `stdout` as a string.
     *
     * @param opts - Optional parameters.
     * @param opts.signal - An AbortSignal to cancel output streaming.
     * @returns The standard output of the command.
     */
    async stdout(opts) {
        return this.output("stdout", opts);
    }
    /**
     * Get the output of `stderr` as a string.
     *
     * @param opts - Optional parameters.
     * @param opts.signal - An AbortSignal to cancel output streaming.
     * @returns The standard error output of the command.
     */
    async stderr(opts) {
        return this.output("stderr", opts);
    }
    /**
     * Kill a running command in a sandbox.
     *
     * @param signal - The signal to send the running process. Defaults to SIGTERM.
     * @param opts - Optional parameters.
     * @param opts.abortSignal - An AbortSignal to cancel the kill operation.
     * @returns Promise<void>.
     */
    async kill(signal = "SIGTERM", opts) {
        if (opts?.abortSignal?.aborted) {
            throw new Error("Operation aborted");
        }
        // In mock implementation, this would kill the process in the Docker container
        // For now, just mark as killed
        this.exitCode = signal === "SIGKILL" ? 137 : 143;
    }
}
/**
 * A command that has finished executing.
 *
 * The exit code is immediately available and populated upon creation.
 * Unlike {@link Command}, you don't need to call wait() - the command
 * has already completed execution.
 */
export class CommandFinished extends Command {
    /**
     * The exit code of the command. This is always populated for
     * CommandFinished instances.
     */
    exitCode;
    constructor(params) {
        super({ sandboxId: params.sandboxId, cmd: params.cmd });
        this.exitCode = params.exitCode;
    }
    /**
     * The wait method is not needed for CommandFinished instances since
     * the command has already completed and exitCode is populated.
     *
     * @deprecated This method is redundant for CommandFinished instances.
     * The exitCode is already available.
     * @returns This CommandFinished instance.
     */
    async wait() {
        return this;
    }
}

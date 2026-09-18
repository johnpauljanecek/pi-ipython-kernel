/**
 * Fixture for the BUG-13a regression test in tests/lib.test.ts.
 *
 * Stands in for pi spawning a kernel: start a long-lived grandchild, print its
 * pid, and finish. Whether *this* process is then able to exit is the whole
 * question — anything left on node's event loop keeps the process alive for the
 * child's full lifetime, which is what a scripted `pi -p` run did after
 * `kernel_start`.
 *
 * Usage: node tests/fixtures/detached-fanout.ts <mode> [logFile]
 *
 *   unref        the fixed path — spawnDetached() (bridge shape: stdin pipe + unref)
 *   noref        raw spawn, nothing unref'd — the child handle keeps the loop open
 *   execa-file   the pre-fix shape exactly: execa with `stdout: { file: … }` and
 *                `cleanup: false`, then unref() — this is what hung pi
 *
 * The grandchild is `node -e 'setTimeout(() => {}, 60000)'`: it must outlive
 * this process, so the test can assert it is still running afterwards.
 */
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { execa } from "execa";
import { spawnDetached } from "../../extensions/lib.ts";

const mode = process.argv[2] ?? "unref";
const logFile = process.argv[3] ?? "/tmp/pi-ipython-kernel-fanout.log";
const LINGER = ["-e", "setTimeout(() => {}, 60000)"];

let pid: number | null = null;

if (mode === "execa-file") {
	// Pre-fix kernel/bridge spawn: detached + no cleanup hook + file logging,
	// with the child unref'd. The file-output stream is what keeps the loop open.
	const proc = execa(process.execPath, LINGER, {
		detached: true,
		cleanup: false,
		stdout: { file: logFile },
		stderr: { file: logFile },
	});
	proc.unref();
	proc.catch(() => {});
	pid = proc.pid ?? null;
} else if (mode === "noref") {
	// Same spawn shape as the fix, but nothing is unref'd.
	const fd = openSync(logFile, "a");
	pid = spawn(process.execPath, LINGER, { detached: true, stdio: ["ignore", fd, fd] }).pid ?? null;
} else {
	pid = spawnDetached(process.execPath, LINGER, {
		cwd: process.cwd(),
		logFile,
		keepStdinPipe: true,
	}).pid;
}

process.stdout.write(`${JSON.stringify({ mode, pid })}\n`);

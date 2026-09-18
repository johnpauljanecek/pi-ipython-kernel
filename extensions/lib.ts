/**
 * Pure, testable helpers for the pi-ipython-kernel extension.
 *
 * No pi imports — safe to import directly from Node tests (see tests/).
 * The extension (index.ts) imports from here; this module only depends on
 * Node builtins and `execa`.
 */
import { execa } from "execa";
import { spawn, type ChildProcess } from "child_process";
import {
	readFileSync,
	writeFileSync,
	existsSync,
	mkdirSync,
	renameSync,
	rmSync,
	readdirSync,
	openSync,
	closeSync,
} from "fs";
import { resolve, join } from "path";
import { homedir } from "os";
import { createServer } from "net";

export const KERNELS_DIR = join(homedir(), ".ipy", "kernels");

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function expandUser(path: string): string {
	if (path.startsWith("~/")) {
		return resolve(homedir(), path.slice(2));
	}
	return path;
}

export function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function slugify(s: string): string {
	return s.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "kernel";
}

// ---------------------------------------------------------------------------
// Kernel registry (~/.ipy/kernels/<name>/)
// ---------------------------------------------------------------------------

export interface KernelMeta {
	name: string;
	kernel_pid: number;
	bridge_pid: number | null;
	bridge_port: number;
	kernel_file: string;
	python: string;
	cwd: string;
	started_at: string;
	started_by: string;
	external: boolean;
	auth_token: string;
}

export function kernelDir(name: string): string {
	return join(KERNELS_DIR, name);
}

export function metaPath(name: string): string {
	return join(kernelDir(name), "meta.json");
}

export function readMeta(name: string): KernelMeta | null {
	try {
		return JSON.parse(readFileSync(metaPath(name), "utf-8")) as KernelMeta;
	} catch {
		return null;
	}
}

export function writeMeta(name: string, meta: KernelMeta): void {
	const dir = kernelDir(name);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const finalPath = metaPath(name);
	const tmpPath = `${finalPath}.tmp`;
	writeFileSync(tmpPath, JSON.stringify(meta, null, 2), "utf-8");
	renameSync(tmpPath, finalPath);
}

export function deleteKernelDir(name: string): void {
	try {
		rmSync(kernelDir(name), { recursive: true, force: true });
	} catch {
		/* already gone */
	}
}

export function listKernelNames(): string[] {
	try {
		if (!existsSync(KERNELS_DIR)) return [];
		return readdirSync(KERNELS_DIR, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => d.name);
	} catch {
		return [];
	}
}

export function findKernelByFile(file: string): string | null {
	const target = resolve(file);
	for (const name of listKernelNames()) {
		const meta = readMeta(name);
		if (meta && resolve(meta.kernel_file) === target) return name;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

export function pidAlive(pid: number): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export async function procStartTime(pid: number): Promise<string | null> {
	try {
		const { stdout } = await execa("ps", ["-o", "lstart=", "-p", String(pid)], { reject: false });
		return stdout.trim() || null;
	} catch {
		return null;
	}
}

export async function kernelIsAlive(meta: KernelMeta): Promise<boolean> {
	if (!pidAlive(meta.kernel_pid)) return false;
	if (!meta.started_at) return true;
	const nowStart = await procStartTime(meta.kernel_pid);
	return nowStart === meta.started_at;
}

export function findFreePort(): Promise<number> {
	return new Promise((res, rej) => {
		const srv = createServer();
		srv.unref();
		srv.on("error", rej);
		srv.listen(0, "127.0.0.1", () => {
			const address = srv.address();
			const port = typeof address === "object" && address ? address.port : 0;
			srv.close(() => res(port));
		});
	});
}

// ---------------------------------------------------------------------------
// Spawn command (kernel_start python matrix, step 16)
// ---------------------------------------------------------------------------

export function buildKernelCommand(python: string, kernelFile: string): string[] {
	if (!python) {
		return ["tool", "run", "--from", "ipython", "--with", "ipykernel", "python", "-m", "ipykernel", "-f", kernelFile];
	}
	if (python === "project") {
		return ["run", "--with", "ipykernel", "python", "-m", "ipykernel", "-f", kernelFile];
	}
	if (python.includes("/")) {
		// Interpreter/venv path: use the venv's own packages (playwright etc.)
		// with ipykernel overlaid via --with. Do NOT use --isolated (it builds a
		// fresh env ignoring the venv's site-packages), and do NOT use a bare
		// `uv run --python` inside a project dir (uv would silently switch to the
		// project env) — hence --no-project.
		return ["run", "--no-project", "--python", python, "--with", "ipykernel", "python", "-m", "ipykernel", "-f", kernelFile];
	}
	// Version spec (e.g. "3.11"): no existing env — fresh --isolated env + ipykernel
	return ["run", "--isolated", "--python", python, "--with", "ipykernel", "python", "-m", "ipykernel", "-f", kernelFile];
}

// ---------------------------------------------------------------------------
// Detached spawning (BUG-13a)
// ---------------------------------------------------------------------------

export interface DetachedChild {
	/** Child pid, or null when the spawn failed outright. */
	pid: number | null;
	/** Spawn failure or a non-zero exit, or null while the child looks healthy. */
	failure: () => string | null;
}

/**
 * Spawn a long-lived helper (kernel or bridge) that must outlive pi.
 *
 * Three properties are needed and each is load-bearing:
 *
 *  - `detached: true` puts the child in its own process group, so a signal
 *    aimed at pi's group cannot reach the kernel and the child is not tied to
 *    pi's lifetime. This is what execa's `cleanup: false` was for — its default
 *    (`true`) installed a parent-exit hook that killed kernels on a graceful
 *    quit, contradicting "kernels persist across sessions".
 *  - stdout/stderr go to the log file as an **fd** (opened here, closed here).
 *    execa's `stdout: { file: … }` instead built a *referenced* stream in this
 *    process that held the event loop open for the child's whole lifetime, which
 *    is why a scripted `pi -p` run that started a kernel never exited (BUG-13a).
 *    Measured before/after: a 5 s child kept the parent alive 5.08 s with
 *    execa `{ file }`; with this fd spawn the parent exits in ~0.03 s.
 *  - `unref()` on the child, and on its stdin pipe when there is one. The child
 *    handle must be unref'd or the loop never ends. The pipe unref is insurance
 *    rather than the fix — measured on Node v26.8.2, a referenced but unwritten
 *    stdin pipe does *not* hold the loop by itself (older releases did), and it
 *    cannot simply be closed: the bridge keeps its read end as a liveness signal
 *    (`--stdin-watch`), so EOF on it must mean "pi is gone", not "the spawn
 *    helper returned".
 */
export function spawnDetached(
	command: string,
	args: string[],
	opts: { cwd: string; logFile: string; keepStdinPipe?: boolean },
): DetachedChild {
	const logFd = openSync(opts.logFile, "a");
	let failure: string | null = null;
	let child: ChildProcess;
	try {
		child = spawn(command, args, {
			cwd: opts.cwd,
			detached: true,
			stdio: [opts.keepStdinPipe ? "pipe" : "ignore", logFd, logFd],
		});
	} finally {
		// The child holds its own dup of the fd; this copy is ours to close.
		closeSync(logFd);
	}

	child.on("error", (err) => {
		failure = errMsg(err);
	});
	child.on("exit", (code, signal) => {
		if (failure === null && code !== 0) {
			failure = signal ? `killed by signal ${signal}` : `exited with code ${code}`;
		}
	});

	child.unref();
	if (opts.keepStdinPipe) {
		// A spawned stdin pipe is a Socket on POSIX and does have unref(); see the
		// note above on why this is insurance rather than the fix.
		(child.stdin as unknown as { unref?: () => void } | null)?.unref?.();
	}

	return { pid: child.pid ?? null, failure: () => failure };
}

/**
 * Pure, testable helpers for the ipyforge-kernel extension.
 *
 * No pi imports — safe to import directly from Node tests (see tests/).
 * The extension (index.ts) imports from here; this module only depends on
 * Node builtins and `execa`.
 */
import { execa } from "execa";
import {
	readFileSync,
	writeFileSync,
	existsSync,
	mkdirSync,
	renameSync,
	rmSync,
	readdirSync,
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
	// Version spec (e.g. "3.11") or absolute interpreter/venv path
	return ["run", "--isolated", "--python", python, "--with", "ipykernel", "python", "-m", "ipykernel", "-f", kernelFile];
}

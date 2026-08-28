/**
 * Node tests for the extension's pure, testable helpers (extensions/lib.ts).
 *
 * Run with:  node --test tests/lib.test.ts   (Node >= 22.6, native TS type-stripping)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	buildKernelCommand,
	deleteKernelDir,
	expandUser,
	findFreePort,
	findKernelByFile,
	kernelIsAlive,
	listKernelNames,
	pidAlive,
	procStartTime,
	readMeta,
	slugify,
	writeMeta,
	type KernelMeta,
} from "../extensions/lib.ts";

function baseMeta(name: string): KernelMeta {
	return {
		name,
		kernel_pid: 0,
		bridge_pid: null,
		bridge_port: 0,
		kernel_file: `/tmp/${name}/kernel.json`,
		python: "",
		cwd: "/tmp",
		started_at: "",
		started_by: "test",
		external: false,
		auth_token: "",
	};
}

// ---------------------------------------------------------------------------
// Spawn command matrix (step 16)
// ---------------------------------------------------------------------------

test("buildKernelCommand: default python ('' → uv tool run --from ipython --with ipykernel)", () => {
	assert.deepEqual(buildKernelCommand("", "/k/kernel.json"), [
		"tool", "run", "--from", "ipython", "--with", "ipykernel", "python", "-m", "ipykernel", "-f", "/k/kernel.json",
	]);
});

test("buildKernelCommand: 'project' (uv run --with ipykernel, project env)", () => {
	assert.deepEqual(buildKernelCommand("project", "/k/kernel.json"), [
		"run", "--with", "ipykernel", "python", "-m", "ipykernel", "-f", "/k/kernel.json",
	]);
});

test("buildKernelCommand: version spec (uv run --isolated --python <spec> --with ipykernel)", () => {
	const cmd = buildKernelCommand("3.11", "/k/kernel.json");
	assert.deepEqual(cmd, [
		"run", "--isolated", "--python", "3.11", "--with", "ipykernel", "python", "-m", "ipykernel", "-f", "/k/kernel.json",
	]);
});

test("buildKernelCommand: interpreter/venv path (uv run --no-project --python <path> --with ipykernel)", () => {
	const cmd = buildKernelCommand("/opt/venv/bin/python", "/k/kernel.json");
	assert.deepEqual(cmd, [
		"run", "--no-project", "--python", "/opt/venv/bin/python", "--with", "ipykernel", "python", "-m", "ipykernel", "-f", "/k/kernel.json",
	]);
});

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

test("expandUser expands ~/ only", () => {
	assert.equal(expandUser("/abs/path"), "/abs/path");
	assert.ok(expandUser("~/foo").endsWith("/foo"));
	assert.ok(expandUser("~/foo").startsWith("/"));
});

test("slugify produces path-safe names", () => {
	assert.equal(slugify("a b/c"), "a-b-c");
	assert.equal(slugify("already.safe-name"), "already.safe-name");
	assert.equal(slugify("///"), "kernel"); // fallback
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test("registry: write/read/list/find/delete round-trip", () => {
	const name = `__test__${process.pid}`;
	const meta = baseMeta(name);
	meta.python = "3.11";
	try {
		writeMeta(name, meta);
		assert.deepEqual(readMeta(name), meta);
		assert.ok(listKernelNames().includes(name));
		assert.equal(findKernelByFile(meta.kernel_file), name);
	} finally {
		deleteKernelDir(name);
	}
	assert.equal(readMeta(name), null);
	assert.ok(!listKernelNames().includes(name));
});

test("registry: readMeta returns null for unknown name", () => {
	assert.equal(readMeta(`__missing__${process.pid}`), null);
});

// ---------------------------------------------------------------------------
// Liveness (PID-reuse guard)
// ---------------------------------------------------------------------------

test("pidAlive rejects invalid pids", () => {
	assert.equal(pidAlive(0), false);
	assert.equal(pidAlive(-1), false);
});

test("kernelIsAlive: alive pid + matching start time => true; wrong start time => false (PID reuse)", async () => {
	const child = spawn("sleep", ["5"]);
	const pid = child.pid;
	try {
		assert.equal(pidAlive(pid), true);
		const start = await procStartTime(pid);
		assert.ok(start, "procStartTime should return a non-empty string");

		const meta = baseMeta("liveness");
		meta.kernel_pid = pid;
		meta.started_at = start!;
		assert.equal(await kernelIsAlive(meta), true, "matching start time → alive");

		const reused = { ...meta, started_at: "Thu Jan  1 00:00:00 1970" };
		assert.equal(await kernelIsAlive(reused), false, "start-time mismatch → treated as dead (never signal a recycled PID)");
	} finally {
		child.kill("SIGKILL");
	}
});

test("kernelIsAlive: dead pid => false", async () => {
	const meta = baseMeta("dead");
	meta.kernel_pid = 999_999_999; // effectively never a live pid
	assert.equal(await kernelIsAlive(meta), false);
});

// ---------------------------------------------------------------------------
// findFreePort
// ---------------------------------------------------------------------------

test("findFreePort returns a valid ephemeral port", async () => {
	const port = await findFreePort();
	assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
});

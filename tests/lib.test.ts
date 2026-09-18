/**
 * Node tests for the extension's pure, testable helpers (extensions/lib.ts).
 *
 * Run with:  node --test tests/lib.test.ts   (Node >= 22.6, native TS type-stripping)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
	buildKernelCommand,
	deleteKernelDir,
	expandUser,
	findFreePort,
	findKernelByFile,
	isGroupLeader,
	kernelIsAlive,
	killTree,
	listKernelNames,
	pidAlive,
	pidsInGroup,
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

// ---------------------------------------------------------------------------
// spawnDetached — BUG-13a: pi must be able to exit while its child lives on
// ---------------------------------------------------------------------------

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "detached-fanout.ts");
const FIXTURE_LOG = join(tmpdir(), `pi-ipython-kernel-fanout-${process.pid}.log`);

function alive(pid: number | null): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function reap(pid: number | null): void {
	if (!alive(pid)) return;
	try {
		process.kill(pid as number, "SIGKILL");
	} catch {
		/* already gone */
	}
}

/** Start the fixture and resolve once it has printed its grandchild pid. */
async function startFixture(mode: string): Promise<{
	child: ChildProcess;
	pid: number | null;
	exited: Promise<{ code: number | null; signal: string | null }>;
}> {
	const child = spawn(process.execPath, [FIXTURE, mode, FIXTURE_LOG], { stdio: ["ignore", "pipe", "pipe"] });
	const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
		child.on("exit", (code, signal) => resolve({ code, signal }));
	});

	let buffered = "";
	const firstLine = new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`fixture '${mode}' printed nothing`)), 10_000);
		child.stdout!.on("data", (chunk) => {
			buffered += String(chunk);
			const nl = buffered.indexOf("\n");
			if (nl >= 0) {
				clearTimeout(timer);
				resolve(buffered.slice(0, nl));
			}
		});
		child.on("exit", () => {
			clearTimeout(timer);
			reject(new Error(`fixture '${mode}' exited before printing its pid`));
		});
	});

	const parsed = JSON.parse(await firstLine) as { pid: number | null };
	return { child, pid: parsed.pid, exited };
}

/** Wait up to `ms`; resolves the exit result, or null if still running. */
async function exitedWithin(
	exited: Promise<{ code: number | null; signal: string | null }>,
	ms: number,
): Promise<{ code: number | null; signal: string | null } | null> {
	return Promise.race([exited, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

test("spawnDetached: the parent exits on its own while the child keeps running (BUG-13a)", async () => {
	const { child, pid, exited } = await startFixture("unref");
	try {
		const result = await exitedWithin(exited, 10_000);
		assert.notEqual(result, null, "fixture must exit without being killed — an un-unref'd handle kept the loop alive");
		assert.equal(result!.code, 0, `fixture should exit cleanly, got ${JSON.stringify(result)}`);
		assert.ok(pid, "fixture reported a grandchild pid");
		assert.equal(alive(pid), true, "the detached child must still be running after the parent exited");
	} finally {
		child.kill("SIGKILL");
		reap(pid);
	}
});

test("spawnDetached control: an un-unref'd child keeps the parent alive (the pre-fix shape)", async () => {
	const { child, pid, exited } = await startFixture("noref");
	try {
		const result = await exitedWithin(exited, 2500);
		assert.equal(result, null, "without unref() the fixture must still be hanging — otherwise this test proves nothing");
		assert.equal(alive(pid), true);
	} finally {
		child.kill("SIGKILL");
		reap(pid);
	}
});

test("spawnDetached control: the pre-fix execa `stdout: { file }` shape keeps the parent alive", async () => {
	// This is the historical defect, reproduced: execa's file-output stream is a
	// referenced handle, so `pi -p` stayed alive for the child's whole lifetime
	// even though the child itself was unref'd. Measured on the pre-fix code:
	// a 5 s child kept the parent alive 5.08 s; the fd-based spawn above exits
	// in ~0.03 s.
	const { child, pid, exited } = await startFixture("execa-file");
	try {
		const result = await exitedWithin(exited, 2500);
		assert.equal(result, null, "execa {file: …} must still be hanging — otherwise this control proves nothing");
		assert.equal(alive(pid), true);
	} finally {
		child.kill("SIGKILL");
		reap(pid);
	}
});

// ---------------------------------------------------------------------------
// killTree / pidsInGroup — BUG-12: kill the group, not the handle
// ---------------------------------------------------------------------------

async function waitUntil(pred: () => boolean, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (pred()) return true;
		await new Promise((r) => setTimeout(r, 50));
	}
	return pred();
}

function spawnSleep(seconds: number, detached: boolean): ChildProcess {
	return spawn("sleep", [String(seconds)], { detached, stdio: ["ignore", "ignore", "ignore"] });
}

function killAll(...procs: ChildProcess[]): void {
	for (const p of procs) {
		try {
			p.kill("SIGKILL");
		} catch {
			/* already gone */
		}
	}
}

test("isGroupLeader: true for a detached spawn, false for a child sharing our group", async () => {
	const detached = spawnSleep(30, true);
	const inOurGroup = spawnSleep(30, false);
	try {
		assert.equal(await isGroupLeader(detached.pid!), true, "detached children lead their own group");
		assert.equal(
			await isGroupLeader(inOurGroup.pid!),
			false,
			"a non-detached child stays in this process's group — signalling -pid would hit us",
		);
	} finally {
		killAll(detached, inOurGroup);
	}
});

test("killTree reaps a detached leader and the grandchild under it (the kernel's shape)", async () => {
	// uv wrapper -> python child, in miniature: a detached leader with a child of
	// its own. Killing only the leader is exactly what left ipykernel orphaned.
	const script = [
		'const { spawn } = require("child_process");',
		'const kid = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { stdio: "ignore" });',
		'process.stdout.write(String(kid.pid) + "\\n");',
		"setTimeout(() => {}, 60000);",
	].join("\n");
	const leader = spawn(process.execPath, ["-e", script], {
		detached: true,
		stdio: ["ignore", "pipe", "ignore"],
	});
	let grandchild: number | null = null;
	try {
		grandchild = await new Promise<number>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("leader never reported its child")), 10_000);
			let buffered = "";
			leader.stdout!.on("data", (chunk) => {
				buffered += String(chunk);
				const nl = buffered.indexOf("\n");
				if (nl >= 0) {
					clearTimeout(timer);
					resolve(Number(buffered.slice(0, nl)));
				}
			});
		});

		const group = await pidsInGroup(leader.pid!);
		assert.ok(group.includes(leader.pid!), "the leader is in its own group");
		assert.ok(group.includes(grandchild), `the group must include the grandchild, got [${group.join(", ")}]`);

		const result = await killTree(leader.pid!);
		assert.equal(result?.group, true, "a detached leader must be signalled as a group");

		assert.equal(await waitUntil(() => !alive(leader.pid) && !alive(grandchild), 3000), true);
		assert.equal(alive(grandchild), false, "the grandchild must go with the group, not survive as an orphan");
		assert.deepEqual(await pidsInGroup(leader.pid!), [], "no members may be left in the group");
	} finally {
		reap(leader.pid);
		reap(grandchild);
	}
});

test("killTree on a non-leader signals only that pid, never the shared process group", async () => {
	// The guard that matters: process groups are keyed by a leader's pid, so a
	// recycled pid could name an unrelated group. A bystander in our own group
	// proves the group was left alone.
	const victim = spawnSleep(30, false);
	const bystander = spawnSleep(30, false);
	try {
		const result = await killTree(victim.pid!);
		assert.equal(result?.group, false, "a non-leader is signalled by pid only");
		assert.equal(await waitUntil(() => !alive(victim.pid), 2000), true);
		assert.equal(alive(victim.pid), false);
		assert.equal(alive(bystander.pid), true, "a sibling in the same group must survive");
	} finally {
		killAll(victim, bystander);
	}
});

test("killTree returns null when there is nothing to kill", async () => {
	assert.equal(await killTree(null), null);
	assert.equal(await killTree(999_999_999), null);
});

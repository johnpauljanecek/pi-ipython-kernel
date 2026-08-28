/**
 * @johnjanecek/ipyforge-kernel — Pi extension
 *
 * Installed via: pi install /path/to/ipython_package
 *
 * Registers 10 custom tools that manage persistent, named IPython kernels. Each
 * kernel owns a companion FastAPI bridge (one per kernel, never shared) that
 * wraps jupyter_client.BlockingKernelClient. Kernels and their bridges are
 * registered under ~/.ipy/kernels/<name>/ and outlive pi sessions; they are
 * stopped explicitly via kernel_stop (or reaped by kernel_list when dead).
 *
 * Tools:
 *   kernel_start        — start a new named IPython kernel (persistent)
 *   kernel_connect      — attach to a kernel by name, or an external kernel.json
 *   kernel_run_python   — execute Python code in the connected kernel
 *   kernel_eval_expr    — evaluate a Python expression
 *   kernel_interrupt    — interrupt the running kernel
 *   kernel_get_output   — retrieve cached output from the last run
 *   kernel_list         — list kernels in the registry (prunes dead entries)
 *   kernel_stop         — stop a kernel (and its bridge)
 *   kernel_status       — show the connected kernel + registry state
 *   kernel_console_cmd  — one-line command to attach a Jupyter console
 */

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execa } from "execa";
import { readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync } from "fs";
import { resolve, join, basename } from "path";
import { homedir } from "os";
import { randomBytes } from "crypto";
import {
	buildKernelCommand,
	deleteKernelDir,
	errMsg,
	expandUser,
	findFreePort,
	findKernelByFile,
	kernelDir,
	kernelIsAlive,
	listKernelNames,
	pidAlive,
	procStartTime,
	readMeta,
	slugify,
	writeMeta,
	KERNELS_DIR,
	type KernelMeta,
} from "./lib";

const CONFIG_FILENAME = "cfg.json";
const CONTROL_TIMEOUT_MS = 10_000;
const TIMEOUT_MARGIN_S = 15;
const BRIDGE_START_TIMEOUT_MS = 30_000;
const KERNEL_FILE_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
	return new Promise<void>((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Config (user preferences only — runtime state lives in the kernel registry)
// ---------------------------------------------------------------------------

interface Config {
	python: string;
	default_cwd: string;
	max_output_chars: number;
	default_timeout_s: number;
	kernel_channel_timeout_s: number;
	default_connect: string;
	auth_token: string;
}

function getExtensionDir(): string {
	// __dirname is the extensions/ directory
	return resolve(__dirname, "..");
}

function loadConfig(): Config {
	const cfgPath = resolve(getExtensionDir(), CONFIG_FILENAME);
	if (!existsSync(cfgPath)) {
		return getDefaultConfig();
	}
	const raw = JSON.parse(readFileSync(cfgPath, "utf-8")) as Partial<Config>;
	const expanded: Partial<Config> = { ...raw };
	if (typeof expanded.default_cwd === "string") {
		expanded.default_cwd = expandUser(expanded.default_cwd);
	}
	if (typeof expanded.default_connect === "string" && expanded.default_connect.startsWith("~/")) {
		expanded.default_connect = expandUser(expanded.default_connect);
	}
	return getDefaultConfig(expanded);
}

function getDefaultConfig(overrides: Partial<Config> = {}): Config {
	return {
		python: "",
		default_cwd: homedir(),
		max_output_chars: 20000,
		default_timeout_s: 60,
		kernel_channel_timeout_s: 5,
		default_connect: "",
		auth_token: "",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Kernel registry (~/.ipy/kernels/<name>/)
// ---------------------------------------------------------------------------

async function waitForKernelFile(path: string, timeoutMs = KERNEL_FILE_TIMEOUT_MS): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(path)) return;
		await sleep(200);
	}
	throw new Error(`Kernel connection file not created within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

let connectedName: string | null = null;
const bridgeStartPromises = new Map<string, Promise<number>>();

async function stopBridge(meta: KernelMeta): Promise<void> {
	// Graceful: /shutdown makes the actual python bridge os._exit(0). This is
	// the reliable path because `meta.bridge_pid` is the `uv run` wrapper, which
	// spawns the python bridge as a child — killing the wrapper alone would
	// orphan the bridge. Always try /shutdown first.
	if (await bridgeHealthy(meta.bridge_port)) {
		try {
			const headers: Record<string, string> = {};
			if (meta.auth_token) headers["X-IPY-TOKEN"] = meta.auth_token;
			await fetch(`http://127.0.0.1:${meta.bridge_port}/shutdown`, {
				method: "POST",
				headers,
				signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
			});
			await sleep(400); // let os._exit fire
		} catch {
			/* bridge may already be gone */
		}
	}
	// Fallback: hard-kill the uv wrapper (best effort)
	if (meta.bridge_pid && pidAlive(meta.bridge_pid)) {
		try { process.kill(meta.bridge_pid, "SIGKILL"); } catch { /* gone */ }
	}
}

async function bridgeHealthy(port: number): Promise<boolean> {
	try {
		await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
		return true;
	} catch {
		return false;
	}
}

async function waitForHealth(port: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await bridgeHealthy(port)) return;
		await sleep(300);
	}
	throw new Error(`Bridge failed to become healthy on port ${port} within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Spawn helpers (detached, file-logged)
// ---------------------------------------------------------------------------

function spawnKernel(kernelFile: string, python: string, cwd: string, logFile: string): ReturnType<typeof execa> {
	const proc = execa("uv", buildKernelCommand(python, kernelFile), {
		cwd,
		detached: true,
		stdout: { file: logFile },
		stderr: { file: logFile },
	});
	proc.catch(() => {
		/* process exit tracked separately; errors surface via kernel.json / log */
	});
	return proc;
}

function spawnBridge(name: string, kernelFile: string, port: number, token: string): ReturnType<typeof execa> {
	const args = [
		"run",
		"--with", "fastapi",
		"--with", "uvicorn",
		"--with", "jupyter_client",
		"--with", "pyzmq",
		"--with", "pydantic",
		"python", "server/main.py",
		"--kernel-file", kernelFile,
		"--port", String(port),
		"--token", token,
	];
	const logFile = join(kernelDir(name), "bridge.log");
	const proc = execa("uv", args, {
		cwd: getExtensionDir(),
		detached: true,
		stdout: { file: logFile },
		stderr: { file: logFile },
	});
	proc.catch(() => {
		/* bridge exit tracked via health checks */
	});
	return proc;
}

// ---------------------------------------------------------------------------
// Bridge management
// ---------------------------------------------------------------------------

async function ensureBridgeRunning(name: string): Promise<number> {
	const meta = readMeta(name);
	if (meta && (await bridgeHealthy(meta.bridge_port))) return meta.bridge_port;

	const pending = bridgeStartPromises.get(name);
	if (pending) return pending;

	const p = (async () => {
		const m = readMeta(name);
		if (!m) throw new Error(`Kernel '${name}' not found in registry.`);
		const port = await findFreePort();
		const proc = spawnBridge(name, m.kernel_file, port, m.auth_token);
		await waitForHealth(port, BRIDGE_START_TIMEOUT_MS);
		const updated = readMeta(name);
		if (updated) {
			updated.bridge_port = port;
			updated.bridge_pid = proc.pid ?? null;
			writeMeta(name, updated);
		}
		return port;
	})().finally(() => bridgeStartPromises.delete(name));

	bridgeStartPromises.set(name, p);
	return p;
}

// ---------------------------------------------------------------------------
// HTTP helpers (per-kernel bridge, auth token, signal-aware)
// ---------------------------------------------------------------------------

interface HttpOpts {
	signal?: AbortSignal;
	timeoutS?: number;
}

function httpSignal(timeoutS: number | undefined, signal?: AbortSignal): AbortSignal {
	const ms = timeoutS !== undefined ? (timeoutS + TIMEOUT_MARGIN_S) * 1000 : CONTROL_TIMEOUT_MS;
	return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

async function kernelPost(
	name: string,
	endpoint: string,
	body: Record<string, unknown> = {},
	opts: HttpOpts = {},
): Promise<Record<string, unknown>> {
	const meta = readMeta(name);
	const port = await ensureBridgeRunning(name);
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (meta?.auth_token) headers["X-IPY-TOKEN"] = meta.auth_token;

	let res: Response;
	try {
		res = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: httpSignal(opts.timeoutS, opts.signal),
		});
	} catch (err) {
		throw new Error(`Cannot reach kernel bridge for '${name}'.\n${errMsg(err)}`);
	}

	const data = (await res.json()) as Record<string, unknown>;
	if (!res.ok) {
		const detail = typeof data.detail === "string" ? data.detail : `HTTP ${res.status}`;
		throw new Error(`Server error: ${detail}`);
	}
	return data;
}

async function kernelGet(
	name: string,
	endpoint: string,
	opts: HttpOpts = {},
): Promise<Record<string, unknown>> {
	const meta = readMeta(name);
	const port = await ensureBridgeRunning(name);
	const headers: Record<string, string> = {};
	if (meta?.auth_token) headers["X-IPY-TOKEN"] = meta.auth_token;

	let res: Response;
	try {
		res = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
			headers,
			signal: httpSignal(opts.timeoutS, opts.signal),
		});
	} catch (err) {
		throw new Error(`Cannot reach kernel bridge for '${name}'.\n${errMsg(err)}`);
	}

	const data = (await res.json()) as Record<string, unknown>;
	if (!res.ok) {
		const detail = typeof data.detail === "string" ? data.detail : `HTTP ${res.status}`;
		throw new Error(`Server error: ${detail}`);
	}
	return data;
}

function requireConnectedName(): string {
	if (!connectedName || !readMeta(connectedName)) {
		throw new Error("No kernel connected. Use kernel_start or kernel_connect first.");
	}
	return connectedName;
}

// ---------------------------------------------------------------------------
// Extension registration
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// -----------------------------------------------------------------------
	// 1. kernel_start
	// -----------------------------------------------------------------------
	const kernelStartTool = defineTool({
		name: "kernel_start",
		label: "Kernel Start",
		description:
			"Start a new named IPython kernel (persistent — survives pi exit; stop it with kernel_stop). " +
			"Optionally pick the Python interpreter via `python` ('' = default uv ipython tool, 'project' = project env, or a version spec / interpreter path). " +
			"List kernels with kernel_list.",
		promptSnippet: "Start a new IPython kernel",
		promptGuidelines: [
			"Use kernel_start to create a new IPython kernel if one is not already running.",
			"Kernels are persistent — stop them with kernel_stop when no longer needed.",
		],
		parameters: Type.Object({
			name: Type.Optional(
				Type.String({ description: "Kernel name (default: auto-generated kernel-<timestamp>)" }),
			),
			python: Type.Optional(
				Type.String({ description: "Python env: '' (default), 'project', a version spec (e.g. '3.11'), or an interpreter/venv path" }),
			),
			cwd: Type.Optional(
				Type.String({ description: "Working directory for kernel (default: cfg.json default_cwd)" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const cfg = loadConfig();
				const name = params.name ?? `kernel-${Date.now()}`;
				if (!/^[\w.-]+$/.test(name)) {
					throw new Error(`Invalid kernel name '${name}' — use letters, digits, '_', '-', or '.'`);
				}
				const workingDir = expandUser(params.cwd ?? cfg.default_cwd);
				const python = expandUser(params.python ?? cfg.python);

				// Name collision (decision 5): attach if live, replace if dead.
				const existing = readMeta(name);
				if (existing) {
					if (await kernelIsAlive(existing)) {
						connectedName = name;
						return {
							content: [
								{ type: "text", text: `ℹ️ Kernel '${name}' is already running (PID ${existing.kernel_pid}). Attached to it.` },
							],
							details: { name, kernel_pid: existing.kernel_pid },
						};
					}
					deleteKernelDir(name);
				}

				const dir = kernelDir(name);
				mkdirSync(dir, { recursive: true });
				const kernelFile = join(dir, "kernel.json");
				const kernelLog = join(dir, "kernel.log");

				// Spawn kernel (detached, file-logged)
				let spawnError: string | null = null;
				const kernelProc = spawnKernel(kernelFile, python, workingDir, kernelLog);
				kernelProc.catch((err) => {
					spawnError = errMsg(err);
				});
				const pid = kernelProc.pid as number;
				const startedAt = (await procStartTime(pid)) ?? "";

				// Wait for the connection file, then confirm the process didn't die
				await waitForKernelFile(kernelFile, KERNEL_FILE_TIMEOUT_MS);
				if (spawnError) {
					throw new Error(`Kernel process exited during startup: ${spawnError}. Check ${kernelLog}`);
				}

				// Spawn the kernel's companion bridge on a fresh free port
				const authToken = cfg.auth_token || randomBytes(16).toString("hex");
				const port = await findFreePort();
				const bridgeProc = spawnBridge(name, kernelFile, port, authToken);
				await waitForHealth(port, BRIDGE_START_TIMEOUT_MS);

				writeMeta(name, {
					name,
					kernel_pid: pid,
					bridge_pid: bridgeProc.pid ?? null,
					bridge_port: port,
					kernel_file: kernelFile,
					python,
					cwd: workingDir,
					started_at: startedAt,
					started_by: ctx.sessionManager.getSessionId(),
					external: false,
					auth_token: authToken,
				});

				connectedName = name;
				return {
					content: [
						{
							type: "text",
							text: `✅ Kernel '${name}' started (PID ${pid})\nPython: ${python || "default"}\nCwd: ${workingDir}\nBridge port: ${port}\n\nMonitor: tail -f ${kernelLog}`,
						},
					],
					details: { name, pid, bridge_port: port, kernel_file: kernelFile },
				};
			} catch (err) {
				throw new Error(`❌ ${errMsg(err)}`);
			}
		},
	});

	// -----------------------------------------------------------------------
	// 2. kernel_connect
	// -----------------------------------------------------------------------
	const kernelConnectTool = defineTool({
		name: "kernel_connect",
		label: "Kernel Connect",
		description:
			"Attach to a kernel by registry name, or connect to an external kernel via its kernel.json path (spawns an on-demand bridge). " +
			"With neither, uses cfg.json default_connect. Use this before running code.",
		promptSnippet: "Connect to an IPython kernel",
		promptGuidelines: [
			"Use kernel_connect to attach to a named kernel, or to bring an external kernel.json under bridge management.",
		],
		parameters: Type.Object({
			name: Type.Optional(
				Type.String({ description: "Registered kernel name to attach to" }),
			),
			path: Type.Optional(
				Type.String({ description: "Path to an external kernel.json (e.g., ~/kernels/my-kernel.json)" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const cfg = loadConfig();

				// 1) By name → attach to a registered kernel
				if (params.name) {
					const meta = readMeta(params.name);
					if (!meta) {
						throw new Error(`No kernel named '${params.name}' in the registry. Use kernel_list to see registered kernels.`);
					}
					await ensureBridgeRunning(params.name);
					connectedName = params.name;
					return {
						content: [{ type: "text", text: `✅ Connected to kernel '${params.name}' (${meta.kernel_file})` }],
						details: { name: params.name, kernel_file: meta.kernel_file },
					};
				}

				// 2) By path → external kernel (on-demand bridge, auto name)
				if (params.path) {
					const connectionFile = expandUser(params.path.replace(/^@/, ""));
					if (!existsSync(connectionFile)) {
						throw new Error(`Kernel connection file not found: ${connectionFile}`);
					}
					const name = `ext-${slugify(basename(connectionFile))}-${Date.now()}`;
					mkdirSync(kernelDir(name), { recursive: true });
					const authToken = cfg.auth_token || randomBytes(16).toString("hex");
					const port = await findFreePort();
					const bridgeProc = spawnBridge(name, connectionFile, port, authToken);
					await waitForHealth(port, BRIDGE_START_TIMEOUT_MS);
					writeMeta(name, {
						name,
						kernel_pid: 0,
						bridge_pid: bridgeProc.pid ?? null,
						bridge_port: port,
						kernel_file: connectionFile,
						python: "",
						cwd: "",
						started_at: "",
						started_by: ctx.sessionManager.getSessionId(),
						external: true,
						auth_token: authToken,
					});
					connectedName = name;
					return {
						content: [{ type: "text", text: `✅ Connected to external kernel via bridge '${name}' (${connectionFile})` }],
						details: { name, kernel_file: connectionFile, external: true },
					};
				}

				// 3) Neither → default_connect (name first, then path)
				const dflt = cfg.default_connect;
				if (!dflt) {
					throw new Error("No kernel name or path provided and no default_connect configured in cfg.json.");
				}
				if (readMeta(dflt)) {
					await ensureBridgeRunning(dflt);
					connectedName = dflt;
					return {
						content: [{ type: "text", text: `✅ Connected to kernel '${dflt}' (default_connect)` }],
						details: { name: dflt },
					};
				}
				const connectionFile = expandUser(dflt);
				if (!existsSync(connectionFile)) {
					throw new Error(`default_connect '${dflt}' is neither a registered kernel name nor an existing kernel.json path.`);
				}
				const name = `ext-${slugify(basename(connectionFile))}-${Date.now()}`;
				mkdirSync(kernelDir(name), { recursive: true });
				const authToken = cfg.auth_token || randomBytes(16).toString("hex");
				const port = await findFreePort();
				const bridgeProc = spawnBridge(name, connectionFile, port, authToken);
				await waitForHealth(port, BRIDGE_START_TIMEOUT_MS);
				writeMeta(name, {
					name,
					kernel_pid: 0,
					bridge_pid: bridgeProc.pid ?? null,
					bridge_port: port,
					kernel_file: connectionFile,
					python: "",
					cwd: "",
					started_at: "",
					started_by: ctx.sessionManager.getSessionId(),
					external: true,
					auth_token: authToken,
				});
				connectedName = name;
				return {
					content: [{ type: "text", text: `✅ Connected to external kernel via bridge '${name}' (default_connect path)` }],
					details: { name, kernel_file: connectionFile, external: true },
				};
			} catch (err) {
				throw new Error(`❌ ${errMsg(err)}`);
			}
		},
	});

	// -----------------------------------------------------------------------
	// 3. kernel_run_python
	// -----------------------------------------------------------------------
	const kernelRunPythonTool = defineTool({
		name: "kernel_run_python",
		label: "Kernel Run Python",
		description:
			"Execute Python code in the connected kernel and return captured output. " +
			"Output is truncated to ~20000 chars by default; use kernel_get_output to retrieve full output.",
		promptSnippet: "Execute Python code in the kernel",
		promptGuidelines: [
			"Use kernel_run_python to execute Python code when you need the kernel state (variables, imports) to persist across calls.",
			"Output is truncated — use kernel_get_output to retrieve the full output if needed.",
		],
		executionMode: "sequential",
		parameters: Type.Object({
			code: Type.String({ description: "Python code to execute" }),
			timeout_s: Type.Optional(
				Type.Number({ description: "Timeout in seconds (default: 60)" }),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			try {
				const name = requireConnectedName();
				onUpdate?.({ content: [{ type: "text", text: "⏳ Executing in kernel…" }], details: undefined });
				const data = await kernelPost(name, "/kernel/run-code", {
					code: params.code,
					timeout_s: params.timeout_s,
				}, { signal, timeoutS: params.timeout_s });
				let text = data.output as string;
				if (data.truncated) {
					text += "\n\n⚠️ Output was truncated. Use kernel_get_output to retrieve the full output.";
				}
				return {
					content: [{ type: "text", text }],
					details: data,
				};
			} catch (err) {
				throw new Error(`❌ ${errMsg(err)}`);
			}
		},
	});

	// -----------------------------------------------------------------------
	// 4. kernel_eval_expr
	// -----------------------------------------------------------------------
	const kernelEvalExprTool = defineTool({
		name: "kernel_eval_expr",
		label: "Kernel Eval Expression",
		description:
			"Evaluate a Python expression in the connected kernel and return its text/plain result. " +
			"Use this for quick checks without polluting kernel history.",
		promptSnippet: "Evaluate a Python expression",
		promptGuidelines: [
			"Use kernel_eval_expr for lightweight expression evaluation (checking variable values, types, quick math) instead of kernel_run_python.",
		],
		executionMode: "sequential",
		parameters: Type.Object({
			expr: Type.String({ description: "Python expression to evaluate (e.g., 'len(data)', '2 + 2')" }),
			timeout_s: Type.Optional(
				Type.Number({ description: "Timeout in seconds (default: 60)" }),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			try {
				const name = requireConnectedName();
				const data = await kernelPost(name, "/kernel/eval-expr", {
					expr: params.expr,
					timeout_s: params.timeout_s,
				}, { signal, timeoutS: params.timeout_s });
				return {
					content: [{ type: "text", text: data.result as string }],
					details: data,
				};
			} catch (err) {
				throw new Error(`❌ ${errMsg(err)}`);
			}
		},
	});

	// -----------------------------------------------------------------------
	// 5. kernel_interrupt
	// -----------------------------------------------------------------------
	const kernelInterruptTool = defineTool({
		name: "kernel_interrupt",
		label: "Kernel Interrupt",
		description:
			"Interrupt the currently running kernel (sends SIGINT via the control channel). " +
			"Use this when a previous kernel_run_python call is stuck or taking too long.",
		promptSnippet: "Interrupt the kernel",
		promptGuidelines: [
			"Use kernel_interrupt if a kernel_run_python call appears to be stuck or is taking too long.",
		],
		executionMode: "sequential",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, signal, _onUpdate, _ctx) {
			try {
				const name = requireConnectedName();
				await kernelPost(name, "/kernel/interrupt", {}, { signal });
				return {
					content: [{ type: "text", text: "🛑 Kernel interrupted" }],
					details: {},
				};
			} catch (err) {
				throw new Error(`❌ ${errMsg(err)}`);
			}
		},
	});

	// -----------------------------------------------------------------------
	// 6. kernel_get_output
	// -----------------------------------------------------------------------
	const kernelGetOutputTool = defineTool({
		name: "kernel_get_output",
		label: "Kernel Get Output",
		description:
			"Retrieve a slice of the last captured full output from kernel_run_python. " +
			"Use this when the output was truncated. Default returns the first 4000 characters.",
		promptSnippet: "Retrieve cached kernel output",
		promptGuidelines: [
			"Use kernel_get_output when kernel_run_python output was truncated — retrieve the full output in slices.",
		],
		executionMode: "sequential",
		parameters: Type.Object({
			start: Type.Optional(
				Type.Number({ description: "Character offset to start from (default: 0)" }),
			),
			limit: Type.Optional(
				Type.Number({ description: "Maximum characters to return (default: 4000)" }),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			try {
				const name = requireConnectedName();
				const data = await kernelPost(name, "/kernel/get-output", {
					start: params.start ?? 0,
					limit: params.limit ?? 4000,
				}, { signal });
				const { output, start, end, total } = data as {
					output: string;
					start: number;
					end: number;
					total: number;
				};
				const header = `[${start}:${end} of ${total}]`;
				return {
					content: [{ type: "text", text: `${header}\n${output}` }],
					details: data,
				};
			} catch (err) {
				throw new Error(`❌ ${errMsg(err)}`);
			}
		},
	});

	// -----------------------------------------------------------------------
	// 7. kernel_list
	// -----------------------------------------------------------------------
	const kernelListTool = defineTool({
		name: "kernel_list",
		label: "Kernel List",
		description:
			"List all kernels in the registry (~/.ipy/kernels/). Dead kernels are pruned (their bridge reaped). " +
			"Kernels are persistent — stop them with kernel_stop.",
		promptSnippet: "List registered kernels",
		promptGuidelines: [
			"Use kernel_list to see which kernels exist, then kernel_connect by name or kernel_stop to clean up.",
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			try {
				const rows: {
					name: string;
					python: string;
					cwd: string;
					kernel_pid: number;
					bridge_port: number;
					started_at: string;
					started_by: string;
					external: boolean;
					connected: boolean;
				}[] = [];
				let pruned = 0;

				for (const name of listKernelNames()) {
					const meta = readMeta(name);
					if (!meta) continue;
					const alive = meta.external
						? await bridgeHealthy(meta.bridge_port)
						: await kernelIsAlive(meta);
					if (alive) {
						rows.push({
							name,
							python: meta.python || "(default)",
							cwd: meta.cwd || "—",
							kernel_pid: meta.kernel_pid,
							bridge_port: meta.bridge_port,
							started_at: meta.started_at || "—",
							started_by: meta.started_by || "—",
							external: meta.external,
							connected: name === connectedName,
						});
					} else {
						// Reap the orphaned bridge, then prune the dead entry
						if (meta.bridge_pid && pidAlive(meta.bridge_pid)) {
							try { process.kill(meta.bridge_pid, "SIGKILL"); } catch { /* gone */ }
						}
						deleteKernelDir(name);
						if (connectedName === name) connectedName = null;
						pruned++;
					}
				}

				rows.sort((a, b) => a.name.localeCompare(b.name));
				const lines: string[] = [];
				lines.push(`📦 Kernels (${rows.length} live${pruned ? `, ${pruned} pruned` : ""})`);
				if (rows.length === 0) {
					lines.push("(none — use kernel_start to create one)");
				} else {
					lines.push("");
					lines.push("  NAME            PYTHON     PID       PORT   STARTED AT            EXTERNAL  CWD");
					for (const r of rows) {
						const marker = r.connected ? "→" : " ";
						lines.push(
							`${marker} ${r.name.padEnd(16)} ${r.python.padEnd(10)} ${String(r.kernel_pid).padEnd(8)} ${String(r.bridge_port).padEnd(6)} ${r.started_at.padEnd(21)} ${r.external ? "yes" : "no"}       ${r.cwd}`,
						);
					}
				}
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { rows, pruned },
				};
			} catch (err) {
				throw new Error(`❌ ${errMsg(err)}`);
			}
		},
	});

	// -----------------------------------------------------------------------
	// 8. kernel_stop
	// -----------------------------------------------------------------------
	const kernelStopTool = defineTool({
		name: "kernel_stop",
		label: "Kernel Stop",
		description:
			"Stop a kernel (and its bridge) by name, by connection-file path, or the currently connected kernel. " +
			"External kernels: removes only our bridge unless kill_external is true.",
		promptSnippet: "Stop a kernel",
		promptGuidelines: [
			"Use kernel_stop to stop a kernel by name (see kernel_list), or with no args to stop the connected kernel.",
		],
		executionMode: "sequential",
		parameters: Type.Object({
			name: Type.Optional(
				Type.String({ description: "Registered kernel name to stop" }),
			),
			path: Type.Optional(
				Type.String({ description: "Connection-file path of the kernel to stop" }),
			),
			kill_external: Type.Optional(
				Type.Boolean({ description: "Also signal the external kernel's process (default: false)" }),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			try {
				let name: string | null = null;
				if (params.name) {
					if (!readMeta(params.name)) {
						throw new Error(`No kernel named '${params.name}' in the registry.`);
					}
					name = params.name;
				} else if (params.path) {
					const f = expandUser(params.path.replace(/^@/, ""));
					name = findKernelByFile(f);
					if (!name) {
						throw new Error(`No registered kernel for connection file: ${f}`);
					}
				} else {
					name = connectedName;
					if (!name) {
						throw new Error("No kernel connected. Pass name or path, or connect first.");
					}
				}

				const meta = readMeta(name);
				if (!meta) {
					throw new Error(`Kernel '${name}' disappeared from the registry.`);
				}

				// External kernel: we never started it — remove our bridge only.
				if (meta.external) {
					if (params.kill_external && meta.kernel_pid && pidAlive(meta.kernel_pid)) {
						try { process.kill(meta.kernel_pid, "SIGKILL"); } catch { /* gone */ }
					}
					await stopBridge(meta);
					deleteKernelDir(name);
					if (connectedName === name) connectedName = null;
					return {
						content: [{ type: "text", text: `✅ Removed bridge for external kernel '${name}'${params.kill_external ? " (kernel signaled)" : " (kernel left running)"}` }],
						details: { name, external: true },
					};
				}

				// Graceful shutdown via the kernel's own bridge
				let method = "process kill";
				try {
					await kernelPost(name, "/kernel/shutdown", {}, { signal });
					method = "graceful shutdown";
					await sleep(500);
				} catch {
					// bridge unreachable — fall through to process kill
				}

				// Stop the bridge (graceful /shutdown first, then hard kill)
				await stopBridge(meta);

				// Kill the kernel only if still alive and identity-verified
				if (await kernelIsAlive(meta)) {
					try { process.kill(meta.kernel_pid, "SIGKILL"); } catch { /* gone */ }
				}

				deleteKernelDir(name);
				if (connectedName === name) connectedName = null;
				return {
					content: [{ type: "text", text: `✅ Kernel '${name}' stopped (PID ${meta.kernel_pid}, ${method})` }],
					details: { name, pid: meta.kernel_pid, method },
				};
			} catch (err) {
				throw new Error(`❌ ${errMsg(err)}`);
			}
		},
	});

	// -----------------------------------------------------------------------
	// 9. kernel_status
	// -----------------------------------------------------------------------
	const kernelStatusTool = defineTool({
		name: "kernel_status",
		label: "Kernel Status",
		description:
			"Show the connected kernel (name, bridge health, PID, Python, cwd) and a registry summary. " +
			"Use kernel_list for the full registry.",
		promptSnippet: "Show kernel status",
		promptGuidelines: [
			"Use kernel_status to check which kernel this session is connected to and whether its bridge is up.",
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			try {
				const lines: string[] = [];
				const meta = connectedName ? readMeta(connectedName) : null;
				if (meta) {
					const bridgeUp = await bridgeHealthy(meta.bridge_port);
					lines.push(`🔗 Connected kernel: ${meta.name}`);
					lines.push(`   Bridge: ${bridgeUp ? "✅ up" : "❌ down"} (port ${meta.bridge_port})`);
					lines.push(`   Kernel PID: ${meta.kernel_pid}${meta.external ? " (external)" : ""}`);
					lines.push(`   Python: ${meta.python || "(default)"}`);
					lines.push(`   Cwd: ${meta.cwd || "—"}`);
					lines.push(`   Started: ${meta.started_at || "—"}`);
					lines.push(`   Started by: ${meta.started_by || "—"}`);
				} else {
					lines.push("🔗 No kernel connected. Use kernel_start or kernel_connect first.");
				}
				const names = listKernelNames();
				lines.push(`📦 Registry: ${names.length} kernel(s) in ${KERNELS_DIR}`);
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { connected: meta?.name ?? null, registryCount: names.length },
				};
			} catch (err) {
				throw new Error(`❌ ${errMsg(err)}`);
			}
		},
	});

	// -----------------------------------------------------------------------
	// 10. kernel_console_cmd
	// -----------------------------------------------------------------------
	const kernelConsoleCmdTool = defineTool({
		name: "kernel_console_cmd",
		label: "Kernel Console Command",
		description:
			"Show a copy-paste command to attach a Jupyter console to a kernel, using the kernel's own " +
			"Python environment. Writes console.sh next to the kernel; paste `bash ~/.ipy/kernels/<name>/console.sh` " +
			"(short line, never wrapped). Use kernel_connect first, or pass a name.",
		promptSnippet: "Show the jupyter console command for a kernel",
		promptGuidelines: [
			"Use kernel_console_cmd to get a copy-paste command that opens a Jupyter console attached to a running kernel.",
		],
		parameters: Type.Object({
			name: Type.Optional(
				Type.String({ description: "Registered kernel name (default: connected kernel)" }),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			try {
				const name = params.name ?? requireConnectedName();
				const meta = readMeta(name);
				if (!meta) throw new Error(`Kernel '${name}' not found in registry.`);
				const data = await kernelGet(name, "/kernel/python", { signal });
				const executable = data.executable as string;
				const jupyterBin = data.jupyter_bin as string | null;
				const hasConsole = data.has_jupyter_console as boolean;
				const kernelFile = meta.kernel_file;

				if (!jupyterBin && !hasConsole) {
					throw new Error(
						`Kernel '${name}' env (${executable}) has no jupyter-console. ` +
						`Install it (uv pip install --python ${executable} jupyter-console) or start the kernel with an env that has it.`,
					);
				}
				const cmd = jupyterBin
					? `"${jupyterBin}" console --existing "${kernelFile}"`
					: `"${executable}" -m jupyter console --existing "${kernelFile}"`;

				// Persist the command as a script so the copy-paste line stays short —
				// long one-liners get wrapped by the TUI/terminal when copied.
				const scriptPath = join(kernelDir(name), "console.sh");
				writeFileSync(scriptPath, `#!/bin/sh\nexec ${cmd}\n`, "utf-8");
				try { chmodSync(scriptPath, 0o755); } catch { /* best effort */ }

				return {
					content: [
						{ type: "text", text: `bash ${scriptPath}\n\nfull command: ${cmd}` },
					],
					details: { command: cmd, script: scriptPath, kernel: name, executable, jupyter_bin: jupyterBin, kernel_file: kernelFile },
				};
			} catch (err) {
				throw new Error(`❌ ${errMsg(err)}`);
			}
		},
	});

	pi.registerTool(kernelStartTool);
	pi.registerTool(kernelConnectTool);
	pi.registerTool(kernelRunPythonTool);
	pi.registerTool(kernelEvalExprTool);
	pi.registerTool(kernelInterruptTool);
	pi.registerTool(kernelGetOutputTool);
	pi.registerTool(kernelListTool);
	pi.registerTool(kernelStopTool);
	pi.registerTool(kernelStatusTool);
	pi.registerTool(kernelConsoleCmdTool);
}

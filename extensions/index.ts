/**
 * @johnjanecek/ipyforge-kernel — Pi extension
 *
 * Installed via: pi install /path/to/ipython_package
 *
 * Registers 7 custom tools that communicate with a local FastAPI server
 * (ipyforge-kernel-server) wrapping jupyter_client.BlockingKernelClient.
 *
 * Server is started internally on first tool call.
 * Tools use execa to spawn kernel and server processes.
 *
 * Tools:
 *   kernel_start        — start a new IPython kernel
 *   kernel_connect      — connect to a kernel via its kernel.json file
 *   kernel_run_python   — execute Python code in the kernel
 *   kernel_eval_expr    — evaluate a Python expression
 *   kernel_interrupt    — interrupt the running kernel
 *   kernel_get_output   — retrieve cached output from the last run
 *   kernel_stop         — stop a Pi-created kernel
 *   kernel_status       — show connection and server state
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execa } from "execa";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";

const SERVER = "http://127.0.0.1:9123";
const CONFIG_FILENAME = "cfg.json";
const REQUEST_TIMEOUT_MS = 10_000;
const SERVER_START_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function expandUser(path: string): string {
	if (path.startsWith("~/")) {
		return resolve(homedir(), path.slice(2));
	}
	return path;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface Config {
	port: number;
	kernel_connection_file: string;
	max_output_chars: number;
	default_timeout_s: number;
	default_cwd: string;
	kernel_auto_created: boolean;
	kernel_pid: number | null;
	kernel_log_file: string;
	server_log_file: string;
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
	return getDefaultConfig(raw);
}

function getDefaultConfig(overrides: Partial<Config> = {}): Config {
	return {
		port: 9123,
		kernel_connection_file: "",
		max_output_chars: 20000,
		default_timeout_s: 30,
		default_cwd: homedir(),
		kernel_auto_created: false,
		kernel_pid: null,
		kernel_log_file: `${homedir()}/.ipy/kernel.log`,
		server_log_file: `${homedir()}/.ipy/server.log`,
		...overrides,
	};
}

function saveConfig(cfg: Config): void {
	const cfgPath = resolve(getExtensionDir(), CONFIG_FILENAME);
	writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Server helpers
// ---------------------------------------------------------------------------

let serverStarted = false;

async function ensureServerRunning(): Promise<void> {
	if (serverStarted) {
		// Verify it's still reachable — if not, reset and restart
		try {
			await fetch(`${SERVER}/health`, { signal: AbortSignal.timeout(2000) });
			return;
		} catch {
			serverStarted = false;
		}
	}

	const cfg = loadConfig();

	// Ensure log directory exists
	const logDir = resolve(cfg.server_log_file, "..");
	if (!existsSync(logDir)) {
		mkdirSync(logDir, { recursive: true });
	}

	// Start server using execa
	execa("uv", ["run", "python", "server/main.py"], {
		cwd: getExtensionDir(),
		stdout: { file: cfg.server_log_file },
		stderr: { file: cfg.server_log_file },
	});

	// Poll health endpoint until ready or timeout
	const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
	while (Date.now() < deadline) {
		try {
			await fetch(`${SERVER}/health`, { signal: AbortSignal.timeout(1000) });
			serverStarted = true;
			return;
		} catch {
			await new Promise<void>((r) => setTimeout(r, 300));
		}
	}
	throw `Server failed to start within ${SERVER_START_TIMEOUT_MS}ms. Check ${cfg.server_log_file}`;
}

// ---------------------------------------------------------------------------
// Kernel helpers
// ---------------------------------------------------------------------------

async function waitForKernelFile(path: string, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(path)) return;
		await new Promise<void>((r) => setTimeout(r, 200));
	}
	throw new Error(`Kernel connection file not created within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Server communication
// ---------------------------------------------------------------------------

async function serverPost(endpoint: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
	await ensureServerRunning();

	const url = `${SERVER}${endpoint}`;
	let res: Response;

	try {
		res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw `Cannot reach kernel server at ${SERVER}.\n${msg}`;
	}

	const data = (await res.json()) as Record<string, unknown>;

	if (!res.ok) {
		const detail = typeof data.detail === "string" ? data.detail : `HTTP ${res.status}`;
		throw `Server error: ${detail}`;
	}

	return data;
}

async function serverGet(endpoint: string): Promise<Record<string, unknown>> {
	await ensureServerRunning();

	const url = `${SERVER}${endpoint}`;
	let res: Response;

	try {
		res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw `Cannot reach kernel server at ${SERVER}.\n${msg}`;
	}

	const data = (await res.json()) as Record<string, unknown>;

	if (!res.ok) {
		const detail = typeof data.detail === "string" ? data.detail : `HTTP ${res.status}`;
		throw `Server error: ${detail}`;
	}

	return data;
}

async function fetchWithTimeout(url: string, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<Response> {
	return fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
}

// ---------------------------------------------------------------------------
// Extension registration
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// -----------------------------------------------------------------------
	// 1. kernel_start
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "kernel_start",
		label: "Kernel Start",
		description:
			"Start a new IPython kernel. " +
			"Logs are written to the kernel_log_file in cfg.json. " +
			"User can monitor logs with: tail -f ~/.ipy/kernel.log",
		promptSnippet: "Start a new IPython kernel",
		promptGuidelines: [
			"Use kernel_start to create a new IPython kernel if one is not already running.",
			"Monitor kernel output with: tail -f ~/.ipy/kernel.log",
		],
		parameters: Type.Object({
			cwd: Type.Optional(
				Type.String({ description: "Working directory for kernel (default: from cfg.json)" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const cfg = loadConfig();
				const workingDir = params.cwd ?? cfg.default_cwd;

				// Ensure kernels directory exists
				const kernelsDir = expandUser("~/kernels");
				if (!existsSync(kernelsDir)) {
					mkdirSync(kernelsDir, { recursive: true });
				}

				// Ensure log directory exists
				const logDir = resolve(cfg.kernel_log_file, "..");
				if (!existsSync(logDir)) {
					mkdirSync(logDir, { recursive: true });
				}

				// Kernel connection file path
				const kernelFile = expandUser("~/kernels/ipyforge-kernel.json");

				// Spawn kernel
				let spawnError: string | null = null;
				const proc = execa(
					"uv",
					["tool", "run", "--from", "ipython", "python", "-m", "ipykernel", "-f", kernelFile],
					{
						cwd: workingDir,
						stdout: { file: cfg.kernel_log_file },
						stderr: { file: cfg.kernel_log_file },
					},
				);
				proc.catch((err) => {
					spawnError = err instanceof Error ? err.message : String(err);
				});

				const pid = proc.pid as number;

				// Wait for kernel file to be created
				await waitForKernelFile(kernelFile);

				// Verify process is still alive (didn't crash on startup)
				if (spawnError) {
					throw `Kernel process exited during startup: ${spawnError}. Check ${cfg.kernel_log_file}`;
				}

				// Update config
				const updatedCfg: Config = {
					...cfg,
					kernel_connection_file: kernelFile,
					kernel_auto_created: true,
					kernel_pid: pid,
				};
				saveConfig(updatedCfg);

				return {
					content: [
						{
							type: "text",
							text: `✅ Kernel started with PID ${pid}\nConnection file: ${kernelFile}\nLogs: ${cfg.kernel_log_file}\n\nMonitor output with: tail -f ${cfg.kernel_log_file}`,
						},
					],
					details: { pid, kernel_file: kernelFile },
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `❌ ${err}` }],
					details: {},
					isError: true,
				};
			}
		},
	});

	// -----------------------------------------------------------------------
	// 2. kernel_connect
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "kernel_connect",
		label: "Kernel Connect",
		description:
			"Connect to an existing IPython kernel via its connection file (kernel.json). " +
			"If path is omitted, uses kernel_connection_file from cfg.json. " +
			"Use this before running code or evaluating expressions.",
		promptSnippet: "Connect to an IPython kernel",
		promptGuidelines: [
			"Use kernel_connect first to establish a connection to a running IPython kernel before using kernel_run_python or kernel_eval_expr.",
		],
		parameters: Type.Object({
			path: Type.Optional(
				Type.String({ description: "Path to kernel.json (e.g., ~/kernels/my-kernel.json)" }),
			),
			set_default: Type.Optional(
				Type.Boolean({ description: "Use this connection file for subsequent calls (default: true)" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const cfg = loadConfig();
				const connectionFile = params.path ?? cfg.kernel_connection_file;

				if (!connectionFile) {
					return {
						content: [{ type: "text", text: "❌ No kernel connection file specified. Provide path argument or configure kernel_connection_file in cfg.json." }],
						details: {},
						isError: true,
					};
				}

				const data = await serverPost("/kernel/connect", {
					connection_file: connectionFile,
					set_default: params.set_default ?? true,
				});

				// Update config if path was provided
				if (params.path && params.set_default !== false) {
					const updatedCfg: Config = { ...cfg, kernel_connection_file: connectionFile };
					saveConfig(updatedCfg);
				}

				return {
					content: [{ type: "text", text: `✅ Connected to kernel: ${data.connected_file}` }],
					details: data,
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `❌ ${err}` }],
					details: {},
					isError: true,
				};
			}
		},
	});

	// -----------------------------------------------------------------------
	// 3. kernel_run_python
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "kernel_run_python",
		label: "Kernel Run Python",
		description:
			"Execute Python code in the connected kernel and return captured output. " +
			"Output is truncated to ~20000 chars by default; use kernel_get_output to retrieve full output. " +
			"The kernel must already be connected (via kernel_connect).",
		promptSnippet: "Execute Python code in the kernel",
		promptGuidelines: [
			"Use kernel_run_python to execute Python code when you need the kernel state (variables, imports) to persist across calls.",
			"Output is truncated — use kernel_get_output to retrieve the full output if needed.",
		],
		parameters: Type.Object({
			code: Type.String({ description: "Python code to execute" }),
			timeout_s: Type.Optional(
				Type.Number({ description: "Timeout in seconds (default: 30)" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const data = await serverPost("/kernel/run-code", {
					code: params.code,
					timeout_s: params.timeout_s,
				});
				const truncated = data.truncated;
				let text = data.output as string;
				if (truncated) {
					text += "\n\n⚠️ Output was truncated. Use kernel_get_output to retrieve the full output.";
				}
				return {
					content: [{ type: "text", text }],
					details: data,
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `❌ ${err}` }],
					details: {},
					isError: true,
				};
			}
		},
	});

	// -----------------------------------------------------------------------
	// 4. kernel_eval_expr
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "kernel_eval_expr",
		label: "Kernel Eval Expression",
		description:
			"Evaluate a Python expression in the kernel and return its text/plain result. " +
			"Use this for quick checks (variables, types, simple computations) without polluting kernel history. " +
			"The kernel must already be connected (via kernel_connect).",
		promptSnippet: "Evaluate a Python expression",
		promptGuidelines: [
			"Use kernel_eval_expr for lightweight expression evaluation (checking variable values, types, quick math) instead of kernel_run_python.",
		],
		parameters: Type.Object({
			expr: Type.String({ description: "Python expression to evaluate (e.g., 'len(data)', '2 + 2')" }),
			timeout_s: Type.Optional(
				Type.Number({ description: "Timeout in seconds (default: 30)" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const data = await serverPost("/kernel/eval-expr", {
					expr: params.expr,
					timeout_s: params.timeout_s,
				});
				return {
					content: [{ type: "text", text: data.result as string }],
					details: data,
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `❌ ${err}` }],
					details: {},
					isError: true,
				};
			}
		},
	});

	// -----------------------------------------------------------------------
	// 5. kernel_interrupt
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "kernel_interrupt",
		label: "Kernel Interrupt",
		description:
			"Interrupt the currently running kernel (sends SIGINT). " +
			"Use this when a previous kernel_run_python call is stuck or taking too long.",
		promptSnippet: "Interrupt the kernel",
		promptGuidelines: [
			"Use kernel_interrupt if a kernel_run_python call appears to be stuck or is taking too long.",
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			try {
				await serverPost("/kernel/interrupt");
				return {
					content: [{ type: "text", text: "🛑 Kernel interrupted" }],
					details: {},
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `❌ ${err}` }],
					details: {},
					isError: true,
				};
			}
		},
	});

	// -----------------------------------------------------------------------
	// 6. kernel_get_output
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "kernel_get_output",
		label: "Kernel Get Output",
		description:
			"Retrieve a slice of the last captured full output from kernel_run_python. " +
			"Use this when the output was truncated. Default returns the first 4000 characters.",
		promptSnippet: "Retrieve cached kernel output",
		promptGuidelines: [
			"Use kernel_get_output when kernel_run_python output was truncated — retrieve the full output in slices.",
		],
		parameters: Type.Object({
			start: Type.Optional(
				Type.Number({ description: "Character offset to start from (default: 0)" }),
			),
			limit: Type.Optional(
				Type.Number({ description: "Maximum characters to return (default: 4000)" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const data = await serverPost("/kernel/get-output", {
					start: params.start ?? 0,
					limit: params.limit ?? 4000,
				});
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
				return {
					content: [{ type: "text", text: `❌ ${err}` }],
					details: {},
					isError: true,
				};
			}
		},
	});

	// -----------------------------------------------------------------------
	// 7. kernel_stop
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "kernel_stop",
		label: "Kernel Stop",
		description:
			"Stop a kernel that was created by Pi. " +
			"No-op if the kernel was not auto-created (e.g., user started it manually).",
		promptSnippet: "Stop the kernel",
		promptGuidelines: [
			"Use kernel_stop only to stop a kernel that was started by kernel_start.",
			"Does nothing if the kernel was not created by Pi.",
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			try {
				const cfg = loadConfig();

				if (!cfg.kernel_auto_created) {
					return {
						content: [{ type: "text", text: "ℹ️ Kernel was not created by Pi. Use kernel_stop only for Pi-created kernels." }],
						details: {},
					};
				}

				if (!cfg.kernel_pid) {
					return {
						content: [{ type: "text", text: "⚠️ kernel_auto_created is true but kernel_pid is null." }],
						details: {},
						isError: true,
					};
				}

				// Kill the process
				try {
					process.kill(cfg.kernel_pid);
				} catch {
					// Process may already be dead
				}

				// Update config
				const updatedCfg: Config = {
					...cfg,
					kernel_auto_created: false,
					kernel_pid: null,
				};
				saveConfig(updatedCfg);

				return {
					content: [{ type: "text", text: `✅ Kernel stopped (PID ${cfg.kernel_pid})` }],
					details: { pid: cfg.kernel_pid },
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `❌ ${err}` }],
					details: {},
					isError: true,
				};
			}
		},
	});

	// -----------------------------------------------------------------------
	// 8. kernel_status
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "kernel_status",
		label: "Kernel Status",
		description:
			"Show the current kernel connection status, port, and configured connection file. " +
			"Use this to check whether the server and kernel are reachable.",
		promptSnippet: "Show kernel and server status",
		promptGuidelines: [
			"Use kernel_status to check whether the kernel server is running and which connection file is in use.",
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			try {
				const cfg = loadConfig();

				let serverRunning = false;
				try {
					await fetchWithTimeout(`${SERVER}/health`, 3000);
					serverRunning = true;
				} catch {
					serverRunning = false;
				}

				let kernelConnected = false;
				if (cfg.kernel_connection_file) {
					try {
						const data = await serverGet("/kernel/status") as { connected: boolean };
						kernelConnected = data.connected;
					} catch {
						kernelConnected = false;
					}
				}

				const lines: string[] = [];
				lines.push(`🔌 Server: ${serverRunning ? "✅ running" : "❌ not running"}`);
				lines.push(`🔗 Kernel: ${kernelConnected ? "✅ connected" : "❌ not connected"}`);
				lines.push(`📁 Connection file: ${cfg.kernel_connection_file || "(not set)"}`);
				lines.push(`🤖 Auto-created: ${cfg.kernel_auto_created ? "yes" : "no"}`);
				if (cfg.kernel_pid) {
					lines.push(` PID: ${cfg.kernel_pid}`);
				}
				lines.push(`📝 Log files:`);
				lines.push(`   Kernel: ${cfg.kernel_log_file}`);
				lines.push(`   Server: ${cfg.server_log_file}`);

				if (!kernelConnected && cfg.kernel_connection_file) {
					lines.push("");
					lines.push("⚠️  Not connected. Make sure the kernel is running.");
				}

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { serverRunning, kernelConnected, ...cfg },
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `❌ ${err}` }],
					details: {},
					isError: true,
				};
			}
		},
	});
}
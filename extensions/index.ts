/**
 * @johnjanecek/ipyforge-kernel — Pi extension
 *
 * Installed via: pi install /path/to/ipython_package
 *
 * Registers 6 custom tools that communicate with a local FastAPI server
 * (ipyforge-kernel-server) wrapping jupyter_client.BlockingKernelClient.
 *
 * Server must be running manually on 127.0.0.1:9123.
 * Start it with:  uv run python server/main.py
 *
 * Tools:
 *   kernel_connect     — connect to a kernel via its kernel.json file
 *   kernel_run_python  — execute Python code in the kernel
 *   kernel_eval_expr   — evaluate a Python expression
 *   kernel_interrupt   — interrupt the running kernel
 *   kernel_get_output  — retrieve cached output from the last run
 *   kernel_status      — show connection and server state
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const SERVER = "http://127.0.0.1:9123";

/**
 * Call the server endpoint and parse the response.
 * Returns the JSON body on success, or throws a descriptive string on failure.
 */
async function serverPost(endpoint: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
	const url = `${SERVER}${endpoint}`;
	let res: Response;

	try {
		res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw `Cannot reach kernel server at ${SERVER}.\n${msg}\n\nMake sure ipyforge-kernel-server is running:\n  uv run python server/main.py`;
	}

	const data = (await res.json()) as Record<string, unknown>;

	if (!res.ok) {
		const detail = typeof data.detail === "string" ? data.detail : `HTTP ${res.status}`;
		throw `Server error: ${detail}`;
	}

	return data;
}

/**
 * Call a GET endpoint on the server.
 */
async function serverGet(endpoint: string): Promise<Record<string, unknown>> {
	const url = `${SERVER}${endpoint}`;
	let res: Response;

	try {
		res = await fetch(url);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw `Cannot reach kernel server at ${SERVER}.\n${msg}\n\nMake sure ipyforge-kernel-server is running:\n  uv run python server/main.py`;
	}

	const data = (await res.json()) as Record<string, unknown>;

	if (!res.ok) {
		const detail = typeof data.detail === "string" ? data.detail : `HTTP ${res.status}`;
		throw `Server error: ${detail}`;
	}

	return data;
}

export default function (pi: ExtensionAPI) {
	// -----------------------------------------------------------------------
	// 1. kernel_connect
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "kernel_connect",
		label: "Kernel Connect",
		description:
			"Connect to an existing IPython kernel via its connection file (kernel.json). " +
			"If connection_file is omitted, uses the server's configured default. " +
			"Use this before running code or evaluating expressions.",
		promptSnippet: "Connect to an IPython kernel",
		promptGuidelines: [
			"Use kernel_connect first to establish a connection to a running IPython kernel before using kernel_run_python or kernel_eval_expr.",
		],
		parameters: Type.Object({
			connection_file: Type.Optional(
				Type.String({ description: "Path to kernel.json (e.g., /tmp/remote-kernel.json)" }),
			),
			set_default: Type.Optional(
				Type.Boolean({ description: "Use this connection file for subsequent calls (default: true)" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const data = await serverPost("/kernel/connect", {
					connection_file: params.connection_file,
					set_default: params.set_default ?? true,
				});
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
	// 2. kernel_run_python
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
	// 3. kernel_eval_expr
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
	// 4. kernel_interrupt
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
	// 5. kernel_get_output
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
	// 6. kernel_status
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
				const data = await serverGet("/kernel/status") as {
					connected: boolean;
					connection_file: string;
					port: number;
				};

				const lines: string[] = [];
				lines.push(`🔌 Kernel server port: ${data.port}`);
				lines.push(`📁 Connection file: ${data.connection_file || "(not set)"}`);
				lines.push(`🔗 Connected: ${data.connected ? "✅ yes" : "❌ no"}`);

				if (!data.connected && data.connection_file) {
					lines.push("");
					lines.push("⚠️  Not connected. Make sure the kernel is running:");
					lines.push("   uv run ipython kernel --profile=agno -f <connection_file>");
					lines.push("   Then use kernel_connect to connect.");
				}

				return {
					content: [{ type: "text", text: lines.join("\n") }],
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
}

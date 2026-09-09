/**
 * Outbound MCP client for channel-scoped servers.
 *
 * The Planner's tools are all local Chopin `Tool`s; a remote MCP server is
 * adapted into that shape here. Each remote tool becomes one namespaced
 * `mcp__<server>__<tool>` entry whose handler performs the remote call with
 * the caller's own sealed credential. There is no shared credential — a
 * member without one simply does not get that server's tools.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { ChannelMcp } from "../storage/model";
import type { Tool } from "./types";

const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 30_000;

export type Auth =
	| { kind: "bearer"; token: string }
	| { kind: "headers"; headers: Record<string, string> }
	| undefined;

function headers(auth: Auth): Record<string, string> {
	if (!auth) return {};
	if (auth.kind === "bearer") return { authorization: `Bearer ${auth.token}` };
	return { ...auth.headers };
}

function bounded<T>(operation: Promise<T>, message: string, timeoutMs: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let timer = setTimeout(() => reject(new Error(message)), timeoutMs);
		operation.then(
			value => {
				clearTimeout(timer);
				resolve(value);
			},
			err => {
				clearTimeout(timer);
				reject(err);
			},
		);
	});
}

function textOf(content: unknown): string {
	if (!Array.isArray(content)) return String(content ?? "");
	return content
		.map(block =>
			block && typeof block === "object" && !Array.isArray(block)
				&& "type" in block && (block as { type?: unknown }).type === "text"
				&& "text" in block && typeof (block as { text?: unknown }).text === "string"
				? (block as { text: string }).text
				: ""
		)
		.filter(Boolean)
		.join("\n");
}

/** Open a connected client to one channel-scoped MCP server under `auth`. */
async function connect(server: ChannelMcp, auth: Auth): Promise<Client> {
	let client = new Client(
		{ name: `chopin-${server.name}`, version: "0.0.0" },
		{ capabilities: {} },
	);
	let transport = new StreamableHTTPClientTransport(new URL(server.url), {
		requestInit: { headers: headers(auth) },
	});
	await bounded(
		client.connect(transport),
		`MCP ${server.name} did not connect`,
		CONNECT_TIMEOUT_MS,
	);
	return client;
}

/**
 * Call one named tool on a channel-scoped MCP server under `auth`, once.
 *
 * Used by the Cadence push path, which knows the exact tool and arguments up
 * front (no listing). The tool name is validated against the server's
 * advertised list before the call — a push never invokes a tool the server
 * does not offer. Returns the flattened text result. Throws on connect,
 * unknown-tool, or call failure so the caller can record `failed`.
 */
export async function callServerTool(
	server: ChannelMcp,
	auth: Auth,
	tool: string,
	args: Record<string, unknown>,
): Promise<string> {
	let client = await connect(server, auth);
	try {
		let listed = await bounded(
			client.listTools(),
			`MCP ${server.name} did not list tools`,
			CONNECT_TIMEOUT_MS,
		);
		let available = new Set((listed.tools ?? []).map(entry => entry.name));
		if (!available.has(tool)) {
			throw new Error(`MCP ${server.name} does not offer tool ${tool}`);
		}
		let result = await bounded(
			client.callTool({ name: tool, arguments: args }),
			`MCP ${server.name}/${tool} did not answer`,
			CALL_TIMEOUT_MS,
		);
		let text = textOf((result as { content?: unknown }).content);
		if ((result as { isError?: boolean }).isError) {
			throw new Error(`MCP ${server.name}/${tool} returned an error: ${text || "unknown error"}`);
		}
		return text;
	} finally {
		await client.close().catch(() => {});
	}
}

/**
 * Open one channel-scoped MCP server and wrap its tools as Chopin tools.
 *
 * Connect, list, and call all bound; a failure to connect yields no tools
 * (the caller logs/skips) rather than a half-open server.
 */
export async function openServer(server: ChannelMcp, auth: Auth): Promise<Tool[]> {
	let client = new Client(
		{ name: `chopin-${server.name}`, version: "0.0.0" },
		{ capabilities: {} },
	);
	let transport = new StreamableHTTPClientTransport(new URL(server.url), {
		requestInit: { headers: headers(auth) },
	});
	await bounded(
		client.connect(transport),
		`MCP ${server.name} did not connect`,
		CONNECT_TIMEOUT_MS,
	);

	let listed = await bounded(
		client.listTools(),
		`MCP ${server.name} did not list tools`,
		CONNECT_TIMEOUT_MS,
	);
	let remote = listed.tools ?? [];

	return remote.map(tool => ({
		name: `mcp__${server.name}__${tool.name}`,
		description: tool.description ?? `MCP tool ${tool.name} on ${server.name}`,
		parameters: (tool.inputSchema && typeof tool.inputSchema === "object"
			? tool.inputSchema
			: { type: "object", properties: {}, additionalProperties: false }) as Tool["parameters"],
		handler: async args => {
			let result = await bounded(
				client.callTool({ name: tool.name, arguments: (args ?? {}) as Record<string, unknown> }),
				`MCP ${server.name}/${tool.name} did not answer`,
				CALL_TIMEOUT_MS,
			);
			// MCP results are untrusted content — validated for shape, never executed.
			let content = (result as { content?: unknown }).content;
			return textOf(content);
		},
	}));
}

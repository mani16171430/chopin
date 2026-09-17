/**
 * Channel-scoped MCP servers a chat's Clasher may call.
 *
 * Definitions are shared by the channel; credentials are per (channel, name,
 * principal) and sealed with the channel-and-principal-bound AAD before they
 * reach storage. Adding or removing an MCP, or a member setting their own
 * credential, refreshes the room's Clasher session so the next turn rebuilds
 * its tool list.
 */

import { decrypted, encrypted, imported } from "../auth/seal";
import { resetAgent } from "./service";
import { openServer } from "../agent/mcp";
import { broadcast, reply } from "../wire";

import type { Room } from "./service";
import type { Socket } from "../wire";
import type { ChannelMcp } from "../storage/model";
import type { Tool } from "../agent/types";
import type { Chat as Wire, Request } from "@chopin/protocol";

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_URL_BYTES = 2_048;
const MAX_HEADERS = 20;
const MAX_HEADER_VALUE_BYTES = 8_192;

type AuthInput = Wire.McpAdd["auth"];

function aad(room: Room, principalId: string): string {
	return `chopin:mcp-credential:v1:${room.room}:${principalId}`;
}

function invalid(reason: string): never {
	throw new Error(`invalid MCP: ${reason}`);
}

function validName(value: unknown): string {
	if (typeof value !== "string" || !NAME.test(value)) {
		invalid("name must be lowercase letters, numbers and hyphens, 2-63 chars");
	}
	return value;
}

function validUrl(value: unknown): string {
	if (typeof value !== "string" || Buffer.byteLength(value) > MAX_URL_BYTES) {
		invalid("url must be a string under 2 KiB");
	}
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		invalid("url must be absolute");
	}
	if (parsed.protocol !== "https:") invalid("url must be HTTPS");
	if (parsed.username || parsed.password) invalid("url must not carry credentials");
	return parsed.toString();
}

function validAuth(value: unknown): AuthInput {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		invalid("auth must be an object");
	}
	let record = value as Record<string, unknown>;
	if (record.kind === "bearer") {
		if (typeof record.token !== "string" || !record.token.trim()) {
			invalid("bearer auth needs a non-empty token");
		}
		if (Buffer.byteLength(record.token) > MAX_HEADER_VALUE_BYTES) {
			invalid("bearer token is too long");
		}
		return { kind: "bearer", token: record.token };
	}
	if (record.kind === "headers") {
		if (
			!record.headers || typeof record.headers !== "object" || Array.isArray(record.headers)
		) invalid("headers auth needs a headers object");
		let headers = record.headers as Record<string, unknown>;
		let entries = Object.entries(headers);
		if (entries.length === 0 || entries.length > MAX_HEADERS) {
			invalid(`headers auth needs between 1 and ${MAX_HEADERS} headers`);
		}
		let out: Record<string, string> = {};
		for (let [key, val] of entries) {
			if (typeof val !== "string" || !val.trim()) invalid(`header ${key} must be a string`);
			if (Buffer.byteLength(val) > MAX_HEADER_VALUE_BYTES) invalid(`header ${key} is too long`);
			out[key] = val;
		}
		return { kind: "headers", headers: out };
	}
	invalid("auth kind must be bearer or headers");
}

/** The channel's MCP list, redacted, for one requester. */
async function list(room: Room, principalId: string): Promise<Wire.Mcp[]> {
	let servers = await room.auth.storage.channelMcps.list(room.room);
	let credentials = await room.auth.storage.channelMcps.credentials(room.room, principalId);
	let held = new Set(credentials.map(value => value.name));
	return servers.map(mcp => ({
		name: mcp.name,
		url: mcp.url,
		added_by: mcp.addedBy,
		added_at: Math.floor(mcp.createdAt.getTime() / 1_000),
		has_credential: held.has(mcp.name),
	}));
}

/** Register an MCP server on this chat. Editors only. */
export async function add(room: Room, ws: Socket, msg: Request<Wire.McpAdd>): Promise<void> {
	let name = validName(msg.name);
	let url = validUrl(msg.url);
	let auth = validAuth(msg.auth);

	let existing = await room.auth.storage.channelMcps.get(room.room, name);
	if (existing) {
		return reply(ws, msg.rid, {
			kind: "session:error",
			ts: 0,
			message: `MCP ${name} already exists`,
		});
	}

	let record: ChannelMcp = await room.auth.storage.channelMcps.add({
		channelId: room.room,
		name,
		url,
		addedBy: ws.data.handle,
		now: new Date(),
	});

	if (auth) await setCredential(room, ws.data.principalId, name, auth);

	reply(ws, msg.rid, { kind: "chat:mcp", ts: 0, name: record.name });
	let servers = await list(room, ws.data.principalId);
	broadcast(room.server, room.room, { kind: "chat:mcps", ts: 0, servers });
	await resetAgent(room.chat, undefined, undefined, "MCP configuration changed");
}

/** Remove an MCP server from this chat. Editors only. */
export async function remove(room: Room, ws: Socket, msg: Request<Wire.McpRemove>): Promise<void> {
	let name = validName(msg.name);
	let removed = await room.auth.storage.channelMcps.remove(room.room, name);
	if (!removed) {
		return reply(ws, msg.rid, {
			kind: "session:error",
			ts: 0,
			message: `MCP ${name} does not exist`,
		});
	}
	reply(ws, msg.rid, { kind: "chat:mcp", ts: 0, name });
	let servers = await list(room, ws.data.principalId);
	broadcast(room.server, room.room, { kind: "chat:mcps", ts: 0, servers });
	await resetAgent(room.chat, undefined, undefined, "MCP configuration changed");
}

/**
 * Set or clear the caller's own credential for one of the chat's MCPs.
 *
 * The credential is sealed with the channel-and-principal-bound AAD before it
 * touches storage; only the room that opened this channel for this principal
 * can open it again. Replied to the requester only — never broadcast.
 */
export async function credential(
	room: Room,
	ws: Socket,
	msg: Request<Wire.McpCredential>,
): Promise<void> {
	let name = validName(msg.name);
	let auth = validAuth(msg.auth);

	let existing = await room.auth.storage.channelMcps.get(room.room, name);
	if (!existing) {
		return reply(ws, msg.rid, {
			kind: "session:error",
			ts: 0,
			message: `MCP ${name} does not exist`,
		});
	}

	if (auth === undefined) {
		await room.auth.storage.channelMcps.clearCredential(room.room, name, ws.data.principalId);
		reply(ws, msg.rid, { kind: "chat:mcp:credential", ts: 0, name, has_credential: false });
	} else {
		await setCredential(room, ws.data.principalId, name, auth);
		reply(ws, msg.rid, { kind: "chat:mcp:credential", ts: 0, name, has_credential: true });
	}
	await resetAgent(room.chat, undefined, undefined, "MCP credential changed");
}

async function setCredential(
	room: Room,
	principalId: string,
	name: string,
	auth: NonNullable<AuthInput>,
): Promise<void> {
	let key = await imported(room.config.auth.encryptionKey);
	let sealed = await encrypted(key, aad(room, principalId), auth);
	await room.auth.storage.channelMcps.setCredential({
		channelId: room.room,
		name,
		principalId,
		sealed,
		now: new Date(),
	});
}

/** The channel's MCP list, redacted, for this socket's requester. */
export async function mcps(room: Room, ws: Socket, msg: Request<Wire.McpList>): Promise<void> {
	let servers = await list(room, ws.data.principalId);
	reply(ws, msg.rid, { kind: "chat:mcps", ts: 0, servers });
}

/**
 * Resolve one chat MCP server and a member's own decrypted credential for it.
 *
 * Returns `{ server, auth }` when the chat has the named server and the member
 * has a credential for it; otherwise a `reason` the caller surfaces. Never
 * returns a credential belonging to anyone but `principalId`. Used by the
 * Cadence push path, which must run under the pushing member's own credential.
 */
export async function resolveServer(
	room: Room,
	principalId: string,
	name: string,
): Promise<
	{ server: ChannelMcp; auth: NonNullable<AuthInput> } | { reason: string }
> {
	let server = await room.auth.storage.channelMcps.get(room.room, name);
	if (!server) return { reason: `MCP ${name} is not configured on this chat` };
	let credential = await room.auth.storage.channelMcps.credential(room.room, name, principalId);
	if (!credential) return { reason: `You have no credential for MCP ${name}` };
	let key = await imported(room.config.auth.encryptionKey);
	try {
		let auth = (await decrypted(key, aad(room, principalId), credential.sealed)) as AuthInput;
		if (!auth) return { reason: `Your credential for MCP ${name} could not be read` };
		return { server, auth };
	} catch {
		return { reason: `Your credential for MCP ${name} could not be read` };
	}
}

/**
 * Open the channel's MCP servers for one sender.
 *
 * Only servers the sender has supplied a credential for are opened; the rest
 * are skipped for this turn. Each remote tool is wrapped as a Chopin Tool whose
 * handler calls the remote server with the sender-scoped credential.
 */
export async function toolsFor(
	room: Room,
	principalId: string,
): Promise<{ tools: Tool[]; skipped: string[] }> {
	let servers = await room.auth.storage.channelMcps.list(room.room);
	let credentials = await room.auth.storage.channelMcps.credentials(room.room, principalId);
	let byName = new Map(credentials.map(value => [value.name, value]));
	let opened: Tool[] = [];
	let skipped: string[] = [];

	let key = await imported(room.config.auth.encryptionKey);
	for (let server of servers) {
		let credential = byName.get(server.name);
		if (!credential) {
			skipped.push(server.name);
			continue;
		}
		let auth: AuthInput;
		try {
			auth = (await decrypted(key, aad(room, principalId), credential.sealed)) as AuthInput;
		} catch {
			skipped.push(server.name);
			continue;
		}
		opened.push(...await openServer(server, auth));
	}
	return { tools: opened, skipped };
}

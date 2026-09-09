/**
 * Channel-scoped MCP servers.
 *
 * Definitions are shared by the channel; credentials are per (channel, name,
 * principal), sealed before storage, and never broadcast. Adding or removing
 * an MCP, or a member setting their own credential, refreshes the room's
 * Planner session so the next turn rebuilds its tool list.
 */

import { describe, expect, it } from "bun:test";

import { MemoryStorage } from "../storage/memory/adapter";
import { add, credential, mcps, remove } from "./mcps";

import type { Server } from "bun";
import type { Chat, Room } from "./service";
import type { Socket, SocketData } from "../wire";
import type { Chat as Wire, Request } from "@chopin/protocol";

type Captured = {
	kind: string;
	[key: string]: unknown;
};

function room(chat: Chat, storage: MemoryStorage) {
	let sent: Captured[] = [];
	let server = {
		publish(_topic: string, data: string) {
			sent.push(JSON.parse(data) as Captured);
		},
	} as unknown as Server<SocketData>;
	let auth = {
		storage,
		sessions: { resolve: async () => undefined },
		admission: { allowed: async () => true },
		github: { repositoryAccess: async () => undefined },
	};
	return {
		sent,
		context: {
			chat,
			server,
			room: "room",
			plan: {},
			config: { agent: true, auth: { encryptionKey: new Uint8Array(32).fill(7) } },
			auth,
			claimantSessionId: "claimant",
			repository: { id: "R", owner: "o", name: "r", defaultBranch: "main" },
			persist: async () => {},
		} as unknown as Room,
	};
}

let replies: Captured[] = [];

function socket(principalId: string, handle: string): Socket {
	return {
		data: { principalId, handle, room: "room" } as SocketData,
		send(data: string) {
			replies.push(JSON.parse(data) as Captured);
		},
		publish() {},
	} as unknown as Socket;
}

function rid(): string {
	return crypto.randomUUID().slice(0, 8);
}

describe("channel-scoped MCP servers", () => {
	it("adds a server, redacts it in the list, and broadcasts to the room", async () => {
		replies = [];
		let storage = new MemoryStorage();
		let { sent, context } = room({ sessions: new Map() } as unknown as Chat, storage);

		let ana = socket("user-ana", "ana");
		let request: Request<Wire.McpAdd> = {
			kind: "chat:mcp:add",
			ts: 0,
			rid: rid(),
			name: "docs-search",
			url: "https://mcp.example.com/mcp",
		};
		await add(context, ana, request);

		expect(replies.some(value => value.kind === "chat:mcp" && value.name === "docs-search"))
			.toBe(true);
		expect(sent.some(value => value.kind === "chat:mcps")).toBe(true);

		let listed = await storage.channelMcps.list("room");
		expect(listed).toHaveLength(1);
		expect(listed[0]!.name).toBe("docs-search");
		expect(listed[0]!.url).toBe("https://mcp.example.com/mcp");
		expect(listed[0]!.addedBy).toBe("ana");
	});

	it("keeps a member's credential private and out of the room broadcast", async () => {
		replies = [];
		let storage = new MemoryStorage();
		let { sent, context } = room({ sessions: new Map() } as unknown as Chat, storage);

		let ana = socket("user-ana", "ana");
		let bob = socket("user-bob", "bob");
		await add(context, ana, {
			kind: "chat:mcp:add",
			ts: 0,
			rid: rid(),
			name: "docs-search",
			url: "https://mcp.example.com/mcp",
		});

		await credential(context, ana, {
			kind: "chat:mcp:credential",
			ts: 0,
			rid: rid(),
			name: "docs-search",
			auth: { kind: "bearer", token: "secret-token" },
		});
		expect(
			replies.some(value => value.kind === "chat:mcp:credential" && value.has_credential === true),
		)
			.toBe(true);
		expect(sent.some(value => value.kind === "chat:mcp:credential")).toBe(false);

		replies = [];
		await mcps(context, bob, { kind: "chat:mcp:list", ts: 0, rid: rid() });
		let listed = replies.find(value => value.kind === "chat:mcps");
		expect(listed).toBeDefined();
		let servers = (listed as unknown as { servers: Wire.Mcp[] }).servers;
		expect(servers).toHaveLength(1);
		expect(servers[0]!.has_credential).toBe(false);

		replies = [];
		await mcps(context, ana, { kind: "chat:mcp:list", ts: 0, rid: rid() });
		let ownListed = replies.find(value => value.kind === "chat:mcps");
		let own = (ownListed as unknown as { servers: Wire.Mcp[] }).servers;
		expect(own[0]!.has_credential).toBe(true);
	});

	it("clears a member's credential without touching the server", async () => {
		replies = [];
		let storage = new MemoryStorage();
		let { context } = room({ sessions: new Map() } as unknown as Chat, storage);

		let ana = socket("user-ana", "ana");
		await add(context, ana, {
			kind: "chat:mcp:add",
			ts: 0,
			rid: rid(),
			name: "docs-search",
			url: "https://mcp.example.com/mcp",
		});
		await credential(context, ana, {
			kind: "chat:mcp:credential",
			ts: 0,
			rid: rid(),
			name: "docs-search",
			auth: { kind: "bearer", token: "secret-token" },
		});
		await credential(context, ana, {
			kind: "chat:mcp:credential",
			ts: 0,
			rid: rid(),
			name: "docs-search",
		});

		expect(
			replies.some(value => value.kind === "chat:mcp:credential" && value.has_credential === false),
		)
			.toBe(true);
		expect(await storage.channelMcps.list("room")).toHaveLength(1);
		expect(await storage.channelMcps.credential("room", "docs-search", "user-ana")).toBeUndefined();
	});

	it("removes a server and cascades its credentials", async () => {
		replies = [];
		let storage = new MemoryStorage();
		let { sent, context } = room({ sessions: new Map() } as unknown as Chat, storage);

		let ana = socket("user-ana", "ana");
		await add(context, ana, {
			kind: "chat:mcp:add",
			ts: 0,
			rid: rid(),
			name: "docs-search",
			url: "https://mcp.example.com/mcp",
			auth: { kind: "bearer", token: "secret-token" },
		});
		await remove(context, ana, {
			kind: "chat:mcp:remove",
			ts: 0,
			rid: rid(),
			name: "docs-search",
		});

		expect(sent.some(value => value.kind === "chat:mcps")).toBe(true);
		expect(await storage.channelMcps.list("room")).toHaveLength(0);
		expect(await storage.channelMcps.credentials("room", "user-ana")).toHaveLength(0);
	});

	it("rejects an invalid name and a non-HTTPS URL", async () => {
		replies = [];
		let storage = new MemoryStorage();
		let { context } = room({ sessions: new Map() } as unknown as Chat, storage);
		let ana = socket("user-ana", "ana");

		await expect(add(context, ana, {
			kind: "chat:mcp:add",
			ts: 0,
			rid: rid(),
			name: "Docs Search",
			url: "https://mcp.example.com/mcp",
		})).rejects.toThrow("name");

		await expect(add(context, ana, {
			kind: "chat:mcp:add",
			ts: 0,
			rid: rid(),
			name: "docs-search",
			url: "http://mcp.example.com/mcp",
		})).rejects.toThrow("HTTPS");
	});
});

/**
 * The room's shared Planner session.
 *
 * Anyone in the room may toggle it, and while it is on every member's message
 * is treated as addressed to the Planner — no per-message mention needed — so
 * the room can jam with the model together. The state is broadcast to the whole
 * room so every open tab reflects it, and it is ephemeral: it does not survive
 * a server restart or room eviction.
 */

import { describe, expect, it } from "bun:test";

import { create, send, sessionEnd, sessionStart } from "./service";

import type { Server } from "bun";
import type { Chat, Room } from "./service";
import type { Socket, SocketData } from "../wire";
import type { Chat as Wire } from "@chopin/protocol";

type Captured = {
	kind: string;
	[key: string]: unknown;
};

/**
 * A room whose server collects broadcast frames instead of publishing them.
 *
 * The agent never actually runs in these tests — `auth` is a stub that fails
 * owner resolution, which is exactly how a turn with no configured owner
 * already surfaces (a system message, turn ends). Session toggling, turn
 * start, and queue behavior are all observable before that point, which is
 * what this suite is for.
 */
function room(chat: Chat) {
	let sent: Captured[] = [];
	let server = {
		publish(_topic: string, data: string) {
			sent.push(JSON.parse(data) as Captured);
		},
	} as unknown as Server<SocketData>;
	let auth = {
		storage: {
			channels: {
				claimAgentOwner: async () => ({ ownerSessionId: undefined, generation: 0 }),
				updateAgentContext: async () => {},
			},
			collaboration: { load: async () => undefined },
		},
		sessions: {
			resolve: async () => undefined,
			inspect: async () => undefined,
			use: async (_session: unknown, _work: () => unknown) => ({
				authenticated: undefined,
				value: undefined,
			}),
		},
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
			config: { agent: true },
			auth,
			claimantSessionId: "claimant",
			repository: { id: "R", owner: "o", name: "r", defaultBranch: "main" },
			persist: async () => {},
		} as unknown as Room,
	};
}

let replies: Captured[] = [];

/** A socket whose replies are collected; distinct principal/handle per user. */
function socket(principalId: string, handle: string): Socket {
	return {
		data: {
			principalId,
			handle,
			room: "room",
		} as SocketData,
		send(data: string) {
			replies.push(JSON.parse(data) as Captured);
		},
		publish() {},
	} as unknown as Socket;
}

function message(text: string): Wire.Send & { rid: string } {
	return {
		kind: "chat:send",
		ts: 0,
		rid: crypto.randomUUID().slice(0, 8),
		requestId: crypto.randomUUID(),
		text,
		to: "room",
	};
}

function wait(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/** Everything the server broadcast that was a turn starting. */
function turnsStarted(sent: Captured[]): Captured[] {
	return sent.filter(frame => frame.kind === "chat:state" && frame.busy === true);
}

/** Session state frames the server broadcast. */
function sessionFrames(sent: Captured[]): Captured[] {
	return sent.filter(frame => frame.kind === "chat:session");
}

describe("the room's shared Planner session", () => {
	it("turns it on for the whole room and broadcasts the change", async () => {
		replies = [];
		let chat = create();
		let { sent, context } = room(chat);
		let ana = socket("user-ana", "ana");

		sessionStart(context, ana, { kind: "chat:session-start", ts: 0, rid: "r1" });

		// The requester is answered and the room is told.
		expect(replies.some(frame => frame.kind === "chat:session" && frame.active === true))
			.toBe(true);
		expect(sessionFrames(sent).some(frame => frame.active === true && frame.by === "ana"))
			.toBe(true);
		expect(chat.session.active).toBe(true);

		// A message from anyone now becomes a turn, with no mention.
		await send(context, ana, message("no mention needed"));
		await wait(20);
		expect(turnsStarted(sent).length).toBeGreaterThan(0);
	});

	it("lets a different member's message drive the Planner while it is on", async () => {
		replies = [];
		let chat = create();
		let { sent, context } = room(chat);
		let ana = socket("user-ana", "ana");
		let bob = socket("user-bob", "bob");

		sessionStart(context, ana, { kind: "chat:session-start", ts: 0, rid: "r1" });
		// Bob never touched the toggle, but his message still becomes a turn.
		await send(context, bob, message("bob jumps in"));
		await wait(20);
		expect(turnsStarted(sent).length).toBeGreaterThan(0);
	});

	it("keeps messages room-only once it is off", async () => {
		replies = [];
		let chat = create();
		let { sent, context } = room(chat);
		let ana = socket("user-ana", "ana");

		sessionStart(context, ana, { kind: "chat:session-start", ts: 0, rid: "r1" });
		sessionEnd(context, ana, { kind: "chat:session-end", ts: 0, rid: "r2" });

		expect(replies.some(frame => frame.kind === "chat:session" && frame.active === false))
			.toBe(true);
		expect(sessionFrames(sent).some(frame => frame.active === false && frame.by === "ana"))
			.toBe(true);
		expect(chat.session.active).toBe(false);

		await send(context, ana, message("back to plain chat"));
		await wait(20);
		expect(turnsStarted(sent)).toHaveLength(0);
	});

	it("refuses to start when the agent is off", async () => {
		replies = [];
		let chat = create();
		let { context } = room(chat);
		context.config = { agent: false } as Room["config"];
		let ana = socket("user-ana", "ana");

		sessionStart(context, ana, { kind: "chat:session-start", ts: 0, rid: "r1" });
		expect(replies.some(frame => frame.kind === "session:error")).toBe(true);
		expect(chat.session.active).toBe(false);
	});

	it("queues behind a turn already running", async () => {
		replies = [];
		let chat = create();
		chat.busy = true;
		chat.turn = { id: "turn-1", handle: "ana", started: 1, responded: false };
		let { context } = room(chat);
		let ana = socket("user-ana", "ana");

		sessionStart(context, ana, { kind: "chat:session-start", ts: 0, rid: "r1" });
		await send(context, ana, message("while you are busy"));

		expect(chat.waiting).toHaveLength(1);
		expect(chat.waiting[0]!.text).toBe("while you are busy");
	});
});

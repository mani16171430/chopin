/**
 * Cadence work-item proposals.
 *
 * The agent replaces the whole list; members complete low-confidence items and
 * push ready ones. A push runs under the member's own MCP credential — with no
 * credential (or no server) it fails closed and the item is marked failed.
 */

import { describe, expect, it } from "bun:test";

import { MemoryStorage } from "../storage/memory/adapter";
import { field, list, propose, push, pushAll } from "./service";

import type { Server } from "bun";
import type { Chat, Room } from "../chat/service";
import type { Socket, SocketData } from "../wire";
import type { ProposedCadenceUpdate } from "../storage/model";

type Captured = { kind: string; [key: string]: unknown };

function room(storage: MemoryStorage) {
	let sent: Captured[] = [];
	let server = {
		publish(_topic: string, data: string) {
			sent.push(JSON.parse(data) as Captured);
		},
	} as unknown as Server<SocketData>;
	return {
		sent,
		context: {
			chat: {} as Chat,
			server,
			room: "room",
			plan: {},
			config: { agent: true, auth: { encryptionKey: new Uint8Array(32).fill(7) } },
			auth: { storage },
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

let PROPOSALS: ProposedCadenceUpdate[] = [
	{
		team: "payments",
		op: "create",
		kind: "work_item",
		title: "Add refund webhook",
		fields: {
			operation: "create",
			workspace_slug: "razorpay",
			team_id: "t-1",
			name: "Add refund webhook",
		},
		confidence: 0.9,
		needs: [],
		status: "ready",
		mcpServer: "cadence",
		mcpTool: "work_item",
	},
	{
		team: "payments",
		op: "create",
		kind: "sub-issue",
		title: "Backfill refunds",
		fields: { operation: "create", workspace_slug: "razorpay" },
		confidence: 0.4,
		needs: ["team_id"],
		status: "needs_input",
		mcpServer: "cadence",
		mcpTool: "work_item",
	},
];

describe("cadence proposals", () => {
	it("replaces the list, orders by team+title, and broadcasts", async () => {
		let storage = new MemoryStorage();
		let { sent, context } = room(storage);

		let result = await propose(context, PROPOSALS);
		expect(result.count).toBe(2);
		expect(sent.some(value => value.kind === "cadence:items")).toBe(true);

		let stored = await storage.cadence.list("room");
		expect(stored.map(item => item.title)).toEqual(["Add refund webhook", "Backfill refunds"]);
		expect(stored[0]!.status).toBe("ready");
		expect(stored[1]!.status).toBe("needs_input");
	});

	it("lists the items in wire shape for the requester", async () => {
		replies = [];
		let storage = new MemoryStorage();
		let { context } = room(storage);
		await propose(context, PROPOSALS);

		await list(context, socket("ana", "ana"), { kind: "cadence:list", ts: 0, rid: rid() });
		let items = (replies.find(value => value.kind === "cadence:items") as unknown as {
			items: { mcp_server: string; team: string }[];
		}).items;
		expect(items).toHaveLength(2);
		expect(items[0]!.mcp_server).toBe("cadence");
	});

	it("saves an edit, marks the item ready, records the editor, and broadcasts", async () => {
		replies = [];
		let storage = new MemoryStorage();
		let { sent, context } = room(storage);
		await propose(context, PROPOSALS);
		let lowConfidence = (await storage.cadence.list("room")).find(item =>
			item.status === "needs_input"
		)!;

		sent.length = 0;
		await field(context, socket("ana", "ana"), {
			kind: "cadence:field",
			ts: 0,
			rid: rid(),
			id: lowConfidence.id,
			title: "Backfill 2024 refunds",
			fields: { title: "Backfill 2024 refunds", parent: "PAY-1" },
		});

		let saved = await storage.cadence.get("room", lowConfidence.id);
		expect(saved!.status).toBe("ready");
		expect(saved!.title).toBe("Backfill 2024 refunds");
		expect(saved!.fields.parent).toBe("PAY-1");
		expect(saved!.updatedBy).toBe("ana");
		expect(sent.some(value => value.kind === "cadence:items")).toBe(true);
	});

	it("rejects non-object fields on edit", async () => {
		replies = [];
		let storage = new MemoryStorage();
		let { context } = room(storage);
		await propose(context, PROPOSALS);
		let item = (await storage.cadence.list("room"))[0]!;

		await field(context, socket("ana", "ana"), {
			kind: "cadence:field",
			ts: 0,
			rid: rid(),
			id: item.id,
			fields: [1, 2, 3] as unknown as Record<string, unknown>,
		});
		expect(replies.some(value => value.kind === "session:error")).toBe(true);
	});

	it("fails a push closed when the member has no Cadence credential", async () => {
		replies = [];
		let storage = new MemoryStorage();
		let { sent, context } = room(storage);
		await propose(context, PROPOSALS);
		let ready = (await storage.cadence.list("room")).find(item => item.status === "ready")!;

		sent.length = 0;
		await push(context, socket("ana", "ana"), {
			kind: "cadence:push",
			ts: 0,
			rid: rid(),
			id: ready.id,
		});

		let after = await storage.cadence.get("room", ready.id);
		expect(after!.status).toBe("failed");
		expect(after!.error).toContain("MCP cadence");
		expect(replies.some(value => value.kind === "session:error")).toBe(true);
		expect(sent.some(value => value.kind === "cadence:item")).toBe(true);
	});

	it("refuses to push an item still needing input", async () => {
		replies = [];
		let storage = new MemoryStorage();
		let { context } = room(storage);
		await propose(context, PROPOSALS);
		let needs = (await storage.cadence.list("room")).find(item => item.status === "needs_input")!;

		await push(context, socket("ana", "ana"), {
			kind: "cadence:push",
			ts: 0,
			rid: rid(),
			id: needs.id,
		});
		expect(
			replies.some(value =>
				value.kind === "session:error" && String(value.message).includes("complete")
			),
		).toBe(true);
	});

	it("push-all replies that there is nothing to push when no item is ready", async () => {
		replies = [];
		let storage = new MemoryStorage();
		let { context } = room(storage);
		await propose(
			context,
			PROPOSALS.map(item => ({ ...item, status: "needs_input" as const })),
		);

		await pushAll(context, socket("ana", "ana"), { kind: "cadence:push-all", ts: 0, rid: rid() });
		expect(
			replies.some(value =>
				value.kind === "session:error" && String(value.message).includes("no ready items")
			),
		).toBe(true);
		expect(replies.some(value => value.kind === "cadence:push-all-result")).toBe(false);
	});

	it("push-all pushes only ready items and replies with the tally", async () => {
		replies = [];
		let storage = new MemoryStorage();
		let { context } = room(storage);
		await propose(context, PROPOSALS);
		// One more ready item alongside the existing one; the needs_input item must
		// be left alone. The list is ordered by team+title, so [1] is the duplicate
		// of "Add refund webhook" — mark it already pushed.
		await propose(context, [
			...PROPOSALS,
			{
				...PROPOSALS[0]!,
				title: "Add refund webhook (again)",
				fields: { operation: "create", workspace_slug: "razorpay" },
			},
		]);
		await storage.cadence.setStatus(
			"room",
			(await storage.cadence.list("room"))[1]!.id,
			"pushed",
			{ pushedUrl: "https://cadence.example/PAY-1" },
			new Date(),
		);

		await pushAll(context, socket("ana", "ana"), { kind: "cadence:push-all", ts: 0, rid: rid() });

		let stored = await storage.cadence.list("room");
		let byTitle = new Map(stored.map(item => [item.title, item]));
		// No credential in the memory store, so the ready item fails closed.
		expect(byTitle.get("Add refund webhook")!.status).toBe("failed");
		// Untouched: already pushed and still needs input.
		expect(byTitle.get("Add refund webhook (again)")!.status).toBe("pushed");
		expect(byTitle.get("Backfill refunds")!.status).toBe("needs_input");

		let result = replies.find(value => value.kind === "cadence:push-all-result") as unknown as {
			pushed: number;
			failed: number;
		};
		expect(result).toMatchObject({ pushed: 0, failed: 1 });
	});

	it("push-all pushes sequentially, finishing one item before starting the next", async () => {
		replies = [];
		let storage = new MemoryStorage();
		let { sent, context } = room(storage);
		await propose(context, [
			PROPOSALS[0]!,
			{ ...PROPOSALS[0]!, title: "Alert on refund failures" },
		]);

		sent.length = 0;
		await pushAll(context, socket("ana", "ana"), { kind: "cadence:push-all", ts: 0, rid: rid() });

		// No credential, so each item fails closed in turn — one item's broadcast
		// completes before the next item's begins (a parallel batch would interleave
		// the two failures only if resolution itself yielded out of order; the
		// awaited loop keeps them strictly in list order).
		let order = sent
			.filter(value => value.kind === "cadence:item")
			.map(value => {
				let item = value.item as { title: string; status: string };
				return `${item.title}:${item.status}`;
			});
		expect(order).toEqual([
			"Add refund webhook:failed",
			"Alert on refund failures:failed",
		]);
	});
	it("merge upserts a matched item in place, keeping its id, and appends the rest", async () => {
		let storage = new MemoryStorage();
		let { context } = room(storage);

		await propose(context, PROPOSALS);
		let before = await storage.cadence.list("room");
		let refundId = before.find(item => item.title === "Add refund webhook")!.id;

		// One item matches "Add refund webhook" (team+kind+title+op) — updated in
		// place — and one is new.
		let result = await propose(context, [
			{
				team: "payments",
				op: "create",
				kind: "work_item",
				title: "Add refund webhook",
				fields: { operation: "create", workspace_slug: "razorpay", team_id: "t-1", name: "Add refund webhook v2" },
				confidence: 0.95,
				needs: [],
				status: "ready",
				mcpServer: "cadence",
				mcpTool: "work_item",
			},
			{
				team: "risk",
				op: "create",
				kind: "work_item",
				title: "Flag suspicious refunds",
				fields: { operation: "create", workspace_slug: "razorpay", team_id: "t-2" },
				confidence: 0.8,
				needs: [],
				status: "ready",
				mcpServer: "cadence",
				mcpTool: "work_item",
			},
		], "merge");

		// The two originals plus one new = three; the matched one kept its id.
		expect(result.count).toBe(3);
		let after = await storage.cadence.list("room");
		expect(after).toHaveLength(3);
		let refund = after.find(item => item.title === "Add refund webhook")!;
		expect(refund.id).toBe(refundId);
		expect(refund.fields.name).toBe("Add refund webhook v2");
		expect(refund.confidence).toBe(0.95);
		expect(after.some(item => item.title === "Backfill refunds")).toBe(true);
		expect(after.some(item => item.title === "Flag suspicious refunds")).toBe(true);
	});

	it("replace still regenerates the whole list", async () => {
		let storage = new MemoryStorage();
		let { context } = room(storage);

		await propose(context, PROPOSALS);
		await propose(context, [PROPOSALS[0]!], "replace");

		let after = await storage.cadence.list("room");
		expect(after).toHaveLength(1);
		expect(after[0]!.title).toBe("Add refund webhook");
	});
});

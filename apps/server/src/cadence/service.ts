/**
 * Cadence work-item proposals for a channel.
 *
 * The agent regenerates the whole list (via the `propose_cadence_updates` tool,
 * driven by a member's Generate action); members complete the low-confidence
 * items and push any ready one to Cadence. A push calls the chat's Cadence MCP
 * server under the pushing member's own credential — a member without one is
 * refused, fail-closed. The list is shared and broadcast to the room; no
 * credential ever crosses the wire.
 */

import { resolveServer } from "../chat/mcps";
import { callServerTool } from "../agent/mcp";
import { broadcast, reply } from "../wire";

import type { Room } from "../chat/service";
import type { Socket } from "../wire";
import type { CadenceUpdate, ProposedCadenceUpdate } from "../storage/model";
import type { Cadence as Wire, Request } from "@chopin/protocol";

const MAX_TITLE = 400;
const MAX_TEAM = 200;
const MAX_FIELD_BYTES = 16_384;

function toWire(item: CadenceUpdate): Wire.Update {
	return {
		id: item.id,
		team: item.team,
		op: item.op,
		...(item.targetId ? { target_id: item.targetId } : {}),
		kind: item.kind,
		title: item.title,
		fields: item.fields,
		confidence: item.confidence,
		needs: item.needs,
		status: item.status,
		mcp_server: item.mcpServer,
		mcp_tool: item.mcpTool,
		...(item.pushedUrl ? { pushed_url: item.pushedUrl } : {}),
		...(item.error ? { error: item.error } : {}),
		...(item.updatedBy ? { updated_by: item.updatedBy } : {}),
		updated_at: Math.floor(item.updatedAt.getTime() / 1_000),
	};
}

/** Broadcast the whole list to the room. */
export async function broadcastItems(room: Room): Promise<void> {
	let items = await room.auth.storage.cadence.list(room.room);
	broadcast(room.server, room.room, { kind: "cadence:items", ts: 0, items: items.map(toWire) });
}

/**
 * Persist the room's proposal set and broadcast it.
 *
 * Supplied to the toolbox as `proposeCadence` so the `propose_cadence_updates`
 * agent tool can persist and broadcast without reaching into storage itself.
 * "replace" regenerates the whole list (the room-wide Generate); "merge"
 * upserts a passage-scoped set into it, keeping the items it does not touch.
 */
export async function propose(
	room: Room,
	items: ProposedCadenceUpdate[],
	mode: "replace" | "merge" = "replace",
): Promise<{ count: number }> {
	let saved = mode === "merge"
		? await room.auth.storage.cadence.merge(room.room, items, new Date())
		: await room.auth.storage.cadence.replaceAll(room.room, items, new Date());
	await broadcastItems(room);
	return { count: saved.length };
}

/** Send the current list to the requester (also used on join by the caller). */
export async function list(room: Room, ws: Socket, msg: Request<Wire.List>): Promise<void> {
	let items = await room.auth.storage.cadence.list(room.room);
	reply(ws, msg.rid, { kind: "cadence:items", ts: 0, items: items.map(toWire) });
}

function validFields(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("fields must be an object");
	}
	if (Buffer.byteLength(JSON.stringify(value)) > MAX_FIELD_BYTES) {
		throw new Error("fields are too large");
	}
	return value as Record<string, unknown>;
}

/**
 * Save a member's edits to one item and mark it ready.
 *
 * Any member may complete an item — that is the point of the low-confidence
 * box. A human review is what raises it to `ready`.
 */
export async function field(room: Room, ws: Socket, msg: Request<Wire.Field>): Promise<void> {
	let existing = await room.auth.storage.cadence.get(room.room, msg.id);
	if (!existing) {
		return reply(ws, msg.rid, { kind: "session:error", ts: 0, message: "item does not exist" });
	}
	let patch: {
		team?: string;
		title?: string;
		fields?: Record<string, unknown>;
		status?: CadenceUpdate["status"];
		updatedBy?: string;
	} = { updatedBy: ws.data.handle, status: "ready" };
	if (msg.team !== undefined) {
		if (typeof msg.team !== "string" || msg.team.length > MAX_TEAM) {
			return reply(ws, msg.rid, { kind: "session:error", ts: 0, message: "invalid team" });
		}
		patch.team = msg.team;
	}
	if (msg.title !== undefined) {
		if (typeof msg.title !== "string" || msg.title.length < 1 || msg.title.length > MAX_TITLE) {
			return reply(ws, msg.rid, { kind: "session:error", ts: 0, message: "invalid title" });
		}
		patch.title = msg.title;
	}
	if (msg.fields !== undefined) {
		try {
			patch.fields = validFields(msg.fields);
		} catch (err) {
			return reply(ws, msg.rid, {
				kind: "session:error",
				ts: 0,
				message: err instanceof Error ? err.message : "invalid fields",
			});
		}
	}
	await room.auth.storage.cadence.updateFields(room.room, msg.id, patch, new Date());
	await broadcastItems(room);
}

/**
 * Create or update one ready item in Cadence, under the caller's credential.
 *
 * Any member may push; the call goes out under that member's own sealed MCP
 * credential for the chat's Cadence server, so it carries their identity and
 * nobody else's. A member without a credential, or a chat without the server,
 * is refused (the item is marked failed with the reason).
 */
export async function push(room: Room, ws: Socket, msg: Request<Wire.Push>): Promise<void> {
	let item = await room.auth.storage.cadence.get(room.room, msg.id);
	if (!item) {
		return reply(ws, msg.rid, { kind: "session:error", ts: 0, message: "item does not exist" });
	}
	if (item.status === "needs_input") {
		return reply(ws, msg.rid, {
			kind: "session:error",
			ts: 0,
			message: "complete the item before pushing it",
		});
	}
	if (item.status === "pushing" || item.status === "pushed") return;

	let pushed = await pushOne(room, ws.data.principalId, item);
	if (!pushed.ok) {
		return reply(ws, msg.rid, { kind: "session:error", ts: 0, message: pushed.reason });
	}
}

/**
 * Push every ready item in the room, sequentially, under the caller's
 * credential, and reply with the pushed/failed tally. Items may name different
 * MCP servers, so the credential is resolved per item — a ready item whose
 * server cannot be resolved is marked failed with the reason, never pushed
 * under another identity.
 */
export async function pushAll(room: Room, ws: Socket, msg: Request<Wire.PushAll>): Promise<void> {
	let items = await room.auth.storage.cadence.list(room.room);
	let ready = items.filter(item => item.status === "ready");
	if (ready.length === 0) {
		return reply(ws, msg.rid, {
			kind: "session:error",
			ts: 0,
			message: "no ready items to push",
		});
	}

	let pushed = 0;
	let failed = 0;
	for (let item of ready) {
		let result = await pushOne(room, ws.data.principalId, item);
		if (result.ok) pushed += 1;
		else failed += 1;
	}
	reply(ws, msg.rid, { kind: "cadence:push-all-result", ts: 0, pushed, failed });
}

/**
 * Push one item to Cadence under the member's own credential: resolve the
 * server, walk the item through pushing → pushed/failed, and broadcast each
 * step. Shared by the single push and push-all so both run identical logic.
 */
async function pushOne(
	room: Room,
	principalId: string,
	item: CadenceUpdate,
): Promise<{ ok: true } | { ok: false; reason: string }> {
	let resolved = await resolveServer(room, principalId, item.mcpServer);
	if ("reason" in resolved) {
		let failed = await room.auth.storage.cadence.setStatus(
			room.room,
			item.id,
			"failed",
			{ error: resolved.reason },
			new Date(),
		);
		if (failed) {
			broadcast(room.server, room.room, { kind: "cadence:item", ts: 0, item: toWire(failed) });
		}
		return { ok: false, reason: resolved.reason };
	}

	let pushing = await room.auth.storage.cadence.setStatus(
		room.room,
		item.id,
		"pushing",
		{},
		new Date(),
	);
	if (pushing) {
		broadcast(room.server, room.room, { kind: "cadence:item", ts: 0, item: toWire(pushing) });
	}

	try {
		let output = await callServerTool(resolved.server, resolved.auth, item.mcpTool, item.fields);
		let url = firstUrl(output);
		// Capture the id/ref of what was created so a refresh still shows the real
		// target and renders the card as done, not as a fresh create. `pushedUrl`
		// doubles as a non-empty result marker for setStatus, so fall back to the
		// resolved target when Cadence returns no URL.
		let targetId = firstId(output) ?? item.targetId;
		let done = await room.auth.storage.cadence.setStatus(
			room.room,
			item.id,
			"pushed",
			{ pushedUrl: url ?? targetId ?? "", ...(targetId ? { targetId } : {}) },
			new Date(),
		);
		if (done) {
			broadcast(room.server, room.room, { kind: "cadence:item", ts: 0, item: toWire(done) });
		}
		return { ok: true };
	} catch (err) {
		let reason = err instanceof Error ? err.message : "push failed";
		let done = await room.auth.storage.cadence.setStatus(
			room.room,
			item.id,
			"failed",
			{ error: reason },
			new Date(),
		);
		if (done) {
			broadcast(room.server, room.room, { kind: "cadence:item", ts: 0, item: toWire(done) });
		}
		return { ok: false, reason };
	}
}

/** Best-effort: pull a link out of the MCP tool's text result, for the card. */
function firstUrl(text: string): string | undefined {
	let match = text.match(/https?:\/\/[^\s"']+/);
	return match?.[0];
}

/**
 * Best-effort: pull the created entity's ref or id out of the MCP tool's text
 * result. Cadence echoes things like `"ref": "CADENCE-14"` or
 * `"id": "<uuid>"` / `"project_id": "<uuid>"`; any of them is enough to render
 * the card as pushed after a refresh.
 */
function firstId(text: string): string | undefined {
	let ref = text.match(/\b([A-Z][A-Z0-9]+-\d+)\b/);
	if (ref) return ref[1];
	let uuid = text.match(
		/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i,
	);
	return uuid?.[0];
}

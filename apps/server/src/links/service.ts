/**
 * The "Links" graph for a channel's document.
 *
 * The planner connects the document to the repositories, pull requests and AI
 * Docs it is about (the `link_entities` tool, which persists through here and
 * then broadcasts). Members read the set on join and remove links they don't
 * want. Adding is idempotent; removing is any member's call. No credential is
 * involved — a link is a name and a URL, never a secret.
 */

import { broadcast, reply } from "../wire";

import type { Room } from "../chat/service";
import type { Socket } from "../wire";
import type { ChannelLink } from "../storage/model";
import type { Links as Wire, Request } from "@chopin/protocol";

function toWire(link: ChannelLink): Wire.Update {
	return {
		id: link.id,
		kind: link.kind,
		ref_key: link.refKey,
		title: link.title,
		...(link.subtitle ? { subtitle: link.subtitle } : {}),
		...(link.url ? { url: link.url } : {}),
		created_by: link.createdBy,
		created_at: Math.floor(link.createdAt.getTime() / 1_000),
	};
}

/** Broadcast the whole link set to the room. */
export async function broadcastLinks(room: Room): Promise<void> {
	let links = await room.auth.storage.links.list(room.room);
	broadcast(room.server, room.room, {
		kind: "links:changed",
		ts: 0,
		links: links.map(toWire),
	});
}

/** Send the current set to the requester (also used on join by the caller). */
export async function list(room: Room, ws: Socket, msg: Request<Wire.List>): Promise<void> {
	let links = await room.auth.storage.links.list(room.room);
	reply(ws, msg.rid, { kind: "links:list", ts: 0, links: links.map(toWire) });
}

/** Remove one link. Any member may. */
export async function remove(room: Room, ws: Socket, msg: Request<Wire.Remove>): Promise<void> {
	let removed = await room.auth.storage.links.remove(room.room, msg.id);
	if (!removed) {
		return reply(ws, msg.rid, {
			kind: "session:error",
			ts: 0,
			message: "that link does not exist",
		});
	}
	reply(ws, msg.rid, { kind: "links:removed", ts: 0, id: msg.id });
	await broadcastLinks(room);
}

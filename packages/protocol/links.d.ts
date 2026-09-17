import type { Frame, Request } from "./index";

type KIND<K extends string> = Frame & { kind: K };

/**
 * The "Links" graph for a channel's document — the repositories, pull requests
 * and AI Docs the planner has connected it to.
 *
 * `links:generate` is a member button that starts a Clasher turn on a canned
 * directive (the same shape as `cadence:generate` / `doc:generate-ai`): the
 * planner reads the room and calls `link_entities`, which persists and then
 * broadcasts `links:changed`. Any member may remove a link. The set is shared
 * by the room; a link carries a name and a URL, never a credential.
 */
export declare namespace Links {
	export type Incoming = Request<Generate> | Request<List> | Request<Remove>;

	export type Outgoing = Changed | Removed | List.Reply;

	/** One linked entity, rendered as a card keyed on `kind`. */
	export type Update = {
		id: string;
		kind: "repo" | "pull_request" | "ai_doc";
		/** Canonical identity — owner/name, owner/name#123, or the AI doc id. */
		ref_key: string;
		title: string;
		/** A status line, e.g. "merged" or "repo · private". */
		subtitle?: string;
		url?: string;
		created_by: string;
		created_at: number;
	};

	/** Regenerate the room's link set from its document. Any member. */
	export type Generate = KIND<"links:generate">;

	export namespace List {
		export type Ask = KIND<"links:list">;
		export type Reply = KIND<"links:list"> & { links: Update[] };
	}
	export type List = List.Ask;

	/** Remove one link by id. Any member. */
	export type Remove = KIND<"links:remove"> & { id: string };

	/** The whole set changed; tabs re-render from it. */
	export type Changed = KIND<"links:changed"> & { links: Update[] };

	/** A removal was accepted. */
	export type Removed = KIND<"links:removed"> & { id: string };
}

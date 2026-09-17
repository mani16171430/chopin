import type { Frame, Request } from "./index";

type KIND<K extends string> = Frame & { kind: K };

/**
 * Cadence work-item proposals.
 *
 * The agent derives a list of work-items / sub-issues / projects to create or
 * update in Cadence from the room's document, decisions and chat, grouping them
 * by the team they go under and scoring each with a confidence. Members complete
 * the low-confidence ones and push any ready item to Cadence — the push calls
 * the chat's `cadence` MCP server under the pushing member's own credential.
 *
 * The item list is shared by the room (broadcast); a member's push runs under
 * their own MCP credential, so a member without one is refused, fail-closed.
 */
export declare namespace Cadence {
	export type Incoming =
		| Request<Generate>
		| Request<Propose>
		| Request<Field>
		| Request<Push>
		| Request<PushAll>
		| Request<List>;

	export type Outgoing = Items | Item | PushAllResult;

	/** One proposed Cadence entity, grouped under `team`. Never carries a credential. */
	export type Update = {
		id: string;
		/** The team this item goes under; "" renders as "Unassigned". */
		team: string;
		op: "create" | "update";
		/** The Cadence entity updated, when op is "update". */
		target_id?: string;
		kind: string;
		title: string;
		/** The arguments a push hands to the MCP tool; also the editable form. */
		fields: Record<string, unknown>;
		confidence: number;
		/** Arguments the agent could not resolve — what the edit form asks for. */
		needs: string[];
		status: "needs_input" | "ready" | "pushing" | "pushed" | "failed";
		/** The chat MCP server + tool a push calls. */
		mcp_server: string;
		mcp_tool: string;
		pushed_url?: string;
		error?: string;
		updated_by?: string;
		updated_at: number;
	};

	/** Regenerate the whole proposal list from the room's material. Any member. */
	export type Generate = KIND<"cadence:generate">;

	/**
	 * Propose Cadence work for one selected passage of the document. Clasher
	 * resolves it against the Cadence MCP and merges the result into the list
	 * rather than replacing it. Any member.
	 */
	export type Propose = KIND<"cadence:propose"> & { passage: string };

	/** Save a member's edits to one item's fields; the item becomes ready. Any member. */
	export type Field = KIND<"cadence:field"> & {
		id: string;
		team?: string;
		title?: string;
		fields?: Record<string, unknown>;
	};

	/** Create or update one ready item in Cadence, under the caller's credential. Any member. */
	export type Push = KIND<"cadence:push"> & { id: string };

	/**
	 * Push every ready item in the room, one after another, under the caller's
	 * credential. Any member. No payload — it acts on the room's ready items.
	 */
	export type PushAll = KIND<"cadence:push-all">;

	/** Read the current list (also sent on join). */
	export type List = KIND<"cadence:list">;

	/** The whole list — broadcast to the room on any change and on join. */
	export type Items = KIND<"cadence:items"> & { items: Update[] };

	/** One item changed (e.g. a push result) — broadcast to the room. */
	export type Item = KIND<"cadence:item"> & { item: Update };

	/** Summary of a push-all, replied to the requester once the batch is done. */
	export type PushAllResult = KIND<"cadence:push-all-result"> & { pushed: number; failed: number };
}

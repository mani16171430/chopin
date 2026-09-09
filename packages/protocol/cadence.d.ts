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
		| Request<Field>
		| Request<Push>
		| Request<List>;

	export type Outgoing = Items | Item;

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

	/** Save a member's edits to one item's fields; the item becomes ready. Any member. */
	export type Field = KIND<"cadence:field"> & {
		id: string;
		team?: string;
		title?: string;
		fields?: Record<string, unknown>;
	};

	/** Create or update one ready item in Cadence, under the caller's credential. Any member. */
	export type Push = KIND<"cadence:push"> & { id: string };

	/** Read the current list (also sent on join). */
	export type List = KIND<"cadence:list">;

	/** The whole list — broadcast to the room on any change and on join. */
	export type Items = KIND<"cadence:items"> & { items: Update[] };

	/** One item changed (e.g. a push result) — broadcast to the room. */
	export type Item = KIND<"cadence:item"> & { item: Update };
}

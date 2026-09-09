import type { Frame, Request } from "./index";

type KIND<K extends string> = Frame & { kind: K };

/**
 * Chat drives the agent.
 *
 * Shared, like everything else in a room: one transcript, one turn at a time,
 * and anything said while a turn is running joins a queue rather than being
 * refused. The composer stays live even when the plan does not — a turn owns
 * the document, not Chat.
 */
export declare namespace Chat {
	export type Incoming =
		| Request<Send>
		| Request<Abort>
		| Request<Unqueue>
		| Request<SessionStart>
		| Request<SessionEnd>
		| Request<McpAdd>
		| Request<McpRemove>
		| Request<McpCredential>
		| Request<McpList>;

	export type Outgoing =
		| History
		| Message
		| Delta
		| Tool
		| State
		| Queue
		| Sent
		| Session
		| Mcps
		| McpAck
		| McpCredentialAck;

	/** Who said something. The agent is not a member, so it is named apart. */
	export type Author =
		| { kind: "member"; handle: string }
		| { kind: "agent" }
		| { kind: "system" };

	export type ToolStatus = "running" | "done" | "failed";

	export type ReferenceRequest =
		| { kind: "document"; channelId: string; start: number; end: number }
		| { kind: "research"; workspaceId: string; start: number; end: number };

	type ReferenceBase = {
		id: string;
		start: number;
		end: number;
		label: string;
		href: string;
		repositoryId: string;
		observedRevision: number;
	};

	export type DocumentReference = ReferenceBase & {
		kind: "document";
		channelId: string;
		observedSourceHash: string;
	};

	export type ResearchReference = ReferenceBase & {
		kind: "research";
		parentChannelId: string;
		workspaceId: string;
	};

	export type Reference = DocumentReference | ResearchReference;

	/** One tool call, as it appears beneath the message that made it. */
	export type Activity = {
		id: string;
		name: string;
		status: ToolStatus;
		/** Rendered on demand; the arguments the model supplied. */
		args?: string;
		/** Present once finished. */
		result?: string;
		/** Milliseconds, once finished. */
		took?: number;
	};

	export type Entry = {
		id: string;
		author: Author;
		text: string;
		ts: number;
		/** True while the agent is still writing this one. */
		streaming?: boolean;
		tools?: Activity[];
		references?: Reference[];
	};

	/** Transient Planner turn state. */
	export type Turn = {
		id: string;
		handle: string;
		started: number;
		/** True after the Planner has sent non-empty prose. */
		responded: boolean;
	};

	/** Everything said so far, sent on join. */
	export type History = KIND<"chat:history"> & {
		entries: Entry[];
		busy: boolean;
		turn?: Turn;
		queued: Waiting[];
	};

	/** A new entry, or a finished one replacing its streaming self. */
	export type Message = KIND<"chat:message"> & { entry: Entry };

	/** Text appended to an entry still being written. */
	export type Delta = KIND<"chat:delta"> & { id: string; text: string };

	/** A tool call starting, or finishing. */
	export type Tool = KIND<"chat:tool"> & { entry: string; activity: Activity };

	/** Whether a turn is running, and for whom. */
	export type State = KIND<"chat:state"> & {
		busy: boolean;
		turn?: Turn;
	};

	/** A message waiting for the current turn to end. */
	export type Waiting = {
		id: string;
		handle: string;
		text: string;
		references?: Reference[];
	};

	export type Queue = KIND<"chat:queue"> & { waiting: Waiting[] };
	export type Destination = "room" | "planner";

	/**
	 * Say something.
	 *
	 * Accepted whether or not a turn is running. If one is, this joins the
	 * queue and runs in order when the turn ends — nobody is made to wait in
	 * silence because somebody else prompted first.
	 */
	export type Send = KIND<"chat:send"> & {
		requestId: string;
		text: string;
		to: Destination;
		references?: ReferenceRequest[];
	};

	/** The member message or queue entry is accepted by the server. */
	export type Sent = KIND<"chat:send"> & { id: string; queued: boolean };

	/** Stop the running turn. Anyone may; the transcript records who did. */
	export type Abort = KIND<"chat:abort">;

	/** Withdraw a queued message. Only its author may. */
	export type Unqueue = KIND<"chat:unqueue"> & { id: string };

	/**
	 * Turn the room's shared Planner session on.
	 *
	 * While it is on, every member's message is treated as addressed to the
	 * Planner — no per-message `@chopin` needed — so the room can jam with the
	 * model together. Shared and visible to the whole room. Ephemeral: resets
	 * on a server restart or when the room is evicted.
	 */
	export type SessionStart = KIND<"chat:session-start">;

	/** Turn the room's shared Planner session off. */
	export type SessionEnd = KIND<"chat:session-end">;

	/**
	 * The room's session state — broadcast to the whole room on a toggle and
	 * told to a socket that has just joined, so every open tab reflects it.
	 */
	export type Session = KIND<"chat:session"> & {
		active: boolean;
		/** The handle of whoever last toggled it, if known. */
		by?: string;
	};

	/**
	 * One MCP server registered on this chat.
	 *
	 * Definitions are shared by the channel; each member's credential for one is
	 * held separately and never returned here.
	 */
	export type Mcp = {
		name: string;
		url: string;
		added_by: string;
		added_at: number;
		/** True when the requester has stored their own credential for it. */
		has_credential: boolean;
	};

	/** Register an MCP server on this chat. Editors only. */
	export type McpAdd = KIND<"chat:mcp:add"> & {
		name: string;
		url: string;
		/** Optional credential for the caller, sealed server-side before storage. */
		auth?: { kind: "bearer"; token: string } | { kind: "headers"; headers: Record<string, string> };
	};

	/** Remove an MCP server from this chat. Editors only. */
	export type McpRemove = KIND<"chat:mcp:remove"> & { name: string };

	/** Set or clear the caller's own credential for one of the chat's MCPs. */
	export type McpCredential = KIND<"chat:mcp:credential"> & {
		name: string;
		/** Present to set, omitted to clear. */
		auth?: { kind: "bearer"; token: string } | { kind: "headers"; headers: Record<string, string> };
	};

	/** Read this chat's MCP list (redacted) plus which the caller has credentials for. */
	export type McpList = KIND<"chat:mcp:list">;

	/** The chat's MCP list — broadcast to the room on add/remove, told to the requester on list. */
	export type Mcps = KIND<"chat:mcps"> & { servers: Mcp[] };

	/** An MCP was added or removed — answered to the requester. */
	export type McpAck = KIND<"chat:mcp"> & { name: string };

	/** A member's credential was set or cleared — answered to that member only. */
	export type McpCredentialAck = KIND<"chat:mcp:credential"> & {
		name: string;
		has_credential: boolean;
	};
}

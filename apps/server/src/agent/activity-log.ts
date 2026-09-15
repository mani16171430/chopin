/**
 * The planner's activity log: one JSON line per LLM call and tool call.
 *
 * A turn is otherwise invisible until it replies — when a model stream drops or
 * a tool hangs, the room sees a bare "the agent stopped" and the log has
 * nothing. This writes the whole turn as it happens: each model request and
 * response, each tool start and completion, each gate denial, and the session's
 * end, so a failed turn is fully traceable after the fact.
 *
 * Summarized by contract, never verbatim. Tool arguments and assistant prose
 * can carry document content, Clash answers, and reference ids, so only their
 * shape is recorded — byte sizes and argument *keys*, never values — and no
 * token, credential, or message body is ever written. What the planner decided
 * is recoverable from the room transcript; what it *did* (which tools, which
 * model, how long, what failed) is what this log is for.
 *
 * One file per session, `planner-<sessionId>.log`, so a single turn reads
 * contiguously and concurrent rooms never interleave on one line.
 */

import { appendFile, mkdir } from "node:fs/promises";

/** The event discriminator. */
export type ActivityKind =
	| "llm.request"
	| "llm.response"
	| "tool.start"
	| "tool.complete"
	| "permission.denied"
	| "assistant.message"
	| "session.error"
	| "session.idle";

/** One recorded event. `kind` discriminates; the rest are per-kind metadata. */
export type ActivityEntry = Record<string, unknown> & {
	/** ISO timestamp. */
	at: string;
	/** Monotonic within the session, so out-of-order delivery is detectable. */
	seq: number;
	kind: ActivityKind;
};

/** What a caller supplies: the event minus the timestamp and sequence the log adds. */
export type ActivityInput = Record<string, unknown> & { kind: ActivityKind };

/** A session-bound activity sink. `record` never throws into the agent loop. */
export type ActivityLog = {
	record: (entry: ActivityInput) => void;
};

/** Resolved lazily so tests can point PLANNER_LOG_DIR at a scratch dir. */
function logFile(sessionId: string): { dir: string; path: string } {
	let dir = process.env.PLANNER_LOG_DIR || "logs";
	return { dir, path: `${dir}/planner-${sessionId}.log` };
}

/**
 * A logger that drops every event. The default, so the agent loop pays nothing
 * (and tests change nothing) when no sink is wired.
 */
export function silentLog(): ActivityLog {
	return { record: () => {} };
}

/**
 * A logger appending one JSON line per event to the session's file. Writes are
 * serialized through a promise chain so concurrent emits from one session never
 * interleave a line; a failed write is swallowed — logging must never take down
 * the turn it is describing.
 */
export function activityLog(sessionId: string): ActivityLog {
	let seq = 0;
	let chain: Promise<void> = Promise.resolve();
	return {
		record(partial) {
			let entry: ActivityEntry = {
				...partial,
				at: new Date().toISOString(),
				seq: seq++,
				kind: partial.kind,
			};
			chain = chain.then(async () => {
				let { dir, path } = logFile(sessionId);
				await mkdir(dir, { recursive: true });
				await appendFile(path, JSON.stringify(entry) + "\n");
			}).catch(() => {});
		},
	};
}

/** Byte size of a value's JSON form, or 0 when it does not serialize. */
export function byteSize(value: unknown): number {
	try {
		let text = JSON.stringify(value);
		return text === undefined ? 0 : Buffer.byteLength(text);
	} catch {
		return 0;
	}
}

/** Top-level keys of an argument object — the shape of a call, not its content. */
export function argKeys(args: unknown): string[] {
	if (!args || typeof args !== "object" || Array.isArray(args)) return [];
	return Object.keys(args as Record<string, unknown>);
}

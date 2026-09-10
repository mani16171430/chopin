/**
 * Calling Clash, this deployment's agent on the Razorpay Agent Platform
 * ("slash").
 *
 * The platform is SSO-authenticated for browsers, but this is a
 * server-to-server caller: it authenticates with a service-account API key
 * (`ak_live_…`) presented as a bearer token, exactly the credential shape
 * `extract_credential` on the platform accepts. The key is a secret — it is
 * never logged, never interpolated into an error message, and never leaves
 * this process.
 *
 * The surface is deliberately two endpoints: create a run, then poll it until
 * the turn is terminal and read `result_text` off it. The turn-events
 * endpoint is wired for correctness (cursor-paginated, preview-only items)
 * but the PoC never calls it — the turn resource already carries the answer.
 * Streaming Clash's progress into the room is a later enhancement, and the
 * client shape below is what it will build on.
 */

import type { ClashConfig } from "../config";

/** Terminal turn statuses; anything else keeps polling. */
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
/**
 * The platform asks its caller for input; a tool call cannot answer, so this
 * ends the wait the way a timeout does rather than hanging the room.
 */
const STUCK = new Set(["waiting_for_input"]);

/** PoC cadence. Production is the prior repo's 15s→60s age-based backoff. */
const POLL_INTERVAL_MS = 2_000;
/** A long turn is normal; the room watches the tool run while it works. */
const POLL_TIMEOUT_MS = 1_800_000;
const REQUEST_TIMEOUT_MS = 30_000;

export type RunRef = { runId: string; turnId: string };

type Turn = {
	id: string;
	status: string;
	result_text?: string | null;
	error_message?: string | null;
	error_reason?: string | null;
};

type Run = {
	id: string;
	current_turn: Turn | null;
};

export type TurnEventItem = {
	sequence: number;
	kind: string;
	is_error: boolean;
	summary: string;
	preview: string;
	truncated: boolean;
};

export type TurnEventsPage = {
	items: TurnEventItem[];
	next_cursor: string;
	has_more: boolean;
};

export class ClashError extends Error {
	override readonly name = "ClashError";
}

/** What the fetch layer returns; status drives the caller's branching. */
type Reply = { status: number; body: unknown };

/** The injected transport, so tests never touch the network. */
export type Fetcher = (url: string, init: RequestInit) => Promise<Reply>;

async function realFetch(url: string, init: RequestInit): Promise<Reply> {
	let response = await fetch(url, {
		...init,
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	let body: unknown = await response.json().catch(() => undefined);
	return { status: response.status, body };
}

/**
 * One HTTP call against the platform.
 *
 * The bearer token is attached here and here only. Errors are raised with the
 * status and the platform's own message field — the key is never in them —
 * and `ClashError` is what callers catch; a raw transport failure is wrapped
 * the same way so no caller has to know which layer failed.
 */
async function call(
	config: ClashConfig,
	method: string,
	path: string,
	body?: unknown,
	fetcher: Fetcher = realFetch,
): Promise<unknown> {
	let reply: Reply;
	try {
		reply = await fetcher(`${config.baseUrl}${path}`, {
			method,
			headers: {
				"Authorization": `Bearer ${config.apiKey}`,
				...(body !== undefined ? { "Content-Type": "application/json" } : {}),
			},
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		});
	} catch (err) {
		throw new ClashError(
			`the agent platform could not be reached (${
				err instanceof Error ? err.message : "network error"
			})`,
		);
	}
	if (reply.status === 401 || reply.status === 403) {
		throw new ClashError("the agent platform rejected this deployment's credentials");
	}
	if (reply.status < 200 || reply.status >= 300) {
		let detail = (reply.body as { message?: string } | undefined)?.message;
		throw new ClashError(
			`the agent platform answered ${reply.status}${detail ? `: ${detail}` : ""}`,
		);
	}
	return reply.body;
}

/** Fire a one-shot run at the configured agent. */
export async function createRun(
	config: ClashConfig,
	question: string,
	fetcher?: Fetcher,
): Promise<RunRef> {
	let run = (await call(config, "POST", "/v2/runs", {
		agent_name: config.agentName,
		prompt: question,
	}, fetcher)) as Run;
	let turn = run.current_turn;
	if (!run.id || !turn?.id) {
		throw new ClashError("the agent platform returned a run without a turn");
	}
	return { runId: run.id, turnId: turn.id };
}

/** Read a run back; the turn's status and result live on it. */
export async function getRun(config: ClashConfig, runId: string, fetcher?: Fetcher): Promise<Run> {
	return (await call(
		config,
		"GET",
		`/v2/runs/${encodeURIComponent(runId)}`,
		undefined,
		fetcher,
	)) as Run;
}

/**
 * Cancel a run, best-effort.
 *
 * Called when we stop waiting — on timeout or a stuck turn — so the platform
 * does not keep spending on an answer nobody is reading. Failures are
 * swallowed: the caller is already returning a message, and a failed cancel
 * changes nothing about it.
 */
export async function cancelRun(
	config: ClashConfig,
	runId: string,
	fetcher?: Fetcher,
): Promise<void> {
	await call(config, "POST", `/v2/runs/${encodeURIComponent(runId)}/cancel`, undefined, fetcher)
		.catch(() => {});
}

/**
 * One page of a turn's events, for callers that want progress rather than
 * just the answer.
 *
 * `after` is the previous page's `next_cursor` (the platform's default is
 * `"0:0"` for the first page). Items are previews — the platform does not
 * ship full event content in list responses — and `result_text` on the turn
 * is the answer, so the PoC's tool path never calls this. It exists, typed
 * and tested, for the phase that streams Clash's activity into the room.
 */
export async function getTurnEvents(
	config: ClashConfig,
	ref: RunRef,
	after: string,
	kinds: string[],
	fetcher?: Fetcher,
): Promise<TurnEventsPage> {
	let query = new URLSearchParams({ after });
	for (let kind of kinds) query.append("kind", kind);
	let path = `/v2/runs/${encodeURIComponent(ref.runId)}/turns/${
		encodeURIComponent(ref.turnId)
	}/events?${query}`;
	return (await call(config, "GET", path, undefined, fetcher)) as TurnEventsPage;
}

/**
 * The `ask_clash` tool's handler body: run the question and wait.
 *
 * The wait is bounded; a turn that outlives the cap is cancelled and reported
 * as still-working so the planner can ask again rather than leaving a run
 * going. A stuck turn (the platform wants input a tool call cannot give) ends
 * the same way. The answer goes back as the tool result string; the room
 * already sees the tool's start and completion around it.
 */
export async function askClash(
	config: ClashConfig,
	question: string,
	fetcher?: Fetcher,
	/** Test seam: the cadence is production's unless a caller says otherwise. */
	cadence: { intervalMs: number; timeoutMs: number } = {
		intervalMs: POLL_INTERVAL_MS,
		timeoutMs: POLL_TIMEOUT_MS,
	},
): Promise<string> {
	let ref = await createRun(config, question, fetcher);
	let deadline = Date.now() + cadence.timeoutMs;

	for (;;) {
		await Bun.sleep(cadence.intervalMs);
		let run = await getRun(config, ref.runId, fetcher);
		let turn = run.current_turn;
		let status = turn?.status ?? "";

		if (TERMINAL.has(status)) {
			if (status === "completed" && turn?.result_text) return turn.result_text;
			if (status === "failed") {
				let reason = turn?.error_message || turn?.error_reason || "no reason given";
				return `Error: the agent run failed: ${reason}`;
			}
			if (status === "completed") return "Error: the agent finished without an answer.";
			return `Error: the agent run was ${status}.`;
		}

		if (STUCK.has(status)) {
			await cancelRun(config, ref.runId, fetcher);
			return "Error: the agent is waiting for input this chat cannot give it; the run was cancelled.";
		}

		// An unrecognized status is a newer platform, not an answer — keep
		// waiting until the cap rather than guessing terminal.
		if (Date.now() >= deadline) {
			await cancelRun(config, ref.runId, fetcher);
			return "Error: the agent is still working after thirty minutes; the run was cancelled. Ask again in a moment.";
		}
	}
}

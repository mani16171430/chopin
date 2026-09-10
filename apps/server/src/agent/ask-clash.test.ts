import { expect, test } from "bun:test";

import { askClash, ClashError, getTurnEvents } from "./ask-clash";

import type { Fetcher } from "./ask-clash";
import type { ClashConfig } from "../config";

const CONFIG: ClashConfig = {
	baseUrl: "https://platform.example",
	apiKey: "ak_live_test_key",
	agentName: "clash",
};

/**
 * The tests run the poll loop at full tilt. The production 2s cadence is not
 * what is under test, and waiting it out keeps this file alive long enough to
 * catch a stray timer from a slower suite running alongside it.
 */
const FAST = { intervalMs: 1, timeoutMs: 2_000 };

/**
 * A stubbed transport. Each entry is one reply, in call order; the script
 * records what it was asked so a test can assert the request shape without
 * ever touching the network.
 */
function scripted(replies: { status: number; body: unknown }[]) {
	let calls: { url: string; method: string; body?: unknown; authorization?: string }[] = [];
	let fetcher: Fetcher = async (url, init) => {
		let reply = replies.shift();
		if (!reply) throw new Error(`script ran out at ${url}`);
		calls.push({
			url,
			method: init.method ?? "GET",
			...(init.body ? { body: JSON.parse(init.body as string) } : {}),
			authorization: (init.headers as Record<string, string>)?.Authorization,
		});
		return reply;
	};
	return { calls, fetcher };
}

function running(status = "active") {
	return {
		status: 200,
		body: { id: "run-1", current_turn: { id: "turn-1", status } },
	};
}

test("create → poll → completed returns result_text, with the bearer key on the wire", async () => {
	let { calls, fetcher } = scripted([
		{ status: 201, body: { id: "run-1", current_turn: { id: "turn-1", status: "pending" } } },
		running(),
		{
			status: 200,
			body: {
				id: "run-1",
				current_turn: { id: "turn-1", status: "completed", result_text: "the answer" },
			},
		},
	]);

	let result = await askClash(CONFIG, "why is pg-router erroring", fetcher, FAST);

	expect(result).toBe("the answer");
	expect(calls[0]).toMatchObject({
		url: "https://platform.example/v2/runs",
		method: "POST",
		body: { agent_name: "clash", prompt: "why is pg-router erroring" },
		authorization: "Bearer ak_live_test_key",
	});
	expect(calls[1].url).toBe("https://platform.example/v2/runs/run-1");
});

test("a failed turn surfaces the platform's reason, never the key", async () => {
	let { fetcher } = scripted([
		{ status: 201, body: { id: "run-1", current_turn: { id: "turn-1", status: "pending" } } },
		{
			status: 200,
			body: {
				id: "run-1",
				current_turn: { id: "turn-1", status: "failed", error_message: "sandbox exploded" },
			},
		},
	]);

	let result = await askClash(CONFIG, "q", fetcher, FAST);

	expect(result).toContain("sandbox exploded");
	expect(result).not.toContain("ak_live");
});

test("waiting_for_input cancels and explains", async () => {
	let { calls, fetcher } = scripted([
		{ status: 201, body: { id: "run-1", current_turn: { id: "turn-1", status: "pending" } } },
		running("waiting_for_input"),
		{ status: 200, body: { id: "run-1", current_turn: { id: "turn-1", status: "cancelled" } } },
	]);

	let result = await askClash(CONFIG, "q", fetcher, FAST);

	expect(result).toContain("waiting for input");
	expect(calls.at(-1)?.url).toBe("https://platform.example/v2/runs/run-1/cancel");
});

test("an unknown status is not terminal — the run keeps polling", async () => {
	let { fetcher } = scripted([
		{ status: 201, body: { id: "run-1", current_turn: { id: "turn-1", status: "pending" } } },
		running("teleporting"), // a status from the future
		{
			status: 200,
			body: { id: "run-1", current_turn: { id: "turn-1", status: "completed", result_text: "ok" } },
		},
	]);

	expect(await askClash(CONFIG, "q", fetcher, FAST)).toBe("ok");
});

test("a rejected credential is a ClashError that carries no key material", async () => {
	let { fetcher } = scripted([{ status: 401, body: { message: "unauthenticated" } }]);

	let error = await askClash(CONFIG, "q", fetcher, FAST).catch(err => err);

	expect(error).toBeInstanceOf(ClashError);
	expect(error.message).toContain("credentials");
	expect(error.message).not.toContain("ak_live");
});

test("a platform 5xx reports the status and the platform's message", async () => {
	let { fetcher } = scripted([{ status: 503, body: { message: "harness unavailable" } }]);

	let error = await askClash(CONFIG, "q", fetcher, FAST).catch(err => err);

	expect(error).toBeInstanceOf(ClashError);
	expect(error.message).toContain("503");
	expect(error.message).toContain("harness unavailable");
});

test("a run with no turn is a client-visible error, not a crash", async () => {
	let { fetcher } = scripted([{ status: 201, body: { id: "run-1", current_turn: null } }]);

	let error = await askClash(CONFIG, "q", fetcher, FAST).catch(err => err);
	expect(error).toBeInstanceOf(ClashError);
});

test("turn events thread the cursor and kind filter", async () => {
	let { calls, fetcher } = scripted([
		{
			status: 200,
			body: {
				items: [{
					sequence: 7,
					kind: "result",
					is_error: false,
					summary: "s",
					preview: "p",
					truncated: false,
				}],
				next_cursor: "7:0",
				has_more: false,
			},
		},
	]);

	let page = await getTurnEvents(CONFIG, { runId: "run-1", turnId: "turn-1" }, "0:0", [
		"result",
		"error",
	], fetcher);

	expect(page.next_cursor).toBe("7:0");
	expect(page.items[0].kind).toBe("result");
	expect(calls[0].url).toBe(
		"https://platform.example/v2/runs/run-1/turns/turn-1/events?after=0%3A0&kind=result&kind=error",
	);
});

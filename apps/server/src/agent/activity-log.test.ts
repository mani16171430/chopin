import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { activityLog, argKeys, byteSize } from "./activity-log";
import { Runtime } from "./runtime";

import type { RuntimeClient, SessionConfig } from "./runtime";
import type { Tool } from "./types";

/**
 * The log is the only place a dropped model stream or a hung tool leaves a
 * trace, so these tests pin both its content (every LLM call and tool call,
 * in order) and its contract (shapes and sizes, never argument values or
 * message bodies).
 */

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "planner-log-"));
	process.env.PLANNER_LOG_DIR = dir;
});

afterEach(() => {
	delete process.env.PLANNER_LOG_DIR;
	rmSync(dir, { recursive: true, force: true });
});

function read(logId: string): Record<string, unknown>[] {
	// The log file name embeds the id passed to activityLog().
	let path = join(dir, `planner-${logId}.log`);
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as Record<string, unknown>);
}

function textTool(name: string, output: string): Tool {
	return {
		name,
		description: name,
		parameters: { type: "object", properties: {}, additionalProperties: false },
		skipPermission: true,
		handler: async () => output,
	};
}

/** A stub stream that yields one assistant text message and stops. */
function textAnswer(text: string): RuntimeClient {
	return {
		messages: {
			stream: () => {
				let listeners: ((delta: string) => void)[] = [];
				return {
					on(_kind: "text", listener: (delta: string) => void) {
						listeners.push(listener);
					},
					async finalMessage() {
						for (let listener of listeners) listener(text);
						return {
							model: "model-x",
							stop_reason: "end_turn",
							content: [{ type: "text", text }],
							usage: { input_tokens: 12, output_tokens: 4 },
						};
					},
					abort() {},
				};
			},
		} as unknown as RuntimeClient["messages"],
	};
}

/** Attach before `send` so the turn's events can't fire before we're listening. */
function whenIdle(session: { on: (l: (e: { type: string }) => void) => void }): Promise<void> {
	return new Promise<void>(resolve => {
		session.on(event => {
			if (event.type === "session.idle" || event.type === "session.error") resolve();
		});
	});
}

test("byteSize and argKeys describe a call without its content", () => {
	expect(byteSize("hello")).toBe(7); // JSON-quoted
	expect(byteSize({ a: 1 })).toBe(7); // {"a":1}
	expect(byteSize(undefined)).toBe(0);
	expect(byteSize({ big: "x".repeat(100) })).toBeGreaterThan(100);
	expect(argKeys({ question: "secret", revision: 3 })).toEqual(["question", "revision"]);
	expect(argKeys("not an object")).toEqual([]);
	expect(argKeys(null)).toEqual([]);
});

test("a plain turn logs request, response, message and idle with sizes, not content", async () => {
	let runtime = new Runtime(() => ({ client: textAnswer("the answer body"), cleanup: () => {} }));
	let config: SessionConfig = {
		model: "model",
		system: "system",
		tools: [],
		gate: async () => ({ allowed: true }),
	};
	let session = await runtime.open({ ...config, log: activityLog("turn-plain") });
	let done = whenIdle(session);
	await session.send({ prompt: "hello" });
	await done;
	// Give the serialized write chain a tick to flush.
	await new Promise(resolve => setTimeout(resolve, 20));

	let entries = read("turn-plain");
	let kinds = entries.map(entry => entry.kind);
	expect(kinds).toEqual(["llm.request", "llm.response", "assistant.message", "session.idle"]);

	let request = entries[0];
	expect(request.model).toBe("model");
	expect(request).not.toHaveProperty("prompt");
	expect(request).not.toHaveProperty("system");

	let response = entries[1];
	expect(response.stopReason).toBe("end_turn");
	expect(response.inputTokens).toBe(12);
	expect(response.outputTokens).toBe(4);
	expect(typeof response.durationMs).toBe("number");

	let message = entries[2];
	expect(message.contentBytes).toBe(byteSize("the answer body"));
	// The body itself must never be written.
	expect(JSON.stringify(entries)).not.toContain("the answer body");

	// Sequence numbers are monotonic and timestamps present.
	expect(entries.map(entry => entry.seq)).toEqual([0, 1, 2, 3]);
	for (let entry of entries) expect(typeof entry.at).toBe("string");
});

/** A stream whose model calls one tool, then answers with text on the next pass. */
function toolThenAnswer(): RuntimeClient {
	let calls = 0;
	return {
		messages: {
			stream: () => {
				calls++;
				let first = calls === 1;
				return {
					on() {},
					async finalMessage() {
						return first
							? {
								model: "model-x",
								stop_reason: "tool_use",
								content: [{
									type: "tool_use",
									id: "call-1",
									name: "read_plan",
									input: { revision: 3, note: "do not log this" },
								}],
								usage: { input_tokens: 20, output_tokens: 6 },
							}
							: {
								model: "model-x",
								stop_reason: "end_turn",
								content: [{ type: "text", text: "done" }],
								usage: { input_tokens: 30, output_tokens: 2 },
							};
					},
					abort() {},
				};
			},
		} as unknown as RuntimeClient["messages"],
	};
}

test("a tool call logs start and complete with arg shape, never arg values", async () => {
	let runtime = new Runtime(() => ({ client: toolThenAnswer(), cleanup: () => {} }));
	let session = await runtime.open({
		model: "model",
		system: "system",
		tools: [textTool("read_plan", "plan body that must not be logged")],
		gate: async () => ({ allowed: true }),
		log: activityLog("turn-tool"),
	});
	let done = whenIdle(session);
	await session.send({ prompt: "go" });
	await done;
	await new Promise(resolve => setTimeout(resolve, 20));

	let entries = read("turn-tool");
	let start = entries.find(entry => entry.kind === "tool.start");
	let complete = entries.find(entry => entry.kind === "tool.complete");
	expect(start?.tool).toBe("read_plan");
	expect(start?.callId).toBe("call-1");
	expect(start?.argKeys).toEqual(["revision", "note"]);
	expect(typeof start?.argBytes).toBe("number");
	expect(complete?.success).toBe(true);
	expect(complete?.resultBytes).toBe(byteSize("plan body that must not be logged"));

	// Neither the tool's argument value nor its result body may appear.
	let raw = JSON.stringify(entries);
	expect(raw).not.toContain("do not log this");
	expect(raw).not.toContain("plan body that must not be logged");
});

test("a dropped model stream logs session.error", async () => {
	let failing: RuntimeClient = {
		messages: {
			stream: () => ({
				on() {},
				async finalMessage() {
					throw new Error("The socket connection was closed unexpectedly");
				},
				abort() {},
			}),
		} as unknown as RuntimeClient["messages"],
	};
	let runtime = new Runtime(() => ({ client: failing, cleanup: () => {} }));
	let session = await runtime.open({
		model: "model",
		system: "system",
		tools: [],
		gate: async () => ({ allowed: true }),
		log: activityLog("turn-error"),
	});
	let done = whenIdle(session);
	await session.send({ prompt: "go" });
	await done;
	await new Promise(resolve => setTimeout(resolve, 20));

	let entries = read("turn-error");
	let error = entries.find(entry => entry.kind === "session.error");
	expect(error?.errorType).toBe("unexpected");
	expect(String(error?.message)).toContain("socket connection was closed");
});

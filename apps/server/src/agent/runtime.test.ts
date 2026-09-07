import { describe, expect, it } from "bun:test";

import { Runtime } from "./runtime";

import type { RuntimeClient, SessionConfig } from "./runtime";

/**
 * The Copilot-era `Runtime` managed a CLI subprocess: coalescing concurrent
 * opens into one `start()`, tracking "generations" so a failed startup could
 * be retried, and force-stopping a hung process on shutdown. None of that
 * exists anymore — there is no subprocess, so `open()` just lazily
 * constructs the Anthropic client once and hands back a session immediately.
 * This suite tests that much smaller surface instead.
 */

function config(): SessionConfig {
	return {
		model: "model",
		system: "system",
		tools: [],
		gate: async () => ({ allowed: true }),
	};
}

function stubClient(): RuntimeClient {
	return {
		messages: {
			// Not exercised by Runtime/open() itself — only a session's own
			// `send()` calls this, which these tests never trigger.
			stream: () => {
				throw new Error("not used in this test");
			},
		} as unknown as RuntimeClient["messages"],
	};
}

describe("agent runtime", () => {
	it("creates the client once for concurrent opens", async () => {
		let created = 0;
		let runtime = new Runtime(() => {
			created++;
			return { client: stubClient(), cleanup: () => {} };
		});

		let [first, second] = await Promise.all([runtime.open(config()), runtime.open(config())]);
		expect(created).toBe(1);
		expect(first.sessionId).not.toBe(second.sessionId);
	});

	it("discards a known session and reports unknown ones", async () => {
		let runtime = new Runtime(() => ({ client: stubClient(), cleanup: () => {} }));
		let session = await runtime.open(config());

		expect(await runtime.discard(session)).toBe(true);
		expect(await runtime.discard(session)).toBe(false);
	});

	it("disconnects every open session and runs cleanup on shutdown", async () => {
		let cleaned = false;
		let runtime = new Runtime(() => ({
			client: stubClient(),
			cleanup: () => {
				cleaned = true;
			},
		}));
		let first = await runtime.open(config());
		let second = await runtime.open(config());

		await runtime.shutdown();
		expect(cleaned).toBe(true);
		// A disconnected session is inert; discarding it again is a no-op false.
		expect(await runtime.discard(first)).toBe(false);
		expect(await runtime.discard(second)).toBe(false);
	});

	it("rejects new opens once shutdown begins", async () => {
		let runtime = new Runtime(() => ({ client: stubClient(), cleanup: () => {} }));
		await runtime.open(config());
		await runtime.shutdown();

		await expect(runtime.open(config())).rejects.toThrow("shutting down");
	});

	it("does not construct a client until the first open", async () => {
		let created = 0;
		let runtime = new Runtime(() => {
			created++;
			return { client: stubClient(), cleanup: () => {} };
		});
		expect(created).toBe(0);
		await runtime.open(config());
		expect(created).toBe(1);
	});
});

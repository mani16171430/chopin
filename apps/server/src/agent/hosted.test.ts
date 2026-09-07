import { describe, expect, it } from "bun:test";

import {
	openWorker,
	plannerConfiguration,
	publicResearchConfiguration,
	workerConfiguration,
} from "./client";
import { gate, publicResearchGate, terminalGate } from "./permissions";
import { repositoryTools } from "./repository";

import type { Tool } from "./types";

/**
 * The Copilot-era suite tested SDK-shaped `SessionConfig` fields
 * (`gitHubToken`, `mcpServers`, `customAgents`, `availableTools`, …) and two
 * MCP tool-list audit functions (`assertWorkerTools`,
 * `auditPublicResearchTools`) that no longer exist — there is no separate
 * "session negotiates its tool list" step anymore; the tools a session gets
 * are exactly the `Tool[]` handed to `plannerConfiguration`/
 * `workerConfiguration`/`publicResearchConfiguration`, deterministically.
 * This rewrite tests what those functions actually build now.
 */

function tool(name: string): Tool {
	return { name, description: name, parameters: { type: "object" }, handler: async () => "ok" };
}

describe("hosted agent configuration", () => {
	it("scopes the planner's prompt and tools to one repository", async () => {
		let readPlan = tool("read_plan");
		let config = plannerConfiguration(
			{ model: "model" },
			{ tools: [readPlan] },
			{
				token: "ghu_owner",
				repository: { id: "R_repo", owner: "octo-org", name: "score", defaultBranch: "main" },
			},
		);

		expect(config.model).toBe("model");
		expect(config.system).toContain("octo-org/score");
		expect(config.system).toContain("read_repository_file");
		expect(config.system).toContain("list_pull_requests");
		expect(config.tools).toEqual([readPlan]);

		expect(await config.gate("read_plan", {})).toEqual({ allowed: true });
		expect((await config.gate("edit_plan", {})).allowed).toBe(false);
	});

	it("includes the caller's bootstrap text in the planner's prompt", () => {
		let config = plannerConfiguration(
			{ model: "model" },
			{ tools: [] },
			{
				token: "ghu_owner",
				repository: { id: "R", owner: "o", name: "r", defaultBranch: "main" },
				bootstrap: "Recent conversation: nothing yet.",
			},
		);
		expect(config.system).toContain("Recent conversation: nothing yet.");
	});

	it("gives a worker only its terminal result tool", async () => {
		let result = tool("submit_job_result");
		let options = {
			token: "ghu_owner",
			name: "chopin-document-summary",
			prompt: "Summarize the supplied document and submit one result.",
			result,
			maxAiCredits: 32,
		};
		let config = workerConfiguration({ model: "model" }, options);
		expect(() => workerConfiguration({ model: "model" }, { ...options, maxAiCredits: 29 }))
			.toThrow("at least 30");

		expect(config.model).toBe("model");
		expect(config.system).toBe(options.prompt);
		expect(config.tools).toEqual([result]);
		expect(config.maxTokens).toBeGreaterThan(0);

		expect(await config.gate("submit_job_result", {})).toEqual({ allowed: true });
		expect((await config.gate("read_plan", {})).allowed).toBe(false);
	});

	it("denies every worker tool once its owner is no longer active", async () => {
		let decide = terminalGate("submit_job_result", async () => false);
		expect((await decide("submit_job_result", {})).allowed).toBe(false);
	});

	it("isolates public research: only its result tool is ever allowed", async () => {
		let result = tool("submit_research_result");
		let denied = 0;
		let config = publicResearchConfiguration({ model: "model" }, {
			token: "ghu_owner",
			name: "chopin-public-research",
			prompt: "Research only the disclosed public question.",
			result,
			maxAiCredits: 32,
			onWebSearchDenied: () => denied++,
		});

		// KNOWN GAP: web search has no replacement yet, so it's signalled denied
		// unconditionally at construction — see agent/client.ts.
		expect(denied).toBe(1);
		expect(config.tools).toEqual([result]);

		let decide = publicResearchGate("submit_research_result");
		expect(await decide("submit_research_result", {})).toEqual({ allowed: true });
		expect((await decide("read_plan", {})).allowed).toBe(false);
	});

	it("does not start a worker when the hosted agent is disabled", async () => {
		await expect(openWorker(
			{ agent: false, model: "model" },
			{
				token: "ghu_owner",
				name: "chopin-document-summary",
				prompt: "Summarize the supplied document and submit one result.",
				result: tool("submit_job_result"),
				maxAiCredits: 32,
			},
		)).rejects.toThrow("disabled");
	});

	it("the planner's gate allows only its declared tools, and only while active", async () => {
		let active = true;
		let decide = gate({ tools: new Set(["read_plan", "edit_plan"]), active: async () => active });

		expect(await decide("read_plan", {})).toEqual({ allowed: true });
		expect((await decide("ask", {})).allowed).toBe(false);

		active = false;
		expect((await decide("read_plan", {})).allowed).toBe(false);
	});
});

describe("hosted repository tools", () => {
	it("binds every read to one repository and filters search results", async () => {
		let urls: URL[] = [];
		let tools = repositoryTools({
			token: "ghu_owner",
			repository: { id: "R_repo", owner: "octo-org", name: "score", defaultBranch: "main" },
			fetch: async input => {
				let url = new URL(String(input));
				urls.push(url);
				if (url.pathname.includes("/contents/")) {
					return Response.json({
						type: "file",
						encoding: "base64",
						content: Buffer.from("one\ntwo").toString("base64"),
					});
				}
				if (url.pathname.includes("/git/trees/")) {
					return Response.json({
						tree: [{ path: "src/a.ts", type: "blob", size: 10 }],
						truncated: false,
					});
				}
				if (url.pathname === "/search/code") {
					return Response.json({
						items: [
							{ path: "src/a.ts", html_url: "url", repository: { node_id: "R_repo" } },
							{ path: "secret", repository: { node_id: "R_other" } },
						],
					});
				}
				return Response.json([{
					sha: "abc",
					commit: { message: "change", author: { name: "Mona", date: "today" } },
				}]);
			},
		});
		let call = (name: string, input: unknown) => {
			let tool = tools.find(value => value.name === name)!;
			return tool.handler(input);
		};

		expect(await call("read_repository_file", { path: "src/a.ts" })).toContain("1: one");
		expect(await call("list_repository_tree", {})).toContain("src/a.ts");
		let searched = await call("search_repository", { terms: "symbol" });
		expect(searched).toContain("src/a.ts");
		expect(searched).not.toContain("secret");
		expect(await call("repository_history", {})).toContain("change");
		expect(
			urls.filter(url => url.pathname !== "/search/code").every(url =>
				url.pathname.startsWith("/repos/octo-org/score/")
			),
		).toBe(true);
		expect(urls.find(url => url.pathname === "/search/code")!.searchParams.get("q"))
			.toContain("repo:octo-org/score");
	});

	it("refuses paths that can escape the repository", async () => {
		let tools = repositoryTools({
			token: "token",
			repository: { id: "R", owner: "o", name: "r", defaultBranch: "main" },
			fetch: async () => Response.json({}),
		});
		let read = tools.find(tool => tool.name === "read_repository_file")!;
		let result = await read.handler({ path: "../secret" });
		expect(result).toContain("relative repository path");
	});

	it("resolves authorization again when a repository handler starts", async () => {
		let token: string | undefined = "ghu_current";
		let requests = 0;
		let tools = repositoryTools({
			token: () => token,
			repository: { id: "R", owner: "o", name: "r", defaultBranch: "main" },
			fetch: async (_input, init) => {
				requests++;
				expect(new Headers(init?.headers).get("authorization")).toBe("Bearer ghu_current");
				return Response.json({ tree: [], truncated: false });
			},
		});
		let tree = tools.find(tool => tool.name === "list_repository_tree")!;
		expect(await tree.handler({})).not.toContain("Error:");
		token = undefined;
		expect(await tree.handler({})).toContain("authorization expired");
		expect(requests).toBe(1);
	});

	it("reads pull requests scoped to one repository", async () => {
		let tools = repositoryTools({
			token: "token",
			repository: { id: "R_repo", owner: "octo-org", name: "score", defaultBranch: "main" },
			fetch: async input => {
				let url = new URL(String(input));
				if (url.pathname.endsWith("/pulls/7")) {
					return Response.json({
						number: 7,
						title: "Fix bug",
						state: "open",
						user: { login: "mona" },
						html_url: "https://github.com/octo-org/score/pull/7",
						body: "Fixes the thing.",
						base: { ref: "main" },
						head: { ref: "fix" },
					});
				}
				if (url.pathname.endsWith("/pulls")) {
					return Response.json([
						{ number: 7, title: "Fix bug", state: "open", user: { login: "mona" }, html_url: "u" },
					]);
				}
				if (url.pathname === "/search/issues") {
					return Response.json({
						items: [{
							number: 7,
							title: "Fix bug",
							state: "open",
							user: { login: "mona" },
							html_url: "u",
						}],
					});
				}
				throw new Error(`unexpected request: ${url.pathname}`);
			},
		});
		let call = (name: string, input: unknown) =>
			tools.find(value => value.name === name)!.handler(input);

		expect(await call("list_pull_requests", {})).toContain("Fix bug");
		expect(await call("pull_request_read", { number: 7 })).toContain("Fixes the thing.");
		expect(await call("search_pull_requests", { terms: "bug" })).toContain("Fix bug");
	});
});

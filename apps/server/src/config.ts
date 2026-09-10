/**
 * Configuration, read once at boot.
 *
 * Everything the process needs to know about its environment resolves here so
 * that a misconfiguration is a startup failure with a sentence attached rather
 * than a puzzling behaviour three screens later.
 */

import { loadAuth } from "./auth/config";

import type { AuthConfig } from "./auth/config";
import type { StorageConfig } from "./storage/registry";

export type Config = {
	host: string;
	port: number;
	/** Planner model. */
	model: string;
	/**
	 * Whether to run the agent at all.
	 *
	 * Off is a deliberate choice, not a fallback: the server still refuses to
	 * start with a broken agent, because the failure worth catching is a
	 * misconfigured one. Saying `AGENT=off` is saying you know. Used by tests,
	 * which have no business spawning a language model, and by anyone who
	 * wants the editor on its own.
	 */
	agent: boolean;
	backgroundJobs: boolean;
	webResearch: boolean;
	/**
	 * Origin of a running Vite, when developing.
	 *
	 * Set, and everything that is not the socket is forwarded there; unset, and
	 * the built client is served from disk. This is deliberately explicit rather
	 * than sniffed from the presence of a `dist` directory, which lingers after
	 * a build and would make development quietly serve stale files.
	 */
	devClient: string | undefined;
	/** Durable service storage. */
	storage: StorageConfig;
	/** GitHub identity and short-lived OAuth attempt encryption. */
	auth: AuthConfig;
	/** The Anthropic-Messages-API-compatible gateway the planner calls. */
	litellm: LiteLLMConfig;
	/**
	 * Clash — this deployment's agent on the Razorpay Agent Platform, called
	 * through the planner's `ask_clash` tool.
	 *
	 * Optional by design: a deployment without a platform key is still a
	 * complete chopin, just without the tool. Unlike LiteLLM this must not
	 * fail startup when absent — the tool reports itself unconfigured instead.
	 */
	clash?: ClashConfig;
};

export type LiteLLMConfig = {
	baseUrl: string;
	apiKey: string;
};

export type ClashConfig = {
	baseUrl: string;
	/** Service-account API key (`ak_live_…`). Never logged or returned. */
	apiKey: string;
	/** The platform agent runs are addressed to, by name. */
	agentName: string;
};

const DEFAULT_PORT = 8787;
const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_LITELLM_BASE_URL = "https://llm-gateway.razorpay.com";
const DEFAULT_CLASH_AGENT_NAME = "clash";

function litellm(agent: boolean): LiteLLMConfig {
	let baseUrl = process.env.LITELLM_BASE_URL || DEFAULT_LITELLM_BASE_URL;
	let apiKey = process.env.LITELLM_API_KEY || "";
	if (agent && !apiKey) throw new Error("LITELLM_API_KEY is required when AGENT is on.");
	return { baseUrl, apiKey };
}

/**
 * The Clash integration is opt-in: no key, no `ask_clash` tool.
 *
 * A key without a base URL is a misconfiguration worth a sentence, so that
 * combination does fail startup; the inverse (URL set, key empty) is treated
 * as unset, since the key is the part that costs something to leak into a
 * half-configured deployment.
 */
function clash(): ClashConfig | undefined {
	let apiKey = process.env.AGENT_PLATFORM_KEY || "";
	if (!apiKey) return undefined;
	let baseUrl = process.env.AGENT_PLATFORM_BASE_URL || "";
	if (!baseUrl) {
		throw new Error("AGENT_PLATFORM_BASE_URL is required when AGENT_PLATFORM_KEY is set.");
	}
	return {
		baseUrl: baseUrl.replace(/\/+$/, ""),
		apiKey,
		agentName: process.env.CLASH_AGENT_NAME || DEFAULT_CLASH_AGENT_NAME,
	};
}

function port(): number {
	let raw = process.env.PORT;
	if (!raw) return DEFAULT_PORT;
	let value = Number.parseInt(raw, 10);
	if (!Number.isInteger(value) || value < 1 || value > 65535) {
		throw new Error(`PORT must be a number between 1 and 65535, got ${JSON.stringify(raw)}`);
	}
	return value;
}

function storage(): StorageConfig {
	let driver = process.env.STORAGE_DRIVER || "postgres";
	if (driver !== "postgres") {
		throw new Error(`STORAGE_DRIVER must be "postgres", got ${JSON.stringify(driver)}`);
	}

	let raw = process.env.DATABASE_URL;
	if (!raw) throw new Error("DATABASE_URL is required when STORAGE_DRIVER=postgres");
	try {
		let url = new URL(raw);
		if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error();
	} catch {
		throw new Error("DATABASE_URL must be a PostgreSQL URL");
	}
	return { driver, url: raw };
}

export function load(): Config {
	let agent = process.env.AGENT !== "off";
	let backgroundJobs = process.env.BACKGROUND_JOBS !== "off";
	return {
		host: process.env.SERVER_HOST || "127.0.0.1",
		port: port(),
		model: process.env.MODEL || DEFAULT_MODEL,
		agent,
		backgroundJobs,
		webResearch: agent && backgroundJobs && process.env.WEB_RESEARCH !== "off",
		devClient: process.env.DEV_CLIENT || undefined,
		storage: storage(),
		auth: loadAuth(),
		litellm: litellm(agent),
		clash: clash(),
	};
}

/**
 * What the operator needs to see before deciding to trust this process.
 *
 * The working directory is printed because it is the extent of what an agent
 * can read, and defaulting it to the current directory makes it too easy to
 * start one somewhere you did not intend.
 */
export function describe(config: Config): string {
	let users = config.auth.allowedUsers?.size ?? 0;
	let organizations = config.auth.allowedOrganizations?.size ?? 0;
	let admission = users || organizations
		? `auth: github (restricted: ${users} users, ${organizations} organizations)`
		: "auth: github (unrestricted)";
	let parts = [
		"chopin",
		`http://${config.host}:${config.port}`,
		config.devClient ? `client: vite (${config.devClient})` : "client: built",
		config.agent ? `agent: ${config.model} (on demand)` : "agent: off",
		config.backgroundJobs ? "background jobs: on" : "background jobs: off",
		config.webResearch ? "web research: on" : "web research: off",
		config.clash ? `clash: ${config.clash.agentName}` : "clash: off",
		admission,
		`storage: ${config.storage.driver}`,
	];
	return parts.join("  ·  ");
}

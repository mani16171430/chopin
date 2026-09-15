/**
 * Starting the agent.
 *
 * Disposable Planner and worker sessions share one Anthropic client, pointed
 * at the configured LiteLLM gateway. Unlike the Copilot CLI this replaces,
 * there is no subprocess and no filesystem state to reconstruct on
 * restart — a session is just an in-memory conversation.
 */

import Anthropic from "@anthropic-ai/sdk";

import { activityLog } from "./activity-log";
import { gate, publicResearchGate, terminalGate } from "./permissions";
import { plannerFor, plannerGeneral } from "./planner";
import { Runtime } from "./runtime";

import type { RuntimeSource, SessionConfig } from "./runtime";
import type { Session, Tool } from "./types";
import type { Config, LiteLLMConfig } from "../config";
import type { HostedRepository } from "./repository";

export type Agent = {
	session: Session;
	/** Kept for parity with the runtime this replaces; used only for logging. */
	id: string;
};

/** The tools a planner may call, over and above the runtime's own. */
export type Toolbox = { tools: Tool[] };

export type PlannerSession = {
	token: string;
	/** Null on a general document — a channel with no repository. */
	repository: HostedRepository | null;
	bootstrap?: string;
	authorize?: () => Promise<boolean>;
};

export type WorkerSession = {
	token: string;
	name: string;
	prompt: string;
	result: Tool;
	maxAiCredits: number;
	authorize?: () => Promise<boolean>;
	onWebSearchDenied?: () => void;
};

const MIN_WORKER_AI_CREDITS = 30;
/** Roughly 4 output tokens per credit at current pricing; a generous, not exact, ceiling. */
const TOKENS_PER_AI_CREDIT = 4;

function workerCreditLimit(value: number): number {
	if (!Number.isFinite(value) || value < MIN_WORKER_AI_CREDITS) {
		throw new Error(`Background worker maxAiCredits must be at least ${MIN_WORKER_AI_CREDITS}.`);
	}
	return value;
}

export function plannerConfiguration(
	config: Pick<Config, "model">,
	toolbox: Toolbox,
	options: PlannerSession,
): SessionConfig {
	let tools = toolbox.tools;
	return {
		model: config.model,
		system: [
			options.repository
				? plannerFor(`${options.repository.owner}/${options.repository.name}`)
				: plannerGeneral(),
			"More than one person may be in this conversation; their messages are prefixed with the speaker's handle.",
			options.bootstrap ?? "",
		].filter(Boolean).join(" "),
		tools,
		gate: gate({ tools: new Set(tools.map(tool => tool.name)), active: options.authorize }),
	};
}

export function workerConfiguration(
	config: Pick<Config, "model">,
	options: WorkerSession,
): SessionConfig {
	return {
		model: config.model,
		system: options.prompt,
		tools: [options.result],
		gate: terminalGate(options.result.name, options.authorize),
		maxTokens: workerCreditLimit(options.maxAiCredits) * TOKENS_PER_AI_CREDIT,
	};
}

export function publicResearchConfiguration(
	config: Pick<Config, "model">,
	options: WorkerSession,
): SessionConfig {
	// KNOWN GAP: the Copilot-era worker had web search via a remote MCP tool
	// (`github-mcp-server/web_search`). Anthropic's equivalent is a native,
	// server-executed tool type, which doesn't fit the local `Tool[]`
	// (handler-based) abstraction `SessionConfig.tools` expects today — giving
	// this worker one needs `SessionConfig`/`Runtime` to support a distinct
	// native-tool list first. Tracked in the progress log; not done here.
	options.onWebSearchDenied?.();
	return {
		model: config.model,
		system: options.prompt,
		tools: [options.result],
		gate: publicResearchGate(options.result.name, options.authorize),
		maxTokens: workerCreditLimit(options.maxAiCredits) * TOKENS_PER_AI_CREDIT,
	};
}

function connect(config: LiteLLMConfig): RuntimeSource {
	let client = new Anthropic({
		apiKey: config.apiKey,
		baseURL: config.baseUrl,
		// The gateway's own scheme, alongside the SDK's standard `x-api-key`
		// (sent automatically from `apiKey` above) in case only one is honoured.
		defaultHeaders: { "x-litellm-api-key": `Bearer ${config.apiKey}` },
	});
	return { client, cleanup: () => {} };
}

let runtime = new Runtime(() => connect(currentLiteLLM));

// Set once at startup from `main.ts`; every `open*` call below reads it fresh
// so a credential rotation is picked up by the next session, not baked in.
let currentLiteLLM: LiteLLMConfig;

export function configure(litellm: LiteLLMConfig): void {
	currentLiteLLM = litellm;
}

/** Create a disposable session authenticated and scoped to one owner and repository. */
export async function openPlanner(
	config: Pick<Config, "agent" | "model">,
	toolbox: Toolbox,
	options: PlannerSession,
): Promise<Agent> {
	if (!config.agent) throw new Error("The hosted agent is disabled.");
	let session = await runtime.open({
		...plannerConfiguration(config, toolbox, options),
		log: activityLog(`p${crypto.randomUUID()}`),
	});
	return { session, id: session.sessionId };
}

/** Create a disposable isolated session for one registered background attempt. */
export async function openWorker(
	config: Pick<Config, "agent" | "model">,
	options: WorkerSession,
): Promise<Agent> {
	if (!config.agent) throw new Error("The hosted agent is disabled.");
	let session = await runtime.open(workerConfiguration(config, options));
	return { session, id: session.sessionId };
}

/** Create a public-web worker with no private document or repository capabilities. */
export async function openPublicResearchWorker(
	config: Pick<Config, "agent" | "model">,
	options: WorkerSession,
): Promise<Agent> {
	if (!config.agent) throw new Error("The hosted agent is disabled.");
	let session = await runtime.open(publicResearchConfiguration(config, options));
	return { session, id: session.sessionId };
}

export async function discard(agent: Agent): Promise<void> {
	await runtime.discard(agent.session).catch(() => {});
}

/** Bound an SDK abort so runtime shutdown can still force a wedged session down. */
export async function abort(agent: Agent): Promise<void> {
	agent.session.abort();
}

/** Stop waiting for an opening session, and dispose it if it arrives later. */
export async function settle(opening: Promise<Agent>): Promise<Agent | undefined> {
	return opening.catch(() => undefined);
}

/** Close every remaining session. */
export async function shutdown(): Promise<void> {
	await runtime.shutdown();
}

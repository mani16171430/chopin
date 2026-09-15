/**
 * The agentic loop.
 *
 * Replaces the Copilot SDK's `CopilotClient`/`CopilotSession`. There is no
 * subprocess and no external runtime to start or stop — a "session" here is
 * just an in-memory Anthropic Messages conversation plus a tool-calling
 * loop, run directly against the configured LiteLLM gateway.
 *
 * The external shape (`open`/`discard`/`shutdown`) is kept close to the old
 * `Runtime` class so `agent/client.ts` did not have to change how it is
 * used, only how sessions are built.
 */

import Anthropic from "@anthropic-ai/sdk";

import { argKeys, byteSize, silentLog } from "./activity-log";

import type { ActivityLog } from "./activity-log";
import type { MessageParam, ToolUnion } from "@anthropic-ai/sdk/resources/messages";
import type { Session, SessionEvent, Tool, Unsubscribe } from "./types";

const DEFAULT_MAX_TOKENS = 8_192;
/** Safety bound on tool-call round-trips within one turn; a runaway loop is a bug, not a feature. */
const MAX_TOOL_ITERATIONS = 25;

export type GateResult = { allowed: boolean; feedback?: string };

export type SessionConfig = {
	model: string;
	system: string;
	tools: Tool[];
	/** Re-checked before every tool call that doesn't set `skipPermission`. */
	gate: (toolName: string, args: unknown) => Promise<GateResult>;
	maxTokens?: number;
	/** Activity sink; silent (drops everything) when not supplied. */
	log?: ActivityLog;
};

export type RuntimeClient = {
	messages: Pick<Anthropic["messages"], "stream">;
};

export type RuntimeSource = {
	client: RuntimeClient;
	cleanup: () => void;
};

function toolId(): string {
	return crypto.randomUUID();
}

function toAnthropicTools(tools: Tool[]): ToolUnion[] {
	return tools.map(tool => ({
		name: tool.name,
		description: tool.description,
		input_schema: tool.parameters,
	}));
}

function textOf(content: { type: string; text?: string }[]): string {
	return content.filter(block => block.type === "text" && typeof block.text === "string")
		.map(block => block.text)
		.join("");
}

class LiveSession implements Session {
	readonly sessionId: string;
	#client: RuntimeClient;
	#config: SessionConfig;
	#log: ActivityLog;
	#tools: Map<string, Tool>;
	#anthropicTools: ToolUnion[];
	#messages: MessageParam[] = [];
	#listeners = new Set<(event: SessionEvent) => void>();
	#current?: ReturnType<Anthropic["messages"]["stream"]>;
	#closed = false;

	constructor(client: RuntimeClient, config: SessionConfig) {
		this.sessionId = toolId();
		this.#client = client;
		this.#config = config;
		this.#log = config.log ?? silentLog();
		this.#tools = new Map(config.tools.map(tool => [tool.name, tool]));
		this.#anthropicTools = toAnthropicTools(config.tools);
	}

	on(listener: (event: SessionEvent) => void): Unsubscribe {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async send(input: { prompt: string }): Promise<void> {
		if (this.#closed) throw new Error("session is closed");
		this.#messages.push({ role: "user", content: input.prompt });
		// Accepted, not finished: the loop runs in the background and reports
		// through events, exactly like the SDK session this replaces.
		void this.#run().catch(err => this.#emitError(err));
	}

	abort(): void {
		this.#current?.abort();
	}

	async disconnect(): Promise<void> {
		this.#closed = true;
		this.#current?.abort();
	}

	async #run(): Promise<void> {
		for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
			if (this.#closed) return;
			let messageId = toolId();
			let requested = Date.now();
			this.#log.record({
				kind: "llm.request",
				model: this.#config.model,
				maxTokens: this.#config.maxTokens ?? DEFAULT_MAX_TOKENS,
				messageCount: this.#messages.length,
				toolCount: this.#anthropicTools.length,
				iteration,
			});
			let stream = this.#client.messages.stream({
				model: this.#config.model,
				max_tokens: this.#config.maxTokens ?? DEFAULT_MAX_TOKENS,
				system: this.#config.system,
				messages: this.#messages,
				tools: this.#anthropicTools,
			});
			this.#current = stream;

			stream.on("text", delta => {
				this.#emit({ type: "assistant.message_delta", data: { deltaContent: delta, messageId } });
			});

			let final = await stream.finalMessage();
			this.#current = undefined;

			let calls = final.content.filter(
				(block): block is Extract<typeof block, { type: "tool_use" }> => block.type === "tool_use",
			);
			this.#log.record({
				kind: "llm.response",
				model: final.model,
				stopReason: final.stop_reason,
				inputTokens: final.usage?.input_tokens,
				outputTokens: final.usage?.output_tokens,
				toolCalls: calls.length,
				durationMs: Date.now() - requested,
			});

			let content = textOf(final.content as { type: string; text?: string }[]);
			this.#emit({ type: "assistant.message", data: { content, messageId } });
			this.#log.record({ kind: "assistant.message", messageId, contentBytes: byteSize(content) });
			this.#messages.push({ role: "assistant", content: final.content });

			if (final.stop_reason !== "tool_use") {
				this.#emit({ type: "session.idle", data: {} });
				this.#log.record({ kind: "session.idle", iterations: iteration + 1 });
				return;
			}

			let results: {
				type: "tool_result";
				tool_use_id: string;
				content: string;
				is_error?: boolean;
			}[] = [];
			for (let call of calls) {
				results.push(await this.#execute(call.id, call.name, call.input));
			}
			this.#messages.push({ role: "user", content: results });
		}
		let message = "The planner exceeded its tool-call budget for this turn.";
		this.#log.record({ kind: "session.error", errorType: "runaway", message });
		this.#emit({
			type: "session.error",
			data: { errorType: "runaway", message },
		});
	}

	async #execute(
		callId: string,
		name: string,
		args: unknown,
	): Promise<{ type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }> {
		let tool = this.#tools.get(name);
		if (!tool) {
			return {
				type: "tool_result",
				tool_use_id: callId,
				content: `Error: unknown tool ${name}`,
				is_error: true,
			};
		}

		if (!tool.skipPermission) {
			let decision = await this.#config.gate(name, args);
			if (!decision.allowed) {
				this.#log.record({
					kind: "permission.denied",
					tool: name,
					callId,
					feedback: decision.feedback,
				});
				this.#emit({
					type: "permission.completed",
					data: {
						requestId: callId,
						toolCallId: callId,
						result: { kind: "denied-by-gate", feedback: decision.feedback },
					},
				});
				return {
					type: "tool_result",
					tool_use_id: callId,
					content: decision.feedback ?? "This tool call was not permitted.",
					is_error: true,
				};
			}
		}

		this.#log.record({
			kind: "tool.start",
			tool: name,
			callId,
			argBytes: byteSize(args),
			argKeys: argKeys(args),
		});
		this.#emit({
			type: "tool.execution_start",
			data: { arguments: args as never, toolCallId: callId, toolName: name },
		});
		let started = Date.now();
		try {
			let content = await tool.handler(args);
			this.#log.record({
				kind: "tool.complete",
				tool: name,
				callId,
				success: true,
				resultBytes: byteSize(content),
				durationMs: Date.now() - started,
			});
			this.#emit({
				type: "tool.execution_complete",
				data: { success: true, toolCallId: callId, result: { content } },
			});
			return { type: "tool_result", tool_use_id: callId, content };
		} catch (err) {
			let message = err instanceof Error ? err.message : String(err);
			this.#log.record({
				kind: "tool.complete",
				tool: name,
				callId,
				success: false,
				error: message,
				durationMs: Date.now() - started,
			});
			this.#emit({
				type: "tool.execution_complete",
				data: { success: false, toolCallId: callId, error: message },
			});
			return {
				type: "tool_result",
				tool_use_id: callId,
				content: `Error: ${message}`,
				is_error: true,
			};
		}
	}

	#emit(event: SessionEvent): void {
		for (let listener of this.#listeners) listener(event);
	}

	#emitError(err: unknown): void {
		let message = err instanceof Error ? err.message : String(err);
		this.#log.record({ kind: "session.error", errorType: "unexpected", message });
		this.#emit({ type: "session.error", data: { errorType: "unexpected", message } });
	}
}

/** Owns one lazily started Anthropic client and every disposable session on it. */
export class Runtime {
	#create: () => RuntimeSource;
	#source?: RuntimeSource;
	#sessions = new Map<string, LiveSession>();
	#accepting = true;

	constructor(create: () => RuntimeSource) {
		this.#create = create;
	}

	async open(config: SessionConfig): Promise<Session> {
		if (!this.#accepting) throw new Error("The agent runtime is shutting down.");
		if (!this.#source) this.#source = this.#create();
		let session = new LiveSession(this.#source.client, config);
		this.#sessions.set(session.sessionId, session);
		return session;
	}

	async discard(session: Session): Promise<boolean> {
		let known = this.#sessions.has(session.sessionId);
		this.#sessions.delete(session.sessionId);
		await session.disconnect().catch(() => {});
		return known;
	}

	async shutdown(): Promise<void> {
		this.#accepting = false;
		let sessions = [...this.#sessions.values()];
		this.#sessions.clear();
		await Promise.all(sessions.map(session => session.disconnect().catch(() => {})));
		if (this.#source) {
			this.#source.cleanup();
			this.#source = undefined;
		}
	}
}

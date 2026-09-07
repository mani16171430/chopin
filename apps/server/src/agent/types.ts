/**
 * Local replacements for the `@github/copilot-sdk` types this codebase used.
 *
 * Copilot is gone; these are not a general-purpose SDK surface, only the
 * exact shapes the rest of `agent/*` and `chat/service.ts` actually read.
 * `SessionEvent` in particular is a deliberately small subset of the SDK's
 * ~70-variant union — `chat/service.ts#translate()` only ever switches on
 * these seven, so that is all this defines.
 */

export type JSONSchema = {
	type: "object";
	properties?: Record<string, unknown>;
	required?: string[];
	additionalProperties?: boolean;
	[key: string]: unknown;
};

/** One tool the model may call. Every handler answers with a string. */
export type Tool = {
	name: string;
	description: string;
	parameters: JSONSchema;
	/** When true, no permission gate runs before this tool executes. */
	skipPermission?: boolean;
	handler: (args: unknown) => Promise<string>;
};

export type IdleEvent = {
	type: "session.idle";
	data: { aborted?: boolean };
};

export type AssistantMessageDeltaEvent = {
	type: "assistant.message_delta";
	data: { deltaContent: string; messageId: string };
};

export type AssistantMessageEvent = {
	type: "assistant.message";
	data: { content: string; messageId: string };
};

export type ToolExecutionStartEvent = {
	type: "tool.execution_start";
	data: { arguments?: unknown; toolCallId: string; toolName: string };
};

export type ToolExecutionCompleteEvent = {
	type: "tool.execution_complete";
	data: {
		error?: unknown;
		result?: { content?: string };
		success: boolean;
		toolCallId: string;
	};
};

export type PermissionCompletedEvent = {
	type: "permission.completed";
	data: {
		requestId: string;
		result: { kind: string; feedback?: string };
		toolCallId?: string;
	};
};

export type ErrorEvent = {
	type: "session.error";
	data: { errorType: string; message: string };
};

export type SessionEvent =
	| IdleEvent
	| AssistantMessageDeltaEvent
	| AssistantMessageEvent
	| ToolExecutionStartEvent
	| ToolExecutionCompleteEvent
	| PermissionCompletedEvent
	| ErrorEvent;

/** Unsubscribes a `Session.on` listener. */
export type Unsubscribe = () => void;

/** One disposable conversation. Mirrors the shape `chat/service.ts` drives. */
export type Session = {
	readonly sessionId: string;
	on(listener: (event: SessionEvent) => void): Unsubscribe;
	send(input: { prompt: string }): Promise<void>;
	/** Best-effort cancellation of an in-flight turn. */
	abort(): void;
	disconnect(): Promise<void>;
};

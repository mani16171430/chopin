import type { Frame, Request } from "./index";

type KIND<K extends string> = Frame & { kind: K };

/**
 * "Generate AI Doc" — a member button that asks the room's Planner to write a
 * Razorpay AI Doc about the current document and publish it through the
 * channel's AI-Docs MCP server.
 *
 * Like `cadence:generate`, this is a one-word instruction: a button press is
 * already an instruction, so the transcript records a system notice and the
 * agent starts a turn on a canned directive rather than on anything anybody
 * typed. The publish runs under the pressing member's own AI-Docs credential —
 * a member without one is refused, fail-closed.
 */
export declare namespace Aidoc {
	export type Incoming = Request<Generate>;

	/** Generate and publish an AI Doc about the room's document. Any member. */
	export type Generate = KIND<"doc:generate-ai">;
}

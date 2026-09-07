/** Capability boundary for the shared, repository-scoped agent runtime. */

import type { GateResult } from "./runtime";

export type Gate = (toolName: string, args: unknown) => Promise<GateResult>;

function deny(feedback: string): GateResult {
	return { allowed: false, feedback };
}

function allow(): GateResult {
	return { allowed: true };
}

export type GateOptions = {
	tools: Set<string>;
	active?: () => Promise<boolean>;
};

/**
 * The planner's gate.
 *
 * GitHub reads (pull requests, files, trees, history, search) no longer go
 * through a separate "mcp" request kind — they're ordinary tools now, each
 * one already closed over its one fixed repository, so there is nothing left
 * to check here beyond "is this tool one the planner is allowed to call, and
 * is its owner still active."
 */
export function gate(options: GateOptions): Gate {
	return async (toolName: string): Promise<GateResult> => {
		if (options.active && !(await options.active())) {
			return deny("The planner's owner or repository permission is no longer active.");
		}
		return options.tools.has(toolName)
			? allow()
			: deny(`${toolName} is not available to the planner.`);
	};
}

/** A worker may submit one terminal result and has no ambient capabilities. */
export function terminalGate(tool: string, active?: () => Promise<boolean>): Gate {
	return async (toolName: string): Promise<GateResult> => {
		if (active && !(await active())) return deny("The worker's owner is no longer active.");
		return toolName === tool ? allow() : deny("This worker may only submit its registered result.");
	};
}

/** Public research receives no private tools and may only use exact web search. */
export function publicResearchGate(
	resultTool: string,
	active?: () => Promise<boolean>,
): Gate {
	return async (toolName: string): Promise<GateResult> => {
		if (active && !(await active())) return deny("The worker's owner is no longer active.");
		return toolName === resultTool
			? allow()
			: deny("This worker may only submit its registered research result.");
	};
}

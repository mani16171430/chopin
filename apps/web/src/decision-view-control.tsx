import { Count } from "@chopin/editor";

import type { DecisionView } from "@chopin/editor";

export function decisionAttention(previous: number, current: number): boolean {
	return current > previous;
}

export function DecisionViewControl(
	{
		attention,
		cadenceNeedsInput = 0,
		onView,
		unanswered,
		view,
	}: {
		attention?: boolean;
		cadenceNeedsInput?: number;
		onView: (view: DecisionView) => void;
		unanswered: number;
		view: DecisionView;
	},
) {
	return (
		<div
			aria-label="Document view"
			className="flex shrink-0 items-center gap-1.5"
			data-document-view-control
			role="group"
		>
			<button
				aria-current={view === "plan" ? "page" : undefined}
				aria-pressed={view === "plan"}
				className={`btn btn-sm transition-[background-color,box-shadow,color] ${
					view === "plan"
						? "bg-ground font-medium text-gray-800"
						: "text-text-tertiary hover:bg-hover"
				}`}
				onClick={() => onView("plan")}
				type="button"
			>
				Document
			</button>
			<button
				aria-current={view === "decisions" ? "page" : undefined}
				aria-label={unanswered > 0 ? `Decisions, ${unanswered} unanswered` : "Decisions"}
				aria-pressed={view === "decisions"}
				className={`btn btn-sm transition-[background-color,box-shadow,color] ${
					view === "decisions"
						? "bg-ground font-medium text-gray-800"
						: "text-text-tertiary hover:bg-hover"
				}`}
				data-attention={attention || undefined}
				onClick={() => onView("decisions")}
				type="button"
			>
				Decisions
				{unanswered > 0 && (
					<span
						aria-hidden="true"
						className="ml-1"
						data-plan-decision-count
					>
						<Count key={attention ? `attention-${unanswered}` : "settled"} motion={attention}>
							{unanswered}
						</Count>
					</span>
				)}
			</button>
			<button
				aria-current={view === "cadence" ? "page" : undefined}
				aria-label={cadenceNeedsInput > 0
					? `Cadence Updates, ${cadenceNeedsInput} need input`
					: "Cadence Updates"}
				aria-pressed={view === "cadence"}
				className={`btn btn-sm transition-[background-color,box-shadow,color] ${
					view === "cadence"
						? "bg-ground font-medium text-gray-800"
						: "text-text-tertiary hover:bg-hover"
				}`}
				onClick={() => onView("cadence")}
				type="button"
			>
				Cadence Updates
				{cadenceNeedsInput > 0 && (
					<span aria-hidden="true" className="ml-1" data-plan-cadence-count>
						<Count>{cadenceNeedsInput}</Count>
					</span>
				)}
			</button>
			<button
				aria-current={view === "links" ? "page" : undefined}
				aria-pressed={view === "links"}
				className={`btn btn-sm transition-[background-color,box-shadow,color] ${
					view === "links"
						? "bg-ground font-medium text-gray-800"
						: "text-text-tertiary hover:bg-hover"
				}`}
				onClick={() => onView("links")}
				type="button"
			>
				Links
			</button>
		</div>
	);
}

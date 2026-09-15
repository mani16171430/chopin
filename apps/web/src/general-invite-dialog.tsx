import { useRef, useState } from "react";

import { copyInviteLink } from "./invite-link";
import { NavigationDialog } from "./navigation-dialog";

import type { NavigationDialogMotion } from "./navigation-dialog";

/**
 * Shows the invite link returned when a general document is created — the one
 * moment the raw link is available — with a copy affordance.
 */
export function GeneralInviteDialog(
	{
		inviteUrl,
		motion,
		onDismiss,
	}: {
		inviteUrl: string;
		motion: NavigationDialogMotion;
		onDismiss: () => void;
	},
) {
	let [copied, setCopied] = useState(false);
	let feedback = useRef<number | undefined>(undefined);
	let copy = () => {
		void copyInviteLink(inviteUrl).then(landed => {
			if (!landed) return;
			setCopied(true);
			window.clearTimeout(feedback.current);
			feedback.current = window.setTimeout(() => setCopied(false), 1600);
		});
	};
	let href = new URL(inviteUrl, location.origin).href;
	return (
		<NavigationDialog motion={motion} onDismiss={onDismiss} title="General document created">
			<p className="mt-3 text-sm text-text-secondary">
				Anyone with this link can view and edit this document. Copy it now — it is also available
				later from the document's Invite panel.
			</p>
			<div className="mt-4 flex flex-col gap-2">
				<code className="break-all rounded-sm bg-inset px-2 py-1.5 text-sm" data-invite-link="">
					{href}
				</code>
				<div className="flex gap-2">
					<button className="btn btn-md btn-primary" onClick={copy} type="button">
						{copied ? "Copied" : "Copy invite link"}
					</button>
					<button className="btn btn-md btn-secondary" onClick={onDismiss} type="button">
						Done
					</button>
				</div>
			</div>
		</NavigationDialog>
	);
}

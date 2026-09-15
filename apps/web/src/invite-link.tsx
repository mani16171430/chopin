import { useCallback, useEffect, useRef, useState } from "react";

import * as Api from "./api";
import { TerminalAlert } from "./terminal-alert";

/** Writes the invite link to the clipboard and reports whether it landed. */
export async function copyInviteLink(inviteUrl: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(new URL(inviteUrl, location.origin).href);
		return true;
	} catch {
		return false;
	}
}

/**
 * The shareable invite link for a general document.
 *
 * "View link" reads the live link back without changing anything. "Rotate
 * link" is the deliberate, destructive action: it mints a fresh link and
 * revokes the old one, cutting off everyone the old link let in.
 */
export function InviteLinkCard({ channelId }: { channelId: string }) {
	let [inviteUrl, setInviteUrl] = useState<string>();
	let [copied, setCopied] = useState(false);
	let [error, setError] = useState<unknown>();
	let [busy, setBusy] = useState<"view" | "rotate">();
	let feedback = useRef<number | undefined>(undefined);

	let flashCopied = useCallback(() => {
		setCopied(true);
		window.clearTimeout(feedback.current);
		feedback.current = window.setTimeout(() => setCopied(false), 1600);
	}, []);

	useEffect(() => () => window.clearTimeout(feedback.current), []);

	let view = useCallback(() => {
		setBusy("view");
		setError(undefined);
		Api.channelInvite(channelId).then(({ inviteUrl }) => {
			setInviteUrl(inviteUrl);
			setCopied(false);
		}, setError).finally(() => setBusy(undefined));
	}, [channelId]);

	let rotate = useCallback(() => {
		setBusy("rotate");
		setError(undefined);
		Api.rotateChannelInvite(channelId).then(({ inviteUrl: next }) => {
			setInviteUrl(next);
			setCopied(false);
		}, setError).finally(() => setBusy(undefined));
	}, [channelId]);

	if (error !== undefined) {
		return (
			<div className="max-w-sm rounded-md bg-page p-3 ring-hairline shadow-resting" role="status">
				<TerminalAlert className="text-sm text-destructive-ink">
					Could not load the invite link.
				</TerminalAlert>
			</div>
		);
	}
	if (!inviteUrl) {
		return (
			<div className="flex max-w-md flex-col gap-2 rounded-md bg-page p-3 ring-hairline shadow-resting">
				<p className="text-sm text-text-secondary">
					Anyone with the invite link can view and edit this document.
				</p>
				<div className="flex flex-wrap items-center gap-2">
					<button
						className="btn btn-sm btn-secondary"
						disabled={busy !== undefined}
						onClick={view}
						type="button"
					>
						{busy === "view" ? "Loading link..." : "View link"}
					</button>
					<button
						className="btn btn-sm btn-ghost"
						disabled={busy !== undefined}
						onClick={rotate}
						type="button"
					>
						{busy === "rotate" ? "Rotating..." : "Rotate link"}
					</button>
				</div>
			</div>
		);
	}
	return (
		<div className="flex max-w-md flex-col gap-2 rounded-md bg-page p-3 ring-hairline shadow-resting">
			<p className="text-sm text-text-secondary">
				Anyone with this link can view and edit this document.
			</p>
			<code
				className="break-all rounded-sm bg-inset px-2 py-1.5 text-sm"
				data-invite-link=""
			>
				{new URL(inviteUrl, location.origin).href}
			</code>
			<div className="flex flex-wrap items-center gap-2">
				<button
					className="btn btn-sm btn-secondary"
					onClick={() => void copyInviteLink(inviteUrl).then(copied => copied && flashCopied())}
					type="button"
				>
					{copied ? "Copied" : "Copy link"}
				</button>
				<button
					className="btn btn-sm btn-ghost"
					disabled={busy !== undefined}
					onClick={rotate}
					type="button"
				>
					Rotate link
				</button>
				{busy === "rotate" && (
					<span className="text-sm text-text-tertiary" role="status">Rotating...</span>
				)}
			</div>
			<p className="text-xs text-text-tertiary">
				Rotating replaces the link and signs out everyone the old link let in.
			</p>
		</div>
	);
}

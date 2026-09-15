import { lazy, Suspense, useEffect, useState } from "react";
import { generalDocumentPath } from "@chopin/protocol/document-url";

import * as Api from "./api";
import { readGeneralDocumentRecovery, rememberGeneralChannel } from "./general-recovery";
import { InviteLinkCard } from "./invite-link";

import type { ComponentType } from "react";
import type { DocumentRouteIdentity } from "./document-route-swap";

let RoomWorkspace = lazy(() =>
	import("./room-workspace").then(module => ({ default: module.RoomWorkspace }))
);

/** The address of a general document: just its slug, no repository. */
export type GeneralDocumentAddress = { slug: string };

/**
 * Resolves a general document route (slug or a bare channel id) into the same
 * document view a repository document gets, plus the invite affordance a
 * repository document does not have.
 */
export default function GeneralWorkspaceHost(
	{
		address,
		agent,
		Failure,
		Loading,
		onReady,
		routeKey,
		user,
	}: {
		address: GeneralDocumentAddress | { id: string };
		agent: boolean;
		Failure: ComponentType<{
			channel?: { title?: string; slug?: string };
			error: unknown;
			onRetry?: () => void;
		}>;
		Loading: ComponentType<{ label?: string }>;
		onReady?: (
			key: DocumentRouteIdentity,
			resolution?: {
				canonicalPath: string;
				channel: Api.Channel;
				routeKey: DocumentRouteIdentity;
			},
		) => void;
		routeKey: DocumentRouteIdentity;
		user: Api.User;
	},
) {
	let [detail, setDetail] = useState<Api.GeneralChannelDetail>();
	let [error, setError] = useState<unknown>();
	let [retry, setRetry] = useState(0);
	let recovery = "slug" in address
		? readGeneralDocumentRecovery(user.id, address.slug)
		: undefined;

	useEffect(() => {
		let active = true;
		let controller = new AbortController();
		setDetail(undefined);
		setError(undefined);
		let loaded = "slug" in address
			? Api.generalDocument(address.slug, controller.signal)
			: Api.generalChannel(address.id, controller.signal);
		loaded.then(resolved => {
			if (!active) return;
			// The general endpoints only answer for repository-less documents.
			setDetail(resolved as Api.GeneralChannelDetail);
			rememberGeneralChannel(user.id, resolved.channel);
			onReady?.(routeKey, {
				canonicalPath: generalDocumentPath(resolved.channel.slug),
				channel: resolved.channel,
				routeKey,
			});
		}, reason => {
			if (active) {
				setError(reason);
				onReady?.(routeKey);
			}
		});
		return () => {
			active = false;
			controller.abort();
		};
	}, [onReady, retry, routeKey, user.id, ...("slug" in address ? [address.slug] : [address.id])]);

	if (error) {
		return (
			<Failure
				channel={recovery?.channel ?? ("slug" in address ? { slug: address.slug } : undefined)}
				error={error}
				onRetry={() => {
					setError(undefined);
					setRetry(value => value + 1);
				}}
			/>
		);
	}
	if (!detail) return <Loading label="Opening document..." />;
	return (
		<Suspense fallback={<Loading label="Opening document..." />}>
			<RoomWorkspace
				agent={agent}
				archivedAt={detail.channel.archivedAt}
				canEdit={!detail.channel.archivedAt && (detail.canEdit || detail.canManage)}
				canManage={detail.canManage}
				description={detail.channel.description}
				descriptionRevision={detail.channel.descriptionRevision}
				handle={user.login}
				headerAction={<InviteLinkCard channelId={detail.channel.id} />}
				label={detail.channel.title}
				presentation={{ type: "document" }}
				room={detail.channel.id}
				slug={detail.channel.slug}
				updatedAt={detail.channel.updatedAt}
				userId={user.id}
			/>
		</Suspense>
	);
}

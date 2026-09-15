import {
	childDocumentPath,
	documentPath,
	generalDocumentPath,
} from "@chopin/protocol/document-url";

import * as Api from "./api";

type DocumentReaders = {
	channel: (id: string, signal?: AbortSignal) => Promise<Api.ChannelDetail>;
	document: (
		owner: string,
		repository: string,
		slug: string,
		signal?: AbortSignal,
	) => Promise<Api.ChannelDetail>;
	/** A repo-less channel fetch: a general document answers it too. */
	generalChannel: (id: string, signal?: AbortSignal) => Promise<Api.AnyChannelDetail>;
};

export function validatedChildPath(
	child: Api.ChannelDetail,
	parent: Api.ChannelDetail,
): string {
	let sameRepository = child.repository.id === parent.repository.id
		&& child.channel.repositoryId === child.repository.id
		&& parent.channel.repositoryId === parent.repository.id;
	if (
		!child.channel.parentChannelId
		|| child.channel.parentChannelId !== parent.channel.id
		|| parent.channel.parentChannelId
		|| !sameRepository
		|| !parent.channel.slug
		|| !child.channel.slug
	) {
		throw new Api.ApiError("Child document not found", 404);
	}
	return childDocumentPath(
		child.repository.owner,
		child.repository.name,
		parent.channel.slug,
		child.channel.slug,
	);
}

export async function prepareDocumentLoad(
	address:
		| { id: string }
		| {
			owner: string;
			repository: string;
			slug: string;
			parentSlug?: string;
		},
	signal: AbortSignal,
	readers: DocumentReaders = Api,
): Promise<{ detail: Api.AnyChannelDetail; parent?: Api.ChannelDetail; pathname: string }> {
	if ("id" in address) {
		let detail = await readers.generalChannel(address.id, signal);
		// A general document has no repository; its canonical path is the slug.
		if (!detail.repository) {
			return { detail, pathname: generalDocumentPath(detail.channel.slug) };
		}
		if (!detail.channel.parentChannelId) {
			return {
				detail,
				pathname: documentPath(
					detail.repository.owner,
					detail.repository.name,
					detail.channel.slug,
				),
			};
		}
		let parent = await readers.channel(detail.channel.parentChannelId, signal);
		return { detail, parent, pathname: validatedChildPath(detail, parent) };
	}
	if (address.parentSlug) {
		let [detail, parent] = await Promise.all([
			readers.document(address.owner, address.repository, address.slug, signal),
			readers.document(address.owner, address.repository, address.parentSlug, signal),
		]);
		return { detail, parent, pathname: validatedChildPath(detail, parent) };
	}
	let detail = await readers.document(
		address.owner,
		address.repository,
		address.slug,
		signal,
	);
	if (detail.channel.parentChannelId) {
		let parent = await readers.channel(detail.channel.parentChannelId, signal);
		return { detail, parent, pathname: validatedChildPath(detail, parent) };
	}
	return {
		detail,
		pathname: documentPath(
			detail.repository.owner,
			detail.repository.name,
			detail.channel.slug,
		),
	};
}

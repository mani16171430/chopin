import { generalDocumentPath } from "@chopin/protocol/document-url";

import type * as Api from "./api";

/** Recovery context for a general document — the repository-less variant of channel-recovery. */
export type GeneralChannelRecovery = {
	channel: Pick<Api.Channel, "id" | "title"> & Partial<Pick<Api.Channel, "slug">>;
};

const KEY = "chopin:general-channel-recovery:";
const PATH_KEY = "chopin:general-document-recovery:";

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function text(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function recovery(value: unknown, id: string): value is GeneralChannelRecovery {
	let item = record(value);
	let channel = record(item?.channel);
	return !!item
		&& !!channel
		&& channel.id === id
		&& text(channel.title)
		&& (channel.slug === undefined || text(channel.slug));
}

export function rememberGeneralChannel(
	userId: string,
	channel: Pick<Api.Channel, "id" | "title" | "slug">,
	storage: Storage = sessionStorage,
): void {
	try {
		let entry = JSON.stringify({ channel });
		storage.setItem(`${KEY}${encodeURIComponent(userId)}:${channel.id}`, entry);
		storage.setItem(
			`${PATH_KEY}${encodeURIComponent(userId)}:${generalDocumentPath(channel.slug)}`,
			entry,
		);
	} catch {
		// Recovery context must never prevent the navigation it is meant to help.
	}
}

export function readGeneralDocumentRecovery(
	userId: string,
	slug: string,
	storage: Storage = sessionStorage,
): GeneralChannelRecovery | undefined {
	try {
		let path = generalDocumentPath(slug);
		let value: unknown = JSON.parse(
			storage.getItem(`${PATH_KEY}${encodeURIComponent(userId)}:${path}`) ?? "null",
		);
		let item = record(value);
		let storedChannel = record(item?.channel);
		return text(storedChannel?.id)
				&& text(storedChannel.slug)
				&& storedChannel.slug === slug
				&& recovery(value, storedChannel.id)
			? value
			: undefined;
	} catch {
		return undefined;
	}
}

export function readGeneralChannelRecovery(
	userId: string,
	id: string,
	storage: Storage = sessionStorage,
): GeneralChannelRecovery | undefined {
	try {
		let value: unknown = JSON.parse(
			storage.getItem(`${KEY}${encodeURIComponent(userId)}:${id}`) ?? "null",
		);
		return recovery(value, id) ? value : undefined;
	} catch {
		return undefined;
	}
}

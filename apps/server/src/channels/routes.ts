import { createHash } from "node:crypto";

import { documentPath, generalDocumentPath } from "@chopin/protocol/document-url";

import { GitHubError } from "../github/client";
import * as Seal from "../auth/seal";
import { StorageError } from "../storage/errors";

import { documentTitles } from "./document-title";
import { isChannelId, newChannelId } from "./id";
import { documentSlug } from "./slug";
import { normalizedTitle } from "./title";

import type { HostedAuth } from "../auth/routes";
import type { AuthenticatedSession } from "../auth/session";
import type { Repository } from "../github/client";
import type { Router } from "../http/router";
import { isRepositoryChannel } from "../storage/model";

import type { ChannelArchiveResult, ChannelCursor, ChannelRecord } from "../storage/model";

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;
const INVITE_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** An invite's join lookup is by SHA-256 of the raw token. */
function inviteTokenHash(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

/*
 * A member can read a document's live link back, so the token is also stored —
 * sealed (AES-256-GCM) under the deployment key, purpose-bound to "invite".
 * The raw token never sits in the database in the clear.
 */
async function sealToken(key: Uint8Array, token: string): Promise<Uint8Array> {
	return Seal.encrypted(await Seal.imported(key), "invite", token);
}

async function openToken(key: Uint8Array, envelope: Uint8Array): Promise<string | undefined> {
	try {
		let value = await Seal.decrypted(await Seal.imported(key), "invite", envelope);
		return typeof value === "string" ? value : undefined;
	} catch {
		return undefined;
	}
}

function json(value: unknown, status = 200, cookie?: string, location?: string): Response {
	let headers = new Headers({
		"cache-control": "no-store",
		"content-type": "application/json; charset=utf-8",
		"x-content-type-options": "nosniff",
	});
	if (cookie) headers.append("set-cookie", cookie);
	if (location) headers.set("location", location);
	return Response.json(value, { status, headers });
}

function serialized(channel: ChannelRecord) {
	return {
		id: channel.id,
		repositoryId: channel.repositoryId,
		repositoryOwner: channel.repositoryOwner,
		repositoryName: channel.repositoryName,
		...(channel.parentChannelId ? { parentChannelId: channel.parentChannelId } : {}),
		title: channel.title,
		slug: channel.slug,
		createdBy: channel.createdBy,
		revision: channel.revision,
		createdAt: channel.createdAt.toISOString(),
		updatedAt: channel.updatedAt.toISOString(),
		descriptionRevision: channel.description?.revision ?? 0,
		...(channel.description ? { description: channel.description.value } : {}),
		...(channel.archivedAt ? { archivedAt: channel.archivedAt.toISOString() } : {}),
	};
}

function repository(value: Repository) {
	return {
		id: value.id,
		owner: value.owner,
		ownerAvatarUrl: value.ownerAvatarUrl,
		name: value.name,
		fullName: value.fullName,
		private: value.private,
		url: value.url,
		defaultBranch: value.defaultBranch,
		permissions: value.permissions,
	};
}

function encoded(cursor: ChannelCursor, query: string, includeArchived: boolean): string {
	return Buffer.from(JSON.stringify({
		v: 3,
		updatedAt: cursor.updatedAt.toISOString(),
		id: cursor.id,
		query,
		includeArchived,
	})).toString("base64url");
}

function decoded(
	value: string | null,
): { cursor: ChannelCursor; query: string; includeArchived: boolean } | undefined | false {
	if (value === null) return undefined;
	if (!/^[A-Za-z0-9_-]+$/.test(value)) return false;
	try {
		let parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
		if (!parsed || typeof parsed !== "object") return false;
		let item = parsed as Record<string, unknown>;
		if (
			item.v !== 3
			|| typeof item.updatedAt !== "string"
			|| typeof item.id !== "string"
			|| typeof item.query !== "string"
			|| typeof item.includeArchived !== "boolean"
		) {
			return false;
		}
		let updatedAt = new Date(item.updatedAt);
		if (Number.isNaN(updatedAt.getTime()) || !isChannelId(item.id)) return false;
		return {
			cursor: { updatedAt, id: item.id },
			query: item.query,
			includeArchived: item.includeArchived,
		};
	} catch {
		return false;
	}
}

function query(url: URL): string | false {
	let values = url.searchParams.getAll("query");
	if (values.length > 1) return false;
	let value = values[0]?.trim().toLowerCase() ?? "";
	return value.length <= 120 ? value : false;
}

function limit(url: URL): number | undefined {
	let values = url.searchParams.getAll("limit");
	if (values.length === 0) return 50;
	if (values.length !== 1 || !/^\d+$/.test(values[0]!)) return undefined;
	let parsed = Number(values[0]);
	return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : undefined;
}

function archived(url: URL): boolean | undefined {
	let values = url.searchParams.getAll("includeArchived");
	if (values.length === 0) return false;
	if (values.length !== 1 || values[0] !== "true") return undefined;
	return true;
}

async function requestedTitle(
	request: Request,
	optional: boolean,
): Promise<{ title?: string; valid: boolean }> {
	let length = Number(request.headers.get("content-length") || "0");
	if (Number.isFinite(length) && length > 4_096) return { valid: false };
	let source = await request.text();
	if (new TextEncoder().encode(source).length > 4_096) return { valid: false };
	try {
		let value = JSON.parse(source) as unknown;
		if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false };
		let raw = (value as Record<string, unknown>).title;
		if (raw === undefined) return { valid: optional };
		let title = normalizedTitle(raw);
		return title ? { valid: true, title } : { valid: false };
	} catch {
		return { valid: false };
	}
}

async function failure(err: unknown, _request: Request, auth: HostedAuth): Promise<Response> {
	if (err instanceof GitHubError) {
		if (err.status === 401) {
			return json({ error: "GitHub authorization expired" }, 401, auth.sessions.clearCookie());
		}
		return json({ error: err.message }, err.status);
	}
	if (err instanceof StorageError) {
		let status = err.failure === "missing"
			? 404
			: err.failure === "conflict"
			? 409
			: err.failure === "unavailable"
			? 503
			: 500;
		return json(
			{ error: status === 503 ? "storage is unavailable" : "channel storage failed" },
			status,
		);
	}
	return json({ error: "request failed" }, 500);
}

async function authorizedRepository(
	auth: HostedAuth,
	session: AuthenticatedSession,
	owner: string,
	name: string,
): Promise<Repository> {
	if (!OWNER.test(owner) || !REPOSITORY.test(name)) {
		throw new GitHubError("repository not found", 404);
	}
	let result = await auth.sessions.use(
		session,
		token => auth.github.repositoryAccess(token, owner, name),
	);
	let repository = result.value;
	if (!repository) throw new GitHubError("repository not found", 404);
	return repository;
}

/** Opens a document only after its current repository identity has been revalidated. */
function openedDocument(
	repo: Repository,
	channel: ChannelRecord,
) {
	if (repo.id !== channel.repositoryId || !repo.permissions.pull) return undefined;
	let canManage = repo.permissions.push || repo.permissions.admin;
	return {
		repository: repository(repo),
		canEdit: canManage && !channel.archivedAt,
		canManage,
		channel: serialized(channel),
	};
}

/** Authenticated metadata routes; live collaboration is still the following stage. */
export function registerChannelRoutes(
	router: Router,
	auth: HostedAuth,
	options: {
		onAgentReset?: (channelId: string) => Promise<void>;
		onChannelArchived?: (channelId: string, now: Date) => Promise<ChannelArchiveResult>;
		onChannelDeleted?: (channelId: string) => Promise<boolean>;
		onChannelRenamed?: (channel: ChannelRecord) => void;
		onChannelRestored?: (channelId: string, now: Date) => Promise<ChannelArchiveResult>;
		random?: () => number;
	} = {},
): void {
	router.on(
		"GET",
		"/api/repositories/:owner/:repository/channels",
		async (request, url, params) => {
			try {
				let session = await auth.sessions.authenticate(request);
				if (!session) return json({ error: "authentication required" }, 401);
				let repo = await authorizedRepository(
					auth,
					session,
					params.owner!,
					params.repository!,
				);
				if (!repo.permissions.pull) {
					return json({ error: "repository read access is required" }, 403);
				}
				let requestedLimit = limit(url);
				let requestedQuery = query(url);
				let includeArchived = archived(url);
				let cursorValues = url.searchParams.getAll("cursor");
				let cursor = cursorValues.length <= 1 ? decoded(cursorValues[0] ?? null) : false;
				if (
					!requestedLimit || requestedQuery === false || includeArchived === undefined
					|| cursor === false
				) {
					return json({ error: "invalid channel pagination" }, 400);
				}
				if (
					cursor
					&& (cursor.query !== requestedQuery || cursor.includeArchived !== includeArchived)
				) {
					return json({ error: "invalid channel pagination" }, 400);
				}
				let page = await auth.storage.channels.list(
					repo.id,
					requestedLimit,
					cursor?.cursor,
					requestedQuery || undefined,
					includeArchived,
				);
				let canManage = repo.permissions.push || repo.permissions.admin;
				return json({
					repository: repository(repo),
					canEdit: canManage,
					channels: page.channels.map(serialized),
					nextCursor: page.next
						? encoded(page.next, requestedQuery, includeArchived)
						: undefined,
				});
			} catch (err) {
				return failure(err, request, auth);
			}
		},
	);

	router.on(
		"POST",
		"/api/repositories/:owner/:repository/channels",
		async (request, _url, params) => {
			if (request.headers.get("origin") !== auth.config.origin) {
				return json({ error: "origin is not allowed" }, 403);
			}
			try {
				let session = await auth.sessions.authenticate(request);
				if (!session) return json({ error: "authentication required" }, 401);
				let repo = await authorizedRepository(
					auth,
					session,
					params.owner!,
					params.repository!,
				);
				if (!repo.permissions.push && !repo.permissions.admin) {
					return json({ error: "repository write access is required" }, 403);
				}
				let title = await requestedTitle(request, true);
				if (!title.valid) {
					return json({ error: "title must be between 1 and 120 characters" }, 400);
				}
				let channel: ChannelRecord | undefined;
				let candidates = title.title === undefined
					? documentTitles(options.random)
					: [title.title];
				for (let candidate of candidates) {
					try {
						channel = await auth.storage.channels.create({
							id: newChannelId(repo.id),
							repositoryId: repo.id,
							repositoryOwner: repo.owner,
							repositoryName: repo.name,
							title: candidate,
							createdBy: session.user.id,
							now: auth.clock(),
						});
						break;
					} catch (err) {
						if (
							title.title !== undefined || !(err instanceof StorageError)
							|| err.failure !== "conflict"
						) {
							throw err;
						}
					}
				}
				if (!channel) throw new StorageError("conflict", "could not reserve a generated title");
				return json(
					{
						repository: repository(repo),
						canEdit: true,
						canManage: true,
						channel: serialized(channel),
					},
					201,
					undefined,
					documentPath(repo.owner, repo.name, channel.slug),
				);
			} catch (err) {
				return failure(err, request, auth);
			}
		},
	);

	router.on("POST", "/api/documents/general", async request => {
		if (request.headers.get("origin") !== auth.config.origin) {
			return json({ error: "origin is not allowed" }, 403);
		}
		try {
			let session = await auth.sessions.authenticate(request);
			if (!session) return json({ error: "authentication required" }, 401);
			let title = await requestedTitle(request, true);
			if (!title.valid) {
				return json({ error: "title must be between 1 and 120 characters" }, 400);
			}
			let channel: ChannelRecord | undefined;
			let candidates = title.title === undefined
				? documentTitles(options.random)
				: [title.title];
			for (let candidate of candidates) {
				try {
					// A general document has no repository; a random UUID namespaces its id.
					channel = await auth.storage.channels.create({
						id: newChannelId(crypto.randomUUID()),
						repositoryId: null,
						repositoryOwner: null,
						repositoryName: null,
						title: candidate,
						createdBy: session.user.id,
						now: auth.clock(),
					});
					break;
				} catch (err) {
					if (
						title.title !== undefined || !(err instanceof StorageError)
						|| err.failure !== "conflict"
					) {
						throw err;
					}
				}
			}
			if (!channel) throw new StorageError("conflict", "could not reserve a generated title");
			// The invite is the document's only credential: mint one and join the creator.
			let token = crypto.randomUUID();
			let invite = await auth.storage.invites.mint({
				channelId: channel.id,
				tokenHash: inviteTokenHash(token),
				tokenEnvelope: await sealToken(auth.config.encryptionKey, token),
				createdBy: session.user.id,
				now: auth.clock(),
			});
			await auth.storage.invites.join({
				channelId: channel.id,
				userId: session.user.id,
				inviteId: invite.id,
				now: auth.clock(),
			});
			// The raw token appears only here; it is never stored or logged.
			return json(
				{
					canEdit: true,
					canManage: true,
					channel: serialized(channel),
					inviteUrl: `${auth.config.origin}/join/${token}`,
				},
				201,
				undefined,
				generalDocumentPath(channel.slug),
			);
		} catch (err) {
			return failure(err, request, auth);
		}
	});

	router.on("GET", "/join/:token", async (request, _url, params) => {
		let token = params.token!;
		let session = await auth.sessions.authenticate(request);
		if (!session) {
			let location = `/auth/github?return_to=${encodeURIComponent(`/join/${token}`)}`;
			return new Response(null, {
				status: 302,
				headers: { "cache-control": "no-store", location },
			});
		}
		if (!INVITE_TOKEN.test(token)) return json({ error: "invite not found" }, 404);
		try {
			let invite = await auth.storage.invites.resolve(inviteTokenHash(token));
			if (!invite) return json({ error: "invite not found" }, 404);
			let channel = await auth.storage.channels.get(invite.channelId);
			if (!channel) return json({ error: "invite not found" }, 404);
			await auth.storage.invites.join({
				channelId: channel.id,
				userId: session.user.id,
				inviteId: invite.id,
				now: auth.clock(),
			});
			return new Response(null, {
				status: 302,
				headers: {
					"cache-control": "no-store",
					location: generalDocumentPath(channel.slug),
				},
			});
		} catch (err) {
			return failure(err, request, auth);
		}
	});

	router.on("GET", "/api/my/general-documents", async (request, _url, _params) => {
		try {
			let session = await auth.sessions.authenticate(request);
			if (!session) return json({ error: "authentication required" }, 401);
			// The general documents this user has joined — the General Documents
			// sidebar section. Membership, not creation, is what lists a document.
			let ids = await auth.storage.invites.channelsJoinedBy(session.user.id);
			let channels = (await Promise.all(ids.map(id => auth.storage.channels.get(id))))
				.filter(channel => channel && !isRepositoryChannel(channel) && !channel.archivedAt)
				.map(channel => serialized(channel!));
			return json({ channels });
		} catch (err) {
			return failure(err, request, auth);
		}
	});

	router.on("GET", "/api/documents/general/:slug", async (request, _url, params) => {
		try {
			let session = await auth.sessions.authenticate(request);
			if (!session) return json({ error: "authentication required" }, 401);
			// A general document's slug scope is the null repository.
			let channel = await auth.storage.channels.resolve(null, documentSlug(params.slug!));
			if (!channel || isRepositoryChannel(channel)) {
				return json({ error: "channel not found" }, 404);
			}
			// A general document authorizes on held membership, not a repository role.
			let member = await auth.storage.invites.isMember(channel.id, session.user.id);
			if (!member) return json({ error: "channel not found" }, 404);
			return json({
				canEdit: !channel.archivedAt,
				canManage: !channel.archivedAt,
				channel: serialized(channel),
			});
		} catch (err) {
			return failure(err, request, auth);
		}
	});

	router.on("POST", "/api/channels/:channelId/invite/rotate", async (request, _url, params) => {
		if (request.headers.get("origin") !== auth.config.origin) {
			return json({ error: "origin is not allowed" }, 403);
		}
		try {
			let session = await auth.sessions.authenticate(request);
			if (!session) return json({ error: "authentication required" }, 401);
			let id = params.channelId!;
			if (!isChannelId(id)) return json({ error: "channel not found" }, 404);
			let channel = await auth.storage.channels.get(id);
			if (!channel) return json({ error: "channel not found" }, 404);
			// Only a general document's current collaborator may rotate its invite.
			if (isRepositoryChannel(channel)) return json({ error: "channel not found" }, 404);
			let member = await auth.storage.invites.isMember(channel.id, session.user.id);
			if (!member) return json({ error: "channel not found" }, 404);
			let token = crypto.randomUUID();
			await auth.storage.invites.mint({
				channelId: channel.id,
				tokenHash: inviteTokenHash(token),
				tokenEnvelope: await sealToken(auth.config.encryptionKey, token),
				createdBy: session.user.id,
				now: auth.clock(),
			});
			// The raw token appears only here; in storage it is sealed, never clear.
			return json({ inviteUrl: `${auth.config.origin}/join/${token}` });
		} catch (err) {
			return failure(err, request, auth);
		}
	});

	router.on("GET", "/api/channels/:channelId/invite", async (request, _url, params) => {
		try {
			let session = await auth.sessions.authenticate(request);
			if (!session) return json({ error: "authentication required" }, 401);
			let id = params.channelId!;
			if (!isChannelId(id)) return json({ error: "channel not found" }, 404);
			let channel = await auth.storage.channels.get(id);
			if (!channel) return json({ error: "channel not found" }, 404);
			// Only a general document has an invite; only its collaborator may read it.
			if (isRepositoryChannel(channel)) return json({ error: "channel not found" }, 404);
			let member = await auth.storage.invites.isMember(channel.id, session.user.id);
			if (!member) return json({ error: "channel not found" }, 404);
			// The live link, for the document's Invite panel. The stored token is
			// sealed; opening it here is what lets "View link" differ from "Rotate".
			let live = await auth.storage.invites.live(channel.id);
			let token = live?.tokenEnvelope
				? await openToken(auth.config.encryptionKey, live.tokenEnvelope)
				: undefined;
			// Self-heal an invite written before tokens were recoverable: seal a
			// fresh token onto the same live row. Not a rotate — the invite is not
			// revoked and no member is flushed; the link simply becomes readable.
			if (!token && live) {
				token = crypto.randomUUID();
				await auth.storage.invites.reseal(
					channel.id,
					inviteTokenHash(token),
					await sealToken(auth.config.encryptionKey, token),
				);
			}
			if (!token) return json({ error: "no invite link is available" }, 404);
			return json({ inviteUrl: `${auth.config.origin}/join/${token}` });
		} catch (err) {
			return failure(err, request, auth);
		}
	});

	router.on(
		"GET",
		"/api/repositories/:owner/:repository/documents/:slug",
		async (request, _url, params) => {
			try {
				let session = await auth.sessions.authenticate(request);
				if (!session) return json({ error: "authentication required" }, 401);
				let repo = await authorizedRepository(
					auth,
					session,
					params.owner!,
					params.repository!,
				);
				if (!repo.permissions.pull) return json({ error: "channel not found" }, 404);
				let channel = await auth.storage.channels.resolve(repo.id, documentSlug(params.slug!));
				if (!channel) return json({ error: "channel not found" }, 404);
				let opened = openedDocument(repo, channel);
				return opened ? json(opened) : json({ error: "channel not found" }, 404);
			} catch (err) {
				return failure(err, request, auth);
			}
		},
	);

	router.on("GET", "/api/channels/:channelId", async (request, _url, params) => {
		try {
			let session = await auth.sessions.authenticate(request);
			if (!session) return json({ error: "authentication required" }, 401);
			let id = params.channelId!;
			if (!isChannelId(id)) return json({ error: "channel not found" }, 404);
			let channel = await auth.storage.channels.get(id);
			if (!channel) return json({ error: "channel not found" }, 404);
			// A general document authorizes on held membership, not a repository role.
			if (!isRepositoryChannel(channel)) {
				let member = await auth.storage.invites.isMember(channel.id, session.user.id);
				if (!member) return json({ error: "channel not found" }, 404);
				return json({
					canEdit: !channel.archivedAt,
					canManage: !channel.archivedAt,
					channel: serialized(channel),
				});
			}
			let repo = await authorizedRepository(
				auth,
				session,
				channel.repositoryOwner,
				channel.repositoryName,
			);
			let opened = openedDocument(repo, channel);
			return opened ? json(opened) : json({ error: "channel not found" }, 404);
		} catch (err) {
			return failure(err, request, auth);
		}
	});

	router.on("PATCH", "/api/channels/:channelId", async (request, _url, params) => {
		if (request.headers.get("origin") !== auth.config.origin) {
			return json({ error: "origin is not allowed" }, 403);
		}
		try {
			let session = await auth.sessions.authenticate(request);
			if (!session) return json({ error: "authentication required" }, 401);
			let id = params.channelId!;
			if (!isChannelId(id)) return json({ error: "channel not found" }, 404);
			let channel = await auth.storage.channels.get(id);
			if (!channel) return json({ error: "channel not found" }, 404);
			let requested = await requestedTitle(request, false);
			if (!requested.valid || !requested.title) {
				return json({ error: "title must be between 1 and 120 characters" }, 400);
			}
			// A general document renames on held membership, not a repository role.
			if (!isRepositoryChannel(channel)) {
				let member = await auth.storage.invites.isMember(channel.id, session.user.id);
				if (!member) return json({ error: "channel not found" }, 404);
				let renamed = await auth.storage.channels.rename({
					id,
					title: requested.title,
					now: auth.clock(),
				});
				if (renamed.changed) options.onChannelRenamed?.(renamed.channel);
				return json(
					{ canEdit: true, canManage: true, channel: serialized(renamed.channel) },
					200,
					undefined,
					generalDocumentPath(renamed.channel.slug),
				);
			}
			let repo = await authorizedRepository(
				auth,
				session,
				channel.repositoryOwner,
				channel.repositoryName,
			);
			if (repo.id !== channel.repositoryId || !repo.permissions.pull) {
				return json({ error: "channel not found" }, 404);
			}
			if (!repo.permissions.push && !repo.permissions.admin) {
				return json({ error: "repository write access is required" }, 403);
			}
			let renamed = await auth.storage.channels.rename({
				id,
				title: requested.title,
				now: auth.clock(),
			});
			if (renamed.changed) options.onChannelRenamed?.(renamed.channel);
			return json({
				repository: repository(repo),
				canEdit: true,
				canManage: true,
				channel: serialized(renamed.channel),
			});
		} catch (err) {
			if (err instanceof StorageError && err.failure === "conflict") {
				return json({ error: "a document with this title already exists" }, 409);
			}
			return failure(err, request, auth);
		}
	});

	let registerArchiveTransition = (
		path: string,
		action: "archive" | "restore",
	) => {
		router.on("POST", path, async (request, _url, params) => {
			if (request.headers.get("origin") !== auth.config.origin) {
				return json({ error: "origin is not allowed" }, 403);
			}
			try {
				let session = await auth.sessions.authenticate(request);
				if (!session) return json({ error: "authentication required" }, 401);
				let id = params.channelId!;
				if (!isChannelId(id)) return json({ error: "channel not found" }, 404);
				let channel = await auth.storage.channels.get(id);
				if (!channel) return json({ error: "channel not found" }, 404);
				let now = auth.clock();
				// A general document archives and restores on held membership.
				if (!isRepositoryChannel(channel)) {
					let member = await auth.storage.invites.isMember(channel.id, session.user.id);
					if (!member) return json({ error: "channel not found" }, 404);
					let result = action === "archive"
						? await (options.onChannelArchived
							? options.onChannelArchived(id, now)
							: auth.storage.channels.archive({ id, now }))
						: await (options.onChannelRestored
							? options.onChannelRestored(id, now)
							: auth.storage.channels.restore({ id, now }));
					return json({
						canEdit: !result.channel.archivedAt,
						canManage: !result.channel.archivedAt,
						channel: serialized(result.channel),
					});
				}
				let repo = await authorizedRepository(
					auth,
					session,
					channel.repositoryOwner,
					channel.repositoryName,
				);
				if (repo.id !== channel.repositoryId || !repo.permissions.pull) {
					return json({ error: "channel not found" }, 404);
				}
				if (!repo.permissions.push && !repo.permissions.admin) {
					return json({ error: "repository write access is required" }, 403);
				}
				let result = action === "archive"
					? await (options.onChannelArchived
						? options.onChannelArchived(id, now)
						: auth.storage.channels.archive({ id, now }))
					: await (options.onChannelRestored
						? options.onChannelRestored(id, now)
						: auth.storage.channels.restore({ id, now }));
				let opened = openedDocument(repo, result.channel);
				return opened ? json(opened) : json({ error: "channel not found" }, 404);
			} catch (err) {
				return failure(err, request, auth);
			}
		});
	};
	registerArchiveTransition("/api/channels/:channelId/archive", "archive");
	registerArchiveTransition("/api/channels/:channelId/restore", "restore");

	router.on("DELETE", "/api/channels/:channelId", async (request, _url, params) => {
		if (request.headers.get("origin") !== auth.config.origin) {
			return json({ error: "origin is not allowed" }, 403);
		}
		try {
			let session = await auth.sessions.authenticate(request);
			if (!session) return json({ error: "authentication required" }, 401);
			let id = params.channelId!;
			if (!isChannelId(id)) return json({ error: "channel not found" }, 404);
			let channel = await auth.storage.channels.get(id);
			if (!channel) return json({ error: "channel not found" }, 404);
			// A general document deletes on held membership, still archived-first.
			if (!isRepositoryChannel(channel)) {
				let member = await auth.storage.invites.isMember(channel.id, session.user.id);
				if (!member) return json({ error: "channel not found" }, 404);
				if (!channel.archivedAt) {
					return json({ error: "document must be archived before deletion" }, 409);
				}
				let deleted = options.onChannelDeleted
					? await options.onChannelDeleted(id)
					: await auth.storage.channels.delete(id);
				return deleted
					? new Response(null, { status: 204, headers: { "cache-control": "no-store" } })
					: json({ error: "channel not found" }, 404);
			}
			let repo = await authorizedRepository(
				auth,
				session,
				channel.repositoryOwner,
				channel.repositoryName,
			);
			if (repo.id !== channel.repositoryId || !repo.permissions.pull) {
				return json({ error: "channel not found" }, 404);
			}
			if (!repo.permissions.push && !repo.permissions.admin) {
				return json({ error: "repository write access is required" }, 403);
			}
			if (!channel.archivedAt) {
				return json({ error: "document must be archived before deletion" }, 409);
			}
			let deleted = options.onChannelDeleted
				? await options.onChannelDeleted(id)
				: await auth.storage.channels.delete(id);
			return deleted
				? new Response(null, { status: 204, headers: { "cache-control": "no-store" } })
				: json({ error: "channel not found" }, 404);
		} catch (err) {
			return failure(err, request, auth);
		}
	});

	router.on("POST", "/api/channels/:channelId/agent/reset", async (request, _url, params) => {
		if (request.headers.get("origin") !== auth.config.origin) {
			return json({ error: "origin is not allowed" }, 403);
		}
		try {
			let session = await auth.sessions.authenticate(request);
			if (!session) return json({ error: "authentication required" }, 401);
			let channel = await auth.storage.channels.get(params.channelId!);
			if (!channel) return json({ error: "channel not found" }, 404);
			if (!isRepositoryChannel(channel)) return json({ error: "channel not found" }, 404);
			let repo = await authorizedRepository(
				auth,
				session,
				channel.repositoryOwner,
				channel.repositoryName,
			);
			if (
				repo.id !== channel.repositoryId
				|| (!repo.permissions.push && !repo.permissions.admin)
			) return json({ error: "repository write access is required" }, 403);
			let stored = await auth.storage.collaboration.load(channel.id, auth.clock());
			let owner = stored?.agent;
			if (owner?.ownerSessionId) {
				await auth.storage.channels.clearAgentOwner(
					channel.id,
					owner.ownerSessionId,
					owner.generation,
					auth.clock(),
				);
			}
			await options.onAgentReset?.(channel.id);
			return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
		} catch (err) {
			return failure(err, request, auth);
		}
	});
}

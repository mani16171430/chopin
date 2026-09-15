-- General documents: a channel whose repository is null until it is moved
-- under one. A null repository_id is the marker; authorization switches from
-- the repository role to a held invite link.

ALTER TABLE channels ALTER COLUMN repository_id DROP NOT NULL;
ALTER TABLE channels ALTER COLUMN repository_owner DROP NOT NULL;
ALTER TABLE channels ALTER COLUMN repository_name DROP NOT NULL;

-- General documents get their own title-uniqueness scope so a general title
-- can never collide with, or be mistaken for, a repository document's.
CREATE UNIQUE INDEX channels_general_title_ci
	ON channels (lower(title))
	WHERE repository_id IS NULL;

-- channel_slugs keyed a slug by repository, with (repository_id, slug) as its
-- primary key and a composite foreign key to channels(repository_id, id). A
-- primary-key column cannot be null, and a composite FK cannot hold with a
-- null in it, so neither survives a general document. Rebuild the table with a
-- surrogate key: slug uniqueness becomes a COALESCE(repository_id, '') index —
-- the empty string is the general-documents scope — and the channel reference
-- becomes a plain foreign key on the already-unique channel id.
CREATE TABLE channel_slugs_new (
	id text NOT NULL PRIMARY KEY,
	repository_id text,
	slug text NOT NULL,
	channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
	canonical boolean NOT NULL,
	created_at timestamptz NOT NULL
);

INSERT INTO channel_slugs_new (id, repository_id, slug, channel_id, canonical, created_at)
	SELECT channel_id || ':' || slug, repository_id, slug, channel_id, canonical, created_at
	FROM channel_slugs;

DROP TABLE channel_slugs;
ALTER TABLE channel_slugs_new RENAME TO channel_slugs;

CREATE UNIQUE INDEX channel_slugs_scope_slug
	ON channel_slugs (COALESCE(repository_id, ''), slug);
CREATE UNIQUE INDEX channel_slugs_canonical
	ON channel_slugs (channel_id) WHERE canonical;
CREATE INDEX channel_slugs_channel ON channel_slugs (channel_id);

-- Invite links. Only the SHA-256 of the bearer token is stored; the raw token
-- appears once, in the URL handed out at creation. Rotation revokes the old
-- row and inserts a new one, so a channel has at most one live invite.
CREATE TABLE channel_invites (
	id text PRIMARY KEY,
	channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
	token_hash text NOT NULL UNIQUE,
	created_by text NOT NULL,
	created_at timestamptz NOT NULL,
	revoked_at timestamptz
);

CREATE UNIQUE INDEX channel_invites_one_live_per_channel
	ON channel_invites (channel_id)
	WHERE revoked_at IS NULL;

-- Who has joined a general document by holding its invite. This is the
-- standing authorization the open WebSocket rechecks, in place of the
-- repository role a general document does not have.
CREATE TABLE channel_members (
	channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
	user_id text NOT NULL,
	invite_id text NOT NULL REFERENCES channel_invites(id) ON DELETE CASCADE,
	joined_at timestamptz NOT NULL,
	PRIMARY KEY (channel_id, user_id)
);

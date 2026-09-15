-- Invite links become recoverable: a general document's "View link" must read
-- the live link back, which the token hash alone cannot do. The raw token is
-- stored as an AES-256-GCM envelope (sealed at the HTTP layer with the
-- deployment key), never in the clear; the hash stays for join lookups.
ALTER TABLE channel_invites ADD COLUMN token_envelope bytea;

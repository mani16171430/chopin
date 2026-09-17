import type {
	AddUserProject,
	AddUserProjectResult,
	AgentState,
	AppendBackgroundJobProgress,
	AppendResearchAgentMessage,
	AppendResearchAgentMessageResult,
	AppendResearchTurn,
	AppendResearchTurnResult,
	BackgroundJob,
	BackgroundJobCursor,
	BackgroundJobDetail,
	BackgroundJobPage,
	CadenceUpdate,
	CancelBackgroundJob,
	ChannelAgent,
	ChannelArchiveInput,
	ChannelArchiveResult,
	ChannelInvite,
	ChannelLink,
	ChannelMcp,
	ChannelMcpCredential,
	ChannelPage,
	ChannelRecord,
	ChannelScanCursor,
	ChannelScanPage,
	ClaimBackgroundJobs,
	CommitChannel,
	CommitResult,
	CompareNavigationResult,
	ConfirmResearchWorkspace,
	ConfirmResearchWorkspaceResult,
	CreateChannel,
	CreateChannelInvite,
	CreateChannelMcp,
	CreateResearchWorkspace,
	CreateResearchWorkspaceResult,
	CreateWebSession,
	EnqueueBackgroundJob,
	FailBackgroundJob,
	Lease,
	LinkResearchTurnJob,
	LinkResearchTurnJobResult,
	NewChannelLink,
	PauseBackgroundJob,
	ProposedCadenceUpdate,
	PublishChannelDescription,
	PublishChannelDescriptionResult,
	PublishInitialResearchReport,
	PublishInitialResearchReportResult,
	PutUser,
	RecordNavigationVisit,
	RenameChannel,
	RenameResult,
	RenewBackgroundJob,
	ReplaceChannel,
	RequeueBackgroundJob,
	ResearchTurn,
	ResearchWorkspaceDetail,
	ResearchWorkspaceRepositoryList,
	ResearchWorkspaceSummary,
	ResetInitialResearchAttempt,
	ResetInitialResearchAttemptResult,
	ResumeBackgroundJob,
	SaveCheckpoint,
	SettleBackgroundJob,
	StartResearchWorkspace,
	StartResearchWorkspaceResult,
	StoredChannel,
	SupersedeBackgroundJob,
	UpdateAgentContext,
	UpsertChannelMcpCredential,
	UserNavigation,
	UserNavigationSnapshot,
	UserProject,
	UserRecord,
	WebSession,
} from "./model";

export interface UserStore {
	put(user: PutUser): Promise<UserRecord>;
	get(id: string): Promise<UserRecord | undefined>;
}

export interface SessionStore {
	create(session: CreateWebSession): Promise<void>;
	get(id: string, now: Date): Promise<WebSession | undefined>;
	delete(id: string): Promise<boolean>;
	deleteExpired(now: Date): Promise<number>;
	deleteAll(
		now: Date,
		lease: Lease,
		leaseTtlMs: number,
	): Promise<{ deleted: number; lease: Lease }>;
}

export interface NavigationStore {
	snapshot(userId: string): Promise<UserNavigationSnapshot>;
	projects(userId: string): Promise<UserProject[]>;
	firstDocument(userId: string, repositoryIds: string[]): Promise<string | undefined>;
	addProject(input: AddUserProject): Promise<AddUserProjectResult>;
	get(userId: string): Promise<UserNavigation | undefined>;
	setLastDocument(
		userId: string,
		documentId: string | undefined,
		now: Date,
	): Promise<UserNavigation>;
	setLastDocumentIfCurrent(
		userId: string,
		expectedRevision: number | undefined,
		documentId: string | undefined,
		now: Date,
	): Promise<CompareNavigationResult>;
	recordVisit(input: RecordNavigationVisit): Promise<UserNavigation>;
}

export interface ChannelStore {
	/** Creates a top-level channel or one repository-local, non-recursive child. */
	create(input: CreateChannel): Promise<ChannelRecord>;
	get(id: string): Promise<ChannelRecord | undefined>;
	resolve(repositoryId: string | null, slug: string): Promise<ChannelRecord | undefined>;
	rename(channel: RenameChannel): Promise<RenameResult>;
	archive(input: ChannelArchiveInput): Promise<ChannelArchiveResult>;
	restore(input: ChannelArchiveInput): Promise<ChannelArchiveResult>;
	delete(id: string): Promise<boolean>;
	publishDescription(input: PublishChannelDescription): Promise<PublishChannelDescriptionResult>;
	list(
		repositoryId: string,
		limit: number,
		after?: {
			updatedAt: Date;
			id: string;
		},
		query?: string,
		includeArchived?: boolean,
	): Promise<ChannelPage>;
	scan(
		repositoryId: string,
		limit: number,
		after?: ChannelScanCursor,
		includeArchived?: boolean,
	): Promise<ChannelScanPage>;
	claimAgentOwner(channelId: string, sessionId: string, now: Date): Promise<AgentState>;
	clearAgentOwner(
		channelId: string,
		expectedSessionId: string,
		expectedGeneration: number,
		now: Date,
	): Promise<boolean>;
	updateAgentContext(context: UpdateAgentContext): Promise<AgentState>;
	readAgent(channelId: string, now: Date): Promise<ChannelAgent | undefined>;
}

/**
 * Invite links on general documents, and the members who joined by holding
 * one. The store only ever sees the token's SHA-256; the raw bearer token
 * never crosses this boundary.
 */
export interface ChannelInviteStore {
	/** Revokes any live invite and mints a new one, atomically. */
	mint(input: CreateChannelInvite): Promise<ChannelInvite>;
	/** The live invite for a channel, if one exists. */
	live(channelId: string): Promise<ChannelInvite | undefined>;
	/** Resolve a presented token's hash to its invite, only while it is live. */
	resolve(tokenHash: string): Promise<ChannelInvite | undefined>;
	/**
	 * Write a fresh token onto the live invite without revoking it. Self-heals a
	 * row written before tokens were recoverable: the link changes (the hash and
	 * envelope move together), membership and liveness are untouched. Returns the
	 * updated invite, or undefined when the channel has no live invite.
	 */
	reseal(
		channelId: string,
		tokenHash: string,
		tokenEnvelope: Uint8Array,
	): Promise<ChannelInvite | undefined>;
	revoke(id: string, now: Date): Promise<boolean>;
	/** Record that a user joined a channel by holding the invite. Idempotent. */
	join(member: { channelId: string; userId: string; inviteId: string; now: Date }): Promise<void>;
	/** Whether a user currently holds membership in a channel. */
	isMember(channelId: string, userId: string): Promise<boolean>;
	/** The channels a user holds membership in (drives the General Documents list). */
	channelsJoinedBy(userId: string): Promise<string[]>;
}

export interface CollaborationStore {
	load(channelId: string, now: Date): Promise<StoredChannel | undefined>;
	commit(input: CommitChannel): Promise<CommitResult>;
	replace(input: ReplaceChannel): Promise<CommitResult>;
	checkpoint(input: SaveCheckpoint): Promise<void>;
}

export interface LeaseStore {
	acquire(name: string, owner: string, ttlMs: number): Promise<Lease | undefined>;
	renew(lease: Lease, ttlMs: number): Promise<Lease | undefined>;
	release(lease: Lease): Promise<boolean>;
}

export interface BackgroundJobStore {
	enqueue(input: EnqueueBackgroundJob): Promise<{ job: BackgroundJob; repeated: boolean }>;
	claim(input: ClaimBackgroundJobs): Promise<BackgroundJob[]>;
	renew(input: RenewBackgroundJob): Promise<BackgroundJob>;
	appendProgress(input: AppendBackgroundJobProgress): Promise<BackgroundJob>;
	requeue(input: RequeueBackgroundJob): Promise<BackgroundJob>;
	settle(input: SettleBackgroundJob): Promise<BackgroundJobDetail>;
	pause(input: PauseBackgroundJob): Promise<BackgroundJob>;
	resume(input: ResumeBackgroundJob): Promise<BackgroundJob>;
	fail(input: FailBackgroundJob): Promise<BackgroundJob>;
	cancel(input: CancelBackgroundJob): Promise<BackgroundJob>;
	supersede(input: SupersedeBackgroundJob): Promise<BackgroundJob>;
	list(
		channelId: string,
		limit: number,
		after?: BackgroundJobCursor,
	): Promise<BackgroundJobPage | undefined>;
	get(channelId: string, jobId: string): Promise<BackgroundJobDetail | undefined>;
}

export interface ResearchWorkspaceStore {
	create(input: CreateResearchWorkspace): Promise<CreateResearchWorkspaceResult>;
	start(input: StartResearchWorkspace): Promise<StartResearchWorkspaceResult>;
	confirm(input: ConfirmResearchWorkspace): Promise<ConfirmResearchWorkspaceResult>;
	appendTurn(input: AppendResearchTurn): Promise<AppendResearchTurnResult>;
	linkJob(input: LinkResearchTurnJob): Promise<LinkResearchTurnJobResult>;
	resetInitialAttempt(
		input: ResetInitialResearchAttempt,
	): Promise<ResetInitialResearchAttemptResult>;
	appendAgentMessage(
		input: AppendResearchAgentMessage,
	): Promise<AppendResearchAgentMessageResult>;
	publishInitialReport(
		input: PublishInitialResearchReport,
	): Promise<PublishInitialResearchReportResult>;
	list(channelId: string, limit: number): Promise<ResearchWorkspaceSummary[]>;
	listRepository(
		repositoryId: string,
		limit: number,
		includeArchived?: boolean,
	): Promise<ResearchWorkspaceRepositoryList>;
	get(channelId: string, workspaceId: string): Promise<ResearchWorkspaceDetail | undefined>;
	findTurnByJob(channelId: string, jobId: string): Promise<ResearchTurn | undefined>;
}

/**
 * Channel-scoped MCP servers and each member's own credential for them.
 *
 * Definitions are shared by the channel; credentials are per (channel, name,
 * principal) and stored sealed — the store never returns decrypted credentials.
 */
export interface ChannelMcpStore {
	add(input: CreateChannelMcp): Promise<ChannelMcp>;
	remove(channelId: string, name: string): Promise<boolean>;
	list(channelId: string): Promise<ChannelMcp[]>;
	get(channelId: string, name: string): Promise<ChannelMcp | undefined>;
	setCredential(input: UpsertChannelMcpCredential): Promise<ChannelMcpCredential>;
	clearCredential(channelId: string, name: string, principalId: string): Promise<boolean>;
	credential(
		channelId: string,
		name: string,
		principalId: string,
	): Promise<ChannelMcpCredential | undefined>;
	credentials(channelId: string, principalId: string): Promise<ChannelMcpCredential[]>;
}

/**
 * Channel-scoped Cadence work-item proposals.
 *
 * The agent regenerates the whole list at once (`replaceAll`); members then
 * edit fields, set status, or record a push result on individual items. Items
 * are non-secret and returned in the clear, ordered by team then title.
 */
export interface CadenceUpdateStore {
	list(channelId: string): Promise<CadenceUpdate[]>;
	get(channelId: string, id: string): Promise<CadenceUpdate | undefined>;
	replaceAll(
		channelId: string,
		items: ProposedCadenceUpdate[],
		now: Date,
	): Promise<CadenceUpdate[]>;
	/**
	 * Upsert a passage-scoped set into the list rather than regenerating it.
	 *
	 * An incoming item matches an existing one on `(team, kind, title, op)` —
	 * and for op "update" also `targetId` — and is written over it in place,
	 * keeping the existing id; a non-matching item is appended. Returns the
	 * full resulting list, ordered by team then title.
	 */
	merge(
		channelId: string,
		items: ProposedCadenceUpdate[],
		now: Date,
	): Promise<CadenceUpdate[]>;
	updateFields(
		channelId: string,
		id: string,
		patch: {
			team?: string;
			title?: string;
			fields?: Record<string, unknown>;
			status?: CadenceUpdate["status"];
			updatedBy?: string;
		},
		now: Date,
	): Promise<CadenceUpdate | undefined>;
	setStatus(
		channelId: string,
		id: string,
		status: CadenceUpdate["status"],
		result: { pushedUrl?: string; error?: string; targetId?: string },
		now: Date,
	): Promise<CadenceUpdate | undefined>;
	remove(channelId: string, id: string): Promise<boolean>;
}

/**
 * Channel-scoped relation links — the "Links" graph's durable edge set.
 *
 * The planner adds them; members remove them. `add` is idempotent on the
 * (channel, kind, refKey) identity: re-adding a known link refreshes its card
 * fields rather than creating a duplicate. Links are non-secret, returned in
 * the clear, ordered by kind then title.
 */
export interface ChannelLinkStore {
	list(channelId: string): Promise<ChannelLink[]>;
	/** Insert or refresh a link; returns the stored row (existing id kept). */
	add(channelId: string, link: NewChannelLink, now: Date): Promise<ChannelLink>;
	remove(channelId: string, id: string): Promise<boolean>;
}

/** The complete durable boundary. No provider-specific primitive crosses it. */
export interface StorageAdapter {
	readonly driver: string;
	readonly users: UserStore;
	readonly sessions: SessionStore;
	readonly navigation: NavigationStore;
	readonly channels: ChannelStore;
	readonly collaboration: CollaborationStore;
	readonly leases: LeaseStore;
	readonly jobs: BackgroundJobStore;
	readonly research: ResearchWorkspaceStore;
	readonly channelMcps: ChannelMcpStore;
	readonly cadence: CadenceUpdateStore;
	readonly invites: ChannelInviteStore;
	readonly links: ChannelLinkStore;

	migrate(): Promise<void>;
	health(): Promise<void>;
	close(): Promise<void>;
}

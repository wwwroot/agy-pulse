export type ShellId =
  | 'auto'
  | 'pwsh'
  | 'powershell'
  | 'git-bash'
  | 'wsl'
  | 'cmd'
  | 'bash'
  | 'zsh'
  | 'sh'

export type ConcreteShellId = Exclude<ShellId, 'auto'>

export interface ShellInfo {
  id: ConcreteShellId
  label: string
  executable: string
  version?: string
  available: boolean
  isDefault?: boolean
  notes?: string
}

export type EffectState = 'none' | 'applied' | 'partial' | 'unknown'

export interface FailureInfo {
  code: string
  message: string
  effectState: EffectState
  retry: 'never' | 'after-input-change' | 'safe'
  nextAction: string
}

export interface JsonDigest {
  kind: 'object' | 'array'
  totalBytes: number
  summary: string
  preview: string
  fullRefId?: string
  fullPath?: string
}

export type GoogleAiPlanId = 'none' | 'plus' | 'pro' | 'ultra-5x' | 'ultra-20x'

export interface ModelPricingOverride {
  inputPerMillion: number
  cacheReadPerMillion: number
  outputPerMillion: number
}

export type CostPricingOverrides = Record<string, ModelPricingOverride>

export interface TerminalConfig {
  defaultShell: ShellId
  defaultTimeoutMs: number
  maxTimeoutMs: number
  maxInlineBytes: number
  maxSpillBytes: number
  autoPromoteOnTimeout: boolean
  enableReadDedup: boolean
  enableJsonDigest: boolean
  enableCredentialFence: boolean
  enableDownloadGuard: boolean
  downloadGuardTemplate: string
  spillRetentionDays: number
  spillMaxTotalMb: number
  sessionRetentionDays: number
  sessionMaxCount: number
  googleAiPlan: GoogleAiPlanId
  costPricingOverrides: CostPricingOverrides
}

export const DEFAULT_TERMINAL_CONFIG: TerminalConfig = {
  defaultShell: 'auto',
  defaultTimeoutMs: 30_000,
  // Capped at 165 s (< Antigravity's 180 s MCP tool timeout) so foreground commands
  // auto-promote into unbounded background jobs before the host aborts the call.
  maxTimeoutMs: 165_000,
  maxInlineBytes: 7_800,
  maxSpillBytes: 10 * 1024 * 1024,
  autoPromoteOnTimeout: true,
  enableReadDedup: true,
  enableJsonDigest: true,
  enableCredentialFence: true,
  enableDownloadGuard: false,
  downloadGuardTemplate: '',
  spillRetentionDays: 7,
  spillMaxTotalMb: 256,
  sessionRetentionDays: 14,
  sessionMaxCount: 30,
  googleAiPlan: 'pro',
  costPricingOverrides: {},
}

export interface ExecRequest {
  description?: string
  command?: string
  scriptPath?: string
  shell?: ShellId
  workdir?: string
  timeoutMs?: number
  graceMs?: number
  runInBackground?: boolean
  env?: Record<string, string>
  includeDiagnostics?: boolean
  mirrorToActivity?: boolean
}

export interface ExecOutcome {
  status: 'completed' | 'failed' | 'running' | 'promoted' | 'rejected' | 'cancelled'
  kind: 'foreground' | 'background' | 'promoted'
  id: string
  jobId?: string
  description: string
  shell: string
  cwd: string
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  cancelled: boolean
  durationMs: number
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  refId?: string
  spillPath?: string
  jsonDigest?: JsonDigest
  guidance?: string
  failure?: FailureInfo
}

export interface JobSummary {
  id: string
  sessionId?: string
  description: string
  shell: string
  cwd: string
  commandPreview: string
  status: 'running' | 'completed' | 'failed' | 'killed'
  exitCode: number | null
  signal: string | null
  startedAt: number
  endedAt?: number
  durationMs: number
  promotedFromForeground: boolean
  stdoutBytes: number
  stderrBytes: number
  refId?: string
}

export interface JobOutputResponse {
  job: JobSummary
  stdout: string
  stderr: string
  nextStdoutOffset: number
  nextStderrOffset: number
  eof: boolean
  truncated: boolean
}

export interface ResultPageRequest {
  refId: string
  offset?: number
  limit?: number
  maxBytes?: number
  search?: string
  caseInsensitive?: boolean
  stream?: 'stdout' | 'stderr' | 'combined'
}

export interface ResultPageResponse {
  refId: string
  totalLines: number
  totalBytes: number
  offset: number
  returnedLines: number
  nextOffset: number | null
  complete: boolean
  content: string
  meta: Record<string, unknown>
}

export interface ReadFileRangeSpec {
  path: string
  offset?: number
  limit?: number
  view?: 'text' | 'hex' | 'outline'
  symbol?: string
}

export interface ReadFilesRequest {
  files: ReadFileRangeSpec[]
  force?: boolean
  statOnly?: boolean
}

export interface ReadFileItemResult {
  path: string
  exists: boolean
  isDir?: boolean
  bytes: number
  lineCount: number | null
  revision: string
  mtimeMs?: number
  view: 'text' | 'hex' | 'outline' | 'symbol' | 'stat'
  symbol?: string
  fullFileBytes?: number
  offset: number
  returnedLines: number
  nextOffset: number | null
  eof: boolean
  escaped?: boolean
  deduplicated?: boolean
  content: string
  error?: FailureInfo
}

export interface ReadFilesOutcome {
  status: 'completed' | 'partial' | 'failed' | 'rejected'
  baseDir?: string
  items: ReadFileItemResult[]
  durationMs: number
  rawBytes: number
  deliveredBytes: number
  savedBytes: number
  dedupHits: number
  refId?: string
  spillPath?: string
  failure?: FailureInfo
}

export interface SearchRequest {
  action: 'glob' | 'fuzzy' | 'grep' | 'git_status' | 'git_diff'
  path?: string
  pattern?: string | string[]
  glob?: string[]
  kind?: 'file' | 'directory' | 'all'
  sort?: 'path' | 'modified'
  outputMode?: 'summary' | 'count' | 'files_with_matches' | 'definitions' | 'content'
  caseInsensitive?: boolean
  beforeContext?: number
  afterContext?: number
  offset?: number
  limit?: number
  includeHidden?: boolean
  staged?: boolean
  baseRef?: string
  includeLockfiles?: boolean
  maxHunkLines?: number
}

export interface SearchEntry {
  path: string
  kind?: string
  bytes?: number
  modifiedMs?: number
  count?: number
  line?: number
  text?: string
  declKind?: string
  before?: string[]
  after?: string[]
}

export interface SearchOutcome {
  status: 'completed' | 'failed' | 'rejected'
  action: 'glob' | 'fuzzy' | 'grep' | 'git_status' | 'git_diff'
  outputMode?: string
  root: string
  totalMatched: number
  totalFilesMatched: number
  filesScanned: number
  definitionMatches?: number
  impliedReferences?: number
  scanComplete: boolean
  truncated: boolean
  nextOffset: number | null
  durationMs: number
  rawBytes: number
  deliveredBytes: number
  savedBytes: number
  entries?: SearchEntry[]
  gitBranch?: string
  gitDirtyFiles?: number
  gitSkippedLockfiles?: string[]
  gitText?: string
  refId?: string
  spillPath?: string
  failure?: FailureInfo
}

export interface MutateEditSpec {
  oldText: string
  newText: string
}

export interface MutateBatchOp {
  op: 'copy' | 'move' | 'remove'
  path: string
  to?: string
}

export interface MutateBatchResultItem {
  index: number
  op: string
  path: string
  to?: string
  status: 'ok' | 'planned' | 'failed'
  error?: string
}

export interface MutateRequest {
  action: 'edit' | 'write' | 'diff' | 'replace' | 'batch'
  path?: string
  content?: string
  expectedRevision?: string
  edits?: MutateEditSpec[]
  pattern?: string
  replacement?: string
  regex?: boolean
  glob?: string[]
  maxReplacements?: number
  operations?: MutateBatchOp[]
  dryRun?: boolean
}

export interface MutateOutcome {
  status: 'completed' | 'planned' | 'failed' | 'rejected'
  action: MutateRequest['action']
  dryRun: boolean
  durationMs: number
  path?: string
  beforeRevision?: string
  afterRevision?: string
  diff?: string
  addedLines?: number
  removedLines?: number
  filesChanged?: number
  totalReplacements?: number
  skippedFiles?: string[]
  batchResults?: MutateBatchResultItem[]
  roundTripsSaved?: number
  refId?: string
  spillPath?: string
  failure?: FailureInfo
}

export interface ReadDocRequest {
  path: string
  format?: 'auto' | 'table' | 'docx' | 'pdf'
  encoding?: 'utf-8' | 'utf-16le' | 'utf-16be'
  header?: boolean
  offset?: number
  limit?: number
}

export interface ReadDocOutcome {
  status: 'completed' | 'failed' | 'rejected'
  path: string
  format: 'table' | 'docx' | 'pdf'
  bytes: number
  totalUnits: number
  unitName: 'rows' | 'paragraphs' | 'pages'
  offset: number
  returnedUnits: number
  nextOffset: number | null
  complete: boolean
  columns?: string[]
  content: string
  durationMs: number
  rawBytes: number
  deliveredBytes: number
  savedBytes: number
  refId?: string
  spillPath?: string
  failure?: FailureInfo
}

export type SavingsCategory =
  | 'read-dedup'
  | 'batch-read'
  | 'grep-progressive'
  | 'json-digest'
  | 'spillover'
  | 'batch-mutate'
  | 'native-doc'
  | 'outline-read'
  | 'symbol-read'
  | 'git-compact'

export interface SavingsCategoryBreakdown {
  calls: number
  savedBytes: number
  estimatedTokensSaved: number
  roundTripsSaved?: number
}

export interface TokenSavingsSummary {
  totalCalls: number
  totalRawBytes: number
  totalDeliveredBytes: number
  totalSavedBytes: number
  estimatedTokensSaved: number
  roundTripsSaved: number
  dedupHits: number
  avgDurationMs: number
  /** Median (p50) call duration across recent calls in this session */
  medianDurationMs?: number
  /** Average duration of non-shell workspace operations (Rust read/search/mutate/doc) */
  opsAvgDurationMs?: number
  byCategory: Record<SavingsCategory, SavingsCategoryBreakdown>
}

export interface SessionSummary {
  sessionId: string
  label: string
  workspaceRoot?: string
  createdAt: number
  updatedAt: number
  totalCalls: number
  estimatedTokensSaved: number
  totalSavedBytes: number
  totalRawBytes: number
  roundTripsSaved: number
  dedupHits: number
  activeSpills: number
  isCurrent?: boolean
}

export interface ActiveSessionBinding {
  conversationId: string
  workspacePaths?: string[]
  transcriptPath?: string
  updatedAt: number
  toolCallId?: string
}

export interface ConversationContextPoint {
  /** 1-based PLANNER_RESPONSE turn index */
  turn: number
  /** Total context footprint at this turn: uncached input + cache read + output */
  contextTokens: number
  /** Prompt cache_read_tokens on this turn */
  cacheReadTokens: number
  /** Model output_tokens generated on this turn */
  outputTokens: number
  /** Parsed created_at timestamp in ms (0 if missing) */
  ts: number
}

export interface ConversationCostBreakdown {
  totalUsd: number
  inputUsd: number
  cacheReadUsd: number
  cacheWriteUsd: number
  outputUsd: number
  cacheSavingsUsd: number
  lastTurnUsd: number
  totalUncachedInputTokens: number
  totalCacheReadTokens: number
  totalCacheCreationInputTokens: number
  modelRateLabel: string
  inputPerMillion: number
  cacheReadPerMillion: number
  outputPerMillion: number
  estimated: boolean
}

export interface ConversationContextUsage {
  available: boolean
  conversationId: string
  model?: string
  modelLabel?: string
  contextTokens: number
  promptTokens: number
  uncachedInputTokens: number
  cacheCreationInputTokens?: number
  cacheReadTokens: number
  lastOutputTokens: number
  cacheHitPct: number
  contextLimit: number | null
  limitEstimated: boolean
  usagePct: number | null
  remainingTokens: number | null
  peakContextTokens: number
  totalOutputTokens: number
  turnCount: number
  /** Context token delta vs previous turn (negative after compaction; 0 on first turn) */
  lastTurnDeltaTokens: number
  /** Ordered turn-by-turn history (downsampled to <= 120 points preserving turn 1, peak, compaction drops, and latest) */
  timeline: ConversationContextPoint[]
  /** Cumulative API-equivalent cost breakdown across all turns in this conversation */
  cost?: ConversationCostBreakdown
  updatedAt: number
}

export interface QuotaWindow {
  kind: 'short' | 'period'
  label: string
  remaining: number // 0..1
  resetsAt: number | null // epoch ms or null
  periodHours: number
  projectedUnused?: number | null // 0..1
}

export interface QuotaPool {
  id: string
  name: string
  windows: QuotaWindow[]
  disabled?: boolean
}

export interface QuotaSnapshot {
  provider: 'antigravity'
  fetchedAt: number
  source: 'cli' | 'app' | 'none'
  pools: QuotaPool[]
  error?: string
  warnings: string[]
}

export type HostMcpStatus = 'ok' | 'stale' | 'missing' | 'unknown'

export interface HostHealthEntry {
  host: string
  configPath: string
  status: HostMcpStatus
  detail: string
  timeoutSeconds?: number | null
  commandPath?: string
  repairable: boolean
}

export interface HostHealthSnapshot {
  checkedAt: number
  entries: HostHealthEntry[]
  warnings: string[]
}

export interface SidecarNotice {
  id: string
  level: 'info' | 'warn' | 'error'
  title: string
  detail: string
  action?: 'refresh-quotas' | 'repair-host' | 'retry-worker'
}

export interface SpillEntrySummary {
  refId: string
  tool: string
  description: string
  totalBytes: number
  stdoutBytes: number
  stderrBytes: number
  createdAt: number
  sessionId?: string
}

export interface ActivityItem {
  id: string
  kind: 'exec' | 'job' | 'read' | 'search' | 'mutate' | 'doc' | 'result'
  source: 'agent' | 'user'
  description: string
  commandPreview: string
  shell: string
  cwd: string
  status:
    | 'running'
    | 'completed'
    | 'partial'
    | 'planned'
    | 'failed'
    | 'promoted'
    | 'rejected'
    | 'killed'
    | 'cancelled'
  exitCode: number | null
  effectState?: EffectState
  errorCode?: string
  durationMs: number
  startedAt: number
  endedAt?: number
  jobId?: string
  refId?: string
  outputPreview?: string
  savedBytes?: number
  estimatedTokensSaved?: number
  roundTripsSaved?: number
  sessionId?: string
  anomaly: boolean
  acknowledged: boolean
}

export interface DaemonDiscovery {
  pid: number
  port: number
  token: string
  startedAt: number
  version: string
}

export interface SidecarStateSnapshot {
  snapshotVersion?: number
  seq?: number
  workspaceRoots: string[]
  primaryWorkspaceRoot: string
  platform: string
  config: TerminalConfig
  shells: ShellInfo[]
  jobs: JobSummary[]
  activities: ActivityItem[]
  unreadAnomalies: number
  daemonVersion: string
  workerAvailable: boolean
  workerPath?: string
  telemetry: TokenSavingsSummary
  spills: SpillEntrySummary[]
  dedupEntryCount: number
  sessionId: string
  sessionScope: 'conversation' | 'all'
  sessions: SessionSummary[]
  contextWindow?: ConversationContextUsage | null
  projectApiCostUsd?: number
  projectCacheSavingsUsd?: number
  quotas?: QuotaSnapshot | null
  hostHealth?: HostHealthSnapshot | null
  notices?: SidecarNotice[]
}

export type WsClientMessage = { type: 'ping'; ts?: number }

export type WsServerMessage =
  | { type: 'state-update'; state: Partial<SidecarStateSnapshot> }
  | { type: 'activity-event'; item: ActivityItem; unreadAnomalies: number }
  | {
      type: 'telemetry-update'
      telemetry: TokenSavingsSummary
      dedupEntryCount: number
      sessionId?: string
      sessions?: SessionSummary[]
    }
  | { type: 'pong'; ts: number }

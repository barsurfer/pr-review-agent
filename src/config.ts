import 'dotenv/config'
import { tableContextWindow } from './llm/model-id.js'

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function optional(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue
}

// CI passes unset parameters as empty strings, and parseInt('') is NaN, which would silently disable a threshold compared against it.
function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

// Same fallback as reviewbench/entrypoint.mjs, so the breadth time guard and the kill agree on the deadline.
function positiveOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

// Shared by the comma-list env vars and the branch-list CLI overrides, so all parse a value identically.
export function parseBranchList(value: string): string[] {
  return value.split(',').map(p => p.trim()).filter(Boolean)
}

// Models outside the built-in table fall back to 200K; src/llm/context-window.ts can do better for a CLI run.
export function modelContextWindow(model: string): number {
  return tableContextWindow(model) ?? 200_000
}

// Which LLM backend the reviewer/judge use; the seam (src/llm/provider.ts) makes a second provider
// a new impl, not a re-plumb. Anthropic is the native SDK; OpenRouter is the OpenAI-compatible gateway.
const llmProvider = optional('LLM_PROVIDER', 'anthropic') as 'anthropic' | 'openrouter'

// OpenRouter prefers OPENROUTER_API_KEY, else reuses a non-empty ANTHROPIC_API_KEY slot (warned) so a
// run can use a registered bench/CI secret slot that only exposes that name. Anthropic keeps the exact
// ANTHROPIC_API_KEY throw that the entrypoint test and ReviewBench fail-safe rely on.
function resolveLlmApiKey(provider: 'anthropic' | 'openrouter'): string {
  if (provider !== 'openrouter') return required('ANTHROPIC_API_KEY')
  const key = optional('OPENROUTER_API_KEY', '')
  if (key) return key
  const fallback = optional('ANTHROPIC_API_KEY', '')
  if (fallback) {
    console.warn('OPENROUTER_API_KEY not set — using the ANTHROPIC_API_KEY slot as the OpenRouter key')
    return fallback
  }
  throw new Error('Missing required environment variable: OPENROUTER_API_KEY (or ANTHROPIC_API_KEY as a fallback)')
}

export const config = {
  vcsProvider: optional('VCS_PROVIDER', 'bitbucket') as 'bitbucket' | 'github' | 'gitlab' | 'azure' | 'reviewbench',

  llmProvider,
  llmApiKey: resolveLlmApiKey(llmProvider),

  bitbucket: {
    baseUrl: optional('BITBUCKET_BASE_URL', 'https://api.bitbucket.org/2.0'),
    workspace: optional('BITBUCKET_WORKSPACE', ''),
    username: optional('BITBUCKET_USERNAME', ''),
    token: optional('BITBUCKET_TOKEN', ''),
  },

  // Azure DevOps (experimental / WIP). baseUrl defaults to cloud Services; point it at
  // an on-prem Server collection URL for self-hosted. org may be aliased by --workspace.
  azure: {
    baseUrl: optional('AZURE_BASE_URL', 'https://dev.azure.com'),
    org: optional('AZURE_ORG', ''),
    project: optional('AZURE_PROJECT', ''),
    pat: optional('AZURE_PAT', ''),
    accessToken: optional('AZURE_ACCESS_TOKEN', ''),   // OAuth Bearer (e.g. pipeline System.AccessToken); preferred over PAT
  },

  // GitHub (same-repo PRs). owner may be aliased by --workspace; point baseUrl at <host>/api/v3 for GHE.
  github: {
    baseUrl: optional('GITHUB_BASE_URL', 'https://api.github.com'),
    owner: optional('GITHUB_OWNER', ''),
    token: optional('GITHUB_TOKEN', ''),
  },

  // OpenRouter (OpenAI-compatible gateway, when LLM_PROVIDER=openrouter). The key rides llmApiKey;
  // model slugs come from CLAUDE_MODEL/JUDGING_MODEL (e.g. anthropic/claude-sonnet-5, openai/gpt-...).
  openrouter: {
    baseUrl: optional('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1'),
    // Attribution: HTTP-Referer must be non-empty or usage never appears in the OpenRouter dashboard/rankings.
    referer: optional('OPENROUTER_REFERER', 'https://github.com/barsurfer/pr-review-agent'),
    title: optional('OPENROUTER_TITLE', 'pr-review-agent'),
  },

  anthropic: {
    // Sent as the anthropic-workspace-id header; a user-scoped key (sk-ant-usr-…) 400s without it.
    workspaceId: optional('ANTHROPIC_WORKSPACE_ID', ''),
    model: optional('CLAUDE_MODEL', 'claude-haiku-4-5-20251001'),
    // ReviewBench passes the registered model endpoint here; empty keeps the SDK default.
    baseUrl: optional('RB_MODEL_BASE_URL', ''),
    maxRetries: parseInt(optional('MAX_RETRIES', '3'), 10),
    maxInputTokens: parseInt(optional('MAX_INPUT_TOKENS', '250000'), 10),
    // Output-token cap for reviewer + judge. The Claude 5 family thinks by default and that
    // counts against this budget, so too low a cap truncates (16k cut off Sonnet 5 mid-review).
    maxTokens: parseInt(optional('MAX_OUTPUT_TOKENS', '32000'), 10),
    // Replaces the reviewer's window and stands in for any other model the window table lacks (contextWindowFor); 0 = off.
    modelContextTokens: parseInt(optional('MODEL_CONTEXT_TOKENS', '0'), 10),
  },

  judge: {
    model: optional('JUDGING_MODEL', 'claude-sonnet-5'),   // on by default; set empty to disable
    maxRetries: parseInt(optional('MAX_RETRIES', '3'), 10),
    effort: optional('JUDGE_EFFORT', ''),   // output_config.effort; empty = model default (unsent)
    // Off by default: each keeps findings today's judge drops, so turning one on means more (mostly LOW) comments.
    policy: {
      keepMinor: optional('ENABLE_JUDGE_KEEP_MINOR', 'false') === 'true',
      keepUnverified: optional('ENABLE_JUDGE_KEEP_UNVERIFIED', 'false') === 'true',
    },
    // Off by default: sending the reviewer's file context roughly doubles judge input tokens.
    fileContext: optional('ENABLE_JUDGE_FILE_CONTEXT', 'false') === 'true',
    // Off by default: narrow low_value evidence check, same-file duplicate validation and guarded per-file expansion; still one judge call.
    quality: optional('ENABLE_JUDGE_QUALITY', 'false') === 'true',
    // Off by default: lets breadth/second-look/judge anchors land on unchanged lines the model was actually shown.
    shownAnchors: optional('ENABLE_JUDGE_SHOWN_CONTEXT_ANCHORS', 'false') === 'true',
    // Off by default: extra judge output tokens per kept finding.
    proposals: optional('ENABLE_JUDGE_PROPOSALS', 'false') === 'true',
    // Off by default: it changes the judge prompt and posts code whose fix quality is unmeasured.
    suggestedFixes: optional('ENABLE_SUGGESTED_FIXES', 'false') === 'true',
  },

  // Off by default: a second reviewer-sized call. The model is resolved at run time (empty → the judge model) so benchmark labels apply.
  breadth: {
    enabled: optional('ENABLE_BREADTH_REVIEW', 'false') === 'true',
    model: optional('BREADTH_MODEL', ''),
    effort: optional('BREADTH_EFFORT', ''),
    minFiles: finiteOr(parseInt(optional('BREADTH_MIN_FILES', '5'), 10), 5),
    minUntouched: finiteOr(parseInt(optional('BREADTH_MIN_UNTOUCHED', '3'), 10), 3),
    benchmarkDeadlineSeconds: positiveOr(Number(optional('BENCHMARK_DEADLINE_SECONDS', '840')), 840),
    // Off by default: pick the listed untouched targets by subsystem diversity and substance instead of diff order.
    priorityTargets: optional('ENABLE_BREADTH_PRIORITY_TARGETS', 'false') === 'true',
  },

  // Off by default (each lens is another reviewer-sized call); the list stays raw so a benchmark label can overwrite it after load.
  lenses: {
    enabled: optional('ENABLE_LENSES', 'false') === 'true',
    list: optional('LENSES', ''),
    model: optional('LENS_MODEL', ''),
    recommend: optional('ENABLE_LENS_RECOMMENDATION', 'false') === 'true',
  },

  agentIdentity: process.env.AGENT_IDENTITY || process.env.BITBUCKET_USERNAME || 'Claude',
  // Reviewed repo slug — set from --repo-slug at runtime; sent as OpenRouter's `user` for segmentation.
  repoSlug: optional('REPO_SLUG', ''),

  reply: {
    maxComments: parseInt(optional('MAX_REPLY_COMMENTS', '5'), 10),
    // Answering a dev question needs less than reviewer-grade depth; route replies to a cheaper model. Empty = reviewer model.
    model: optional('REPLY_MODEL', ''),
    // Off by default (Bitbucket only): skip replying to a dev comment @-directed solely at someone else.
    skipDirectedElsewhere: optional('SKIP_DIRECTED_REPLIES', 'false') === 'true',
  },

  trigger: {
    event: optional('TRIGGER_EVENT', '').trim(),
    commentAuthor: optional('TRIGGER_COMMENT_AUTHOR', '').trim(),
    ignoreCommentAuthors: parseBranchList(optional('IGNORE_COMMENT_AUTHORS', '')),
  },

  triggerEventKind: optional('TRIGGER_EVENT_KIND', '').trim(),

  review: {
    maxFindings: parseInt(optional('MAX_FINDINGS', '0'), 10),   // 0 = unlimited
    splitCheck: optional('ENABLE_SPLIT_CHECK', 'true') !== 'false',
    todoScan: optional('ENABLE_TODO_SCAN', 'true') !== 'false',
    effort: optional('REVIEW_EFFORT', ''),   // output_config.effort; empty = model default (unsent)
    // Off by default: each bundle costs a reviewer + judge call, so a huge PR is a real spend.
    bundledReview: optional('ENABLE_BUNDLED_REVIEW', 'false') === 'true',
    maxBundles: parseInt(optional('MAX_BUNDLES', '8'), 10),   // 0 = unlimited
    // Off by default: lets the reviewer emit real-but-minor findings; posting them still needs ENABLE_JUDGE_KEEP_MINOR (policy drops minor otherwise).
    enableNitpicks: optional('ENABLE_NITPICKS', 'false') === 'true',
    // Off by default: a second reviewer pass over files that already got findings, excluding known ones, to lift recall.
    secondLook: optional('ENABLE_SECOND_LOOK', 'false') === 'true',
    // Off by default: second-look also re-reads files that only the breadth pass flagged.
    secondLookBreadthTargets: optional('ENABLE_SECOND_LOOK_BREADTH_TARGETS', 'false') === 'true',
    // On by default: without numbered lines ~40% of findings carried no line; set false to send the raw diff/context (saves the per-line gutter tokens).
    lineNumbers: optional('ENABLE_LINE_NUMBERS', 'true') !== 'false',
  },

  context: {
    maxFiles: parseInt(optional('MAX_CONTEXT_FILES', '20'), 10),
    maxFileLines: parseInt(optional('MAX_FILE_LINES', '500'), 10),
  },

  skipSourceBranches: parseBranchList(optional('SKIP_SOURCE_BRANCHES', 'main,master,release/*,hotfix/*')),

  skipTargetBranches: parseBranchList(optional('SKIP_TARGET_BRANCHES', 'main,master')),

  // Skipping stacked PRs until they are retargeted gives them one review instead of one per push.
  onlyTargetBranches: parseBranchList(optional('ONLY_TARGET_BRANCHES', '')),

  lastCheckedCommit: optional('LAST_CHECKED_COMMIT', '').trim(),

  usageRecordFile: optional('USAGE_RECORD_FILE', '').trim(),

  diffExcludePatterns: optional('DIFF_EXCLUDE_PATTERNS', '*.lock,package-lock.json,yarn.lock,pnpm-lock.yaml,*.json,*.spec.ts')
    .split(',')
    .map(p => p.trim())
    .filter(Boolean),

  thresholds: {
    minChangedFiles: parseInt(optional('MIN_CHANGED_FILES', '0'), 10),
    maxChangedFiles: parseInt(optional('MAX_CHANGED_FILES', '200'), 10),
    minChangedLines: parseInt(optional('MIN_CHANGED_LINES', '0'), 10),
    maxChangedLines: parseInt(optional('MAX_CHANGED_LINES', '3000'), 10),
  },
}

export function validateBitbucketConfig(): void {
  if (!config.bitbucket.workspace) throw new Error('Missing required environment variable: BITBUCKET_WORKSPACE')
  if (!config.bitbucket.username) throw new Error('Missing required environment variable: BITBUCKET_USERNAME')
  if (!config.bitbucket.token) throw new Error('Missing required environment variable: BITBUCKET_TOKEN')
}

export function validateGitHubConfig(): void {
  if (!config.github.owner) throw new Error('Missing required environment variable: GITHUB_OWNER')
  if (!config.github.token) throw new Error('Missing required environment variable: GITHUB_TOKEN')
}

export function validateAzureConfig(): void {
  if (!config.azure.org) throw new Error('Missing required environment variable: AZURE_ORG')
  if (!config.azure.project) throw new Error('Missing required environment variable: AZURE_PROJECT')
  // At least one credential: AZURE_ACCESS_TOKEN (Bearer) or AZURE_PAT (Basic).
  if (!config.azure.pat && !config.azure.accessToken) {
    throw new Error('Missing required environment variable: AZURE_PAT or AZURE_ACCESS_TOKEN')
  }
}

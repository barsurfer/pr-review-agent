import 'dotenv/config'

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function optional(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue
}

// Context windows (max_input_tokens, from the Models API): 4.5-gen = 200K, 4.6+/5.x = 1M; matched by id prefix, unknown models fall back to 200K.
const MODEL_CONTEXT_WINDOWS: readonly [string, number][] = [
  ['claude-haiku-4-5', 200_000],
  ['claude-sonnet-4-5', 200_000],
  ['claude-opus-4-5', 200_000],
  ['claude-haiku-5', 1_000_000],
  ['claude-sonnet-4-6', 1_000_000],
  ['claude-sonnet-5', 1_000_000],
  ['claude-opus-4-6', 1_000_000],
  ['claude-opus-4-7', 1_000_000],
  ['claude-opus-4-8', 1_000_000],
  ['claude-opus-5', 1_000_000],
  ['claude-fable-5', 1_000_000],
  ['claude-mythos-5', 1_000_000],
]

export function modelContextWindow(model: string): number {
  return MODEL_CONTEXT_WINDOWS.find(([prefix]) => model.startsWith(prefix))?.[1] ?? 200_000
}

export const config = {
  vcsProvider: optional('VCS_PROVIDER', 'bitbucket') as 'bitbucket' | 'github' | 'gitlab' | 'azure' | 'reviewbench',

  // Which LLM backend the reviewer/judge use. Only 'anthropic' is implemented; the seam
  // (src/llm/provider.ts) exists so a second provider is a new impl, not a re-plumb.
  llmProvider: optional('LLM_PROVIDER', 'anthropic') as 'anthropic',

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

  anthropic: {
    apiKey: required('ANTHROPIC_API_KEY'),
    model: optional('CLAUDE_MODEL', 'claude-haiku-4-5-20251001'),
    // ReviewBench passes the registered model endpoint here; empty keeps the SDK default.
    baseUrl: optional('RB_MODEL_BASE_URL', ''),
    maxRetries: parseInt(optional('MAX_RETRIES', '3'), 10),
    maxInputTokens: parseInt(optional('MAX_INPUT_TOKENS', '250000'), 10),
    // Output-token cap for reviewer + judge. The Claude 5 family thinks by default and that
    // counts against this budget, so too low a cap truncates (16k cut off Sonnet 5 mid-review).
    maxTokens: parseInt(optional('MAX_OUTPUT_TOKENS', '32000'), 10),
    // Override for the model's context window; 0 = derive from the model id (modelContextWindow).
    modelContextTokens: parseInt(optional('MODEL_CONTEXT_TOKENS', '0'), 10),
  },

  judge: {
    model: optional('JUDGING_MODEL', 'claude-sonnet-5'),   // on by default; set empty to disable
    maxRetries: parseInt(optional('MAX_RETRIES', '3'), 10),
    effort: optional('JUDGE_EFFORT', ''),   // output_config.effort; empty = model default (unsent)
  },

  agentIdentity: process.env.AGENT_IDENTITY || process.env.BITBUCKET_USERNAME || 'Claude',

  reply: {
    maxComments: parseInt(optional('MAX_REPLY_COMMENTS', '5'), 10),
  },

  review: {
    maxFindings: parseInt(optional('MAX_FINDINGS', '0'), 10),   // 0 = unlimited
    splitCheck: optional('ENABLE_SPLIT_CHECK', 'true') !== 'false',
    todoScan: optional('ENABLE_TODO_SCAN', 'true') !== 'false',
    effort: optional('REVIEW_EFFORT', ''),   // output_config.effort; empty = model default (unsent)
    // Off by default: each bundle costs a reviewer + judge call, so a huge PR is a real spend.
    bundledReview: optional('ENABLE_BUNDLED_REVIEW', 'false') === 'true',
    maxBundles: parseInt(optional('MAX_BUNDLES', '8'), 10),   // 0 = unlimited
  },

  context: {
    maxFiles: parseInt(optional('MAX_CONTEXT_FILES', '20'), 10),
    maxFileLines: parseInt(optional('MAX_FILE_LINES', '500'), 10),
  },

  skipSourceBranches: optional('SKIP_SOURCE_BRANCHES', 'main,master,release/*,hotfix/*')
    .split(',').map(p => p.trim()).filter(Boolean),

  skipTargetBranches: optional('SKIP_TARGET_BRANCHES', 'main,master')
    .split(',').map(p => p.trim()).filter(Boolean),

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

export function validateAzureConfig(): void {
  if (!config.azure.org) throw new Error('Missing required environment variable: AZURE_ORG')
  if (!config.azure.project) throw new Error('Missing required environment variable: AZURE_PROJECT')
  // At least one credential: AZURE_ACCESS_TOKEN (Bearer) or AZURE_PAT (Basic).
  if (!config.azure.pat && !config.azure.accessToken) {
    throw new Error('Missing required environment variable: AZURE_PAT or AZURE_ACCESS_TOKEN')
  }
}

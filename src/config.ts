import 'dotenv/config'

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function optional(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue
}

export const config = {
  vcsProvider: optional('VCS_PROVIDER', 'bitbucket') as 'bitbucket' | 'github' | 'gitlab',

  bitbucket: {
    baseUrl: optional('BITBUCKET_BASE_URL', 'https://api.bitbucket.org/2.0'),
    workspace: optional('BITBUCKET_WORKSPACE', ''),
    username: optional('BITBUCKET_USERNAME', ''),
    token: optional('BITBUCKET_TOKEN', ''),
  },

  anthropic: {
    apiKey: required('ANTHROPIC_API_KEY'),
    model: optional('CLAUDE_MODEL', 'claude-sonnet-4-6'),
    maxRetries: parseInt(optional('MAX_RETRIES', '3'), 10),
    maxInputTokens: parseInt(optional('MAX_INPUT_TOKENS', '150000'), 10),
  },

  judge: {
    model: optional('JUDGING_MODEL', ''),
    maxRetries: parseInt(optional('MAX_RETRIES', '3'), 10),
  },

  agentIdentity: process.env.AGENT_IDENTITY || process.env.BITBUCKET_USERNAME || 'Claude',

  context: {
    maxFiles: parseInt(optional('MAX_CONTEXT_FILES', '20'), 10),
    maxFileLines: parseInt(optional('MAX_FILE_LINES', '500'), 10),
  },

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

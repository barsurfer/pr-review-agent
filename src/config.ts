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
    token: optional('BITBUCKET_TOKEN', ''),
  },

  anthropic: {
    apiKey: required('ANTHROPIC_API_KEY'),
    model: optional('CLAUDE_MODEL', 'claude-sonnet-4-6'),
  },

  context: {
    maxFiles: parseInt(optional('MAX_CONTEXT_FILES', '20'), 10),
    maxFileLines: parseInt(optional('MAX_FILE_LINES', '500'), 10),
  },
}

export function validateBitbucketConfig(): void {
  if (!config.bitbucket.workspace) throw new Error('Missing required environment variable: BITBUCKET_WORKSPACE')
  if (!config.bitbucket.token) throw new Error('Missing required environment variable: BITBUCKET_TOKEN')
}

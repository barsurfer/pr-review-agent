import Anthropic from '@anthropic-ai/sdk'
import type { PRInfo } from '../vcs/adapter.js'
import type { FileContext } from '../context/fetcher.js'
import type { LoadedPrompt } from '../prompt/loader.js'

const MAX_TOKENS = 4096

export async function runReview(
  apiKey: string,
  model: string,
  prInfo: PRInfo,
  diff: string,
  fileContexts: FileContext[],
  prompt: LoadedPrompt
): Promise<string> {
  const client = new Anthropic({ apiKey })

  const userMessage = buildUserMessage(prInfo, diff, fileContexts)

  console.log(`Sending request to Claude (${model})...`)

  const response = await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    system: prompt.content,
    messages: [{ role: 'user', content: userMessage }],
  })

  const block = response.content[0]
  if (block.type !== 'text') throw new Error('Unexpected response type from Claude')

  console.log(`Review received (${response.usage.input_tokens} in / ${response.usage.output_tokens} out tokens)`)

  return block.text
}

function buildUserMessage(prInfo: PRInfo, diff: string, fileContexts: FileContext[]): string {
  const parts: string[] = []

  parts.push(`## Pull Request: ${prInfo.title}`)
  parts.push(`## Branch: ${prInfo.sourceBranch} → ${prInfo.targetBranch}`)

  if (prInfo.description) {
    parts.push(`## Description:\n${prInfo.description}`)
  }

  parts.push(`## Diff:\n\`\`\`diff\n${diff}\n\`\`\``)

  if (fileContexts.length > 0) {
    parts.push('## Full file context:')
    for (const file of fileContexts) {
      parts.push(`### ${file.path}\n\`\`\`\n${file.content}\n\`\`\``)
    }
  }

  return parts.join('\n\n')
}

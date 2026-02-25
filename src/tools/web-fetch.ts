import TurndownService from 'turndown'

import type { Tool, ToolResult } from './types.ts'
import { capOutput, DEFAULT_TOOL_TIMEOUT_MS } from './common.ts'

type WebFetchFormat = 'markdown' | 'text' | 'html'

const turndown = new TurndownService()

function normalizeUrl(inputUrl: string): string {
  const upgradedUrl = inputUrl.startsWith('http://')
    ? `https://${inputUrl.slice('http://'.length)}`
    : inputUrl

  const parsedUrl = new URL(upgradedUrl)
  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    throw new Error(`Unsupported URL protocol: ${parsedUrl.protocol}`)
  }

  return parsedUrl.toString()
}

function normalizeFormat(value: unknown): WebFetchFormat {
  if (value === 'text' || value === 'html' || value === 'markdown') {
    return value
  }

  return 'markdown'
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export const webFetchTool: Tool = {
  name: 'web_fetch',
  description: 'Fetch a URL and return content as markdown, text, or html.',
  timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'URL to fetch.',
      },
      format: {
        type: 'string',
        description: 'Response format: markdown, text, or html.',
      },
    },
    required: ['url'],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const inputUrl = args.url as string | undefined
    const format = normalizeFormat(args.format)

    if (!inputUrl) {
      return {
        content: '',
        error: 'Missing required parameter: url',
      }
    }

    let url: string
    try {
      url = normalizeUrl(inputUrl)
    } catch (error) {
      return {
        content: '',
        error: error instanceof Error ? error.message : String(error),
      }
    }

    const controller = new AbortController()
    const timeoutHandle = setTimeout(() => controller.abort(), DEFAULT_TOOL_TIMEOUT_MS)

    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'User-Agent': 'jarvis/1.0',
        },
      })

      if (!response.ok) {
        return {
          content: '',
          error: `Web fetch failed: ${response.status} ${response.statusText}`,
        }
      }

      const body = await response.text()
      const contentType = response.headers.get('content-type') ?? ''
      const isHtml = contentType.includes('text/html') || /<html/i.test(body)

      if (format === 'html') {
        return {
          content: capOutput(body),
        }
      }

      if (format === 'text') {
        return {
          content: capOutput(isHtml ? htmlToText(body) : body),
        }
      }

      return {
        content: capOutput(isHtml ? turndown.turndown(body) : body),
      }
    } catch (error) {
      return {
        content: '',
        error: `Web fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    } finally {
      clearTimeout(timeoutHandle)
    }
  },
}

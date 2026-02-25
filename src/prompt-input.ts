import { readFile } from 'node:fs/promises'

export interface PromptInputOptions {
  message?: string
  filePath?: string
}

export async function buildPromptInput(options: PromptInputOptions): Promise<string> {
  const message = options.message?.trim() ?? ''
  const filePath = options.filePath?.trim()

  let fileContent = ''
  if (filePath) {
    fileContent = await readFile(filePath, 'utf-8')
  }

  if (!message && !fileContent.trim()) {
    throw new Error('Prompt is required. Provide <message>, --file, or both.')
  }

  if (message && filePath) {
    return `${message}\n\n--- File: ${filePath} ---\n${fileContent}`
  }

  if (message) {
    return message
  }

  return fileContent
}

import type { Endpoint, EndpointProfile, OutboundMessage } from './types.ts'

export function createCliEndpoint(): Endpoint {
  const profile: EndpointProfile = {
    kind: 'cli',
    displayName: 'command-line',
    responseStyle: 'Be thorough and detailed. Use full paragraphs and structured formatting.',
    formatting: 'markdown',
  }

  return {
    profile,

    async send(message: OutboundMessage): Promise<void> {
      console.log(message.text)
    },
  }
}

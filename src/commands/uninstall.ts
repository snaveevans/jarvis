import { createInterface } from 'node:readline/promises'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { stdin as input, stdout as output } from 'node:process'
import path from 'node:path'
import os from 'node:os'

const PATH_LINE = 'export PATH="$HOME/.jarvis/bin:$PATH"'

function getShellRcFiles(): string[] {
  const home = os.homedir()
  const candidates = [
    path.join(home, '.bashrc'),
    path.join(home, '.bash_profile'),
    path.join(home, '.zshrc'),
    path.join(home, '.profile'),
  ]
  return candidates.filter(f => existsSync(f))
}

function removePathEntry(filePath: string): boolean {
  const content = readFileSync(filePath, 'utf-8')
  const lines = content.split('\n')
  const filtered = lines.filter(line => {
    const trimmed = line.trim()
    return trimmed !== PATH_LINE && !trimmed.includes('.jarvis/bin')
  })

  if (filtered.length !== lines.length) {
    writeFileSync(filePath, filtered.join('\n'))
    return true
  }
  return false
}

export async function runUninstall(): Promise<void> {
  const jarvisHome = process.env.JARVIS_HOME || process.cwd()

  const rl = createInterface({ input, output })
  try {
    const answer = await rl.question('Uninstall Jarvis? This will remove PATH entries. (y/N): ')
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log('Cancelled.')
      return
    }
  } finally {
    rl.close()
  }

  // Remove PATH entries from shell rc files
  const rcFiles = getShellRcFiles()
  let cleaned = 0
  for (const rcFile of rcFiles) {
    if (removePathEntry(rcFile)) {
      console.log('Cleaned PATH from: ' + rcFile)
      cleaned++
    }
  }

  if (cleaned === 0) {
    console.log('No PATH entries found in shell config files.')
  }

  console.log('')
  console.log('To complete removal, run:')
  console.log('')
  console.log('  rm -rf ' + jarvisHome)
  console.log('')
  console.log('Then restart your shell or run: source ~/.zshrc (or ~/.bashrc)')
}

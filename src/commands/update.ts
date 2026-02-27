import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

export async function runUpdate(): Promise<void> {
  const jarvisHome = process.env.JARVIS_HOME || process.cwd()
  const gitDir = path.join(jarvisHome, '.git')

  if (!existsSync(gitDir)) {
    console.error('Error: Not a git-managed installation.')
    console.error('Update requires a git clone install (e.g. via install.sh).')
    process.exit(1)
  }

  const execOpts = { cwd: jarvisHome, stdio: 'inherit' as const }

  // Check for local modifications
  try {
    const status = execSync('git status --porcelain', { cwd: jarvisHome, encoding: 'utf-8' }).trim()
    if (status) {
      console.error('Error: Local modifications detected. Please commit or stash changes first.')
      console.error('\n' + status)
      process.exit(1)
    }
  } catch {
    console.error('Error: Failed to check git status.')
    process.exit(1)
  }

  const beforeHash = execSync('git rev-parse --short HEAD', { cwd: jarvisHome, encoding: 'utf-8' }).trim()

  console.log('Pulling latest changes...')
  try {
    execSync('git pull --ff-only origin main', execOpts)
  } catch {
    console.error('\nError: Fast-forward pull failed. You may have local commits.')
    console.error('Try: cd ' + jarvisHome + ' && git pull --rebase origin main')
    process.exit(1)
  }

  console.log('\nInstalling dependencies...')
  execSync('npm install --no-audit --no-fund', execOpts)

  console.log('\nBuilding...')
  execSync('npm run build', execOpts)

  const afterHash = execSync('git rev-parse --short HEAD', { cwd: jarvisHome, encoding: 'utf-8' }).trim()

  if (beforeHash === afterHash) {
    console.log('\nAlready up to date. (' + afterHash + ')')
  } else {
    console.log('\nUpdated: ' + beforeHash + ' -> ' + afterHash)
  }
}

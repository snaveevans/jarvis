import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile, mkdir, copyFile } from 'node:fs/promises'
import path from 'node:path'

interface SkillConflict {
  name: string
  customPath: string
  builtinPath: string
}

async function findBuiltinSkills(skillsDir: string): Promise<Set<string>> {
  const builtinNames = new Set<string>()
  try {
    const entries = await readdir(skillsDir)
    for (const entry of entries) {
      if (entry.endsWith('.md')) {
        const name = entry.replace('.md', '')
        builtinNames.add(name)
      }
    }
  } catch {
    // Built-in skills directory doesn't exist
  }
  return builtinNames
}

async function findCustomSkills(customDir: string): Promise<Array<{ name: string, path: string }>> {
  const skills: Array<{ name: string, path: string }> = []
  try {
    const entries = await readdir(customDir)
    for (const entry of entries) {
      if (entry.endsWith('.md') && !entry.startsWith('.')) {
        skills.push({
          name: entry.replace('.md', ''),
          path: path.join(customDir, entry),
        })
      }
    }
  } catch {
    // Custom skills directory doesn't exist
  }
  return skills
}

async function backupSkills(
  conflicts: SkillConflict[],
  backupDir: string
): Promise<void> {
  await mkdir(backupDir, { recursive: true })
  for (const conflict of conflicts) {
    const backupPath = path.join(backupDir, path.basename(conflict.customPath))
    await copyFile(conflict.customPath, backupPath)
  }
}

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

  // Check for custom skills conflicts before update
  const customSkillsDir = path.join(jarvisHome, 'data', 'skills')
  const builtinSkillsDir = path.join(jarvisHome, 'src', 'skills')
  
  const builtinNames = await findBuiltinSkills(builtinSkillsDir)
  const customSkills = await findCustomSkills(customSkillsDir)
  
  const conflicts: SkillConflict[] = []
  for (const skill of customSkills) {
    if (builtinNames.has(skill.name)) {
      conflicts.push({
        name: skill.name,
        customPath: skill.path,
        builtinPath: path.join(builtinSkillsDir, `${skill.name}.md`),
      })
    }
  }

  // Backup conflicting skills before update
  if (conflicts.length > 0) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const backupDir = path.join(customSkillsDir, '.backups', timestamp)
    
    console.log(`\nBacking up ${conflicts.length} conflicting skill(s) to ${backupDir}...`)
    try {
      await backupSkills(conflicts, backupDir)
      console.log('Skills backed up successfully.')
    } catch (error) {
      console.error('\nError: Failed to backup skills.')
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    }
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

  // Report conflicts after update
  if (conflicts.length > 0) {
    console.log('\n--- Skill Conflicts ---')
    console.log('The following custom skills conflict with built-in skills:')
    for (const conflict of conflicts) {
      console.log(`  - ${conflict.name}`)
      console.log(`    Custom:  ${conflict.customPath}`)
      console.log(`    Builtin: ${conflict.builtinPath}`)
    }
    console.log('\nBacked up to: data/skills/.backups/')
    console.log('Review and rename conflicting custom skills to use unique names.')
  }
}

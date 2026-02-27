import assert from 'node:assert'
import { mkdtemp, readFile, rm, writeFile as writeFileFs } from 'node:fs/promises'
import { join } from 'node:path'
import { test, describe } from 'node:test'

import { getWorkspaceRoot } from './common.ts'
import { editTool } from './edit.ts'
import { readTool } from './read.ts'
import { shellTool } from './shell.ts'
import { todoListTool } from './todo-list.ts'
import { writeTool } from './write.ts'

describe('core tool safeguards', () => {
  test('write blocks overwrite until file is read first', async () => {
    const tempDir = await mkdtemp(join(getWorkspaceRoot(), '.tmp-tools-'))
    const filePath = join(tempDir, 'write-guard.txt')

    await writeFileFs(filePath, 'initial', 'utf-8')

    const blockedWrite = await writeTool.execute({
      filePath,
      content: 'updated',
    })
    assert.ok(blockedWrite.error)
    assert.match(blockedWrite.error, /must be read first/)

    const readResult = await readTool.execute({
      filePath,
    })
    assert.equal(readResult.error, undefined)

    const allowedWrite = await writeTool.execute({
      filePath,
      content: 'updated',
    })
    assert.equal(allowedWrite.error, undefined)

    await rm(tempDir, { recursive: true, force: true })
  })

  test('edit enforces exact-match uniqueness unless replaceAll is true', async () => {
    const tempDir = await mkdtemp(join(getWorkspaceRoot(), '.tmp-tools-'))
    const filePath = join(tempDir, 'edit-guard.txt')

    await writeFileFs(filePath, 'hello hello', 'utf-8')
    await readTool.execute({ filePath })

    const blockedEdit = await editTool.execute({
      filePath,
      oldString: 'hello',
      newString: 'hi',
    })
    assert.ok(blockedEdit.error)
    assert.match(blockedEdit.error, /multiple locations/)

    const replaceAllEdit = await editTool.execute({
      filePath,
      oldString: 'hello',
      newString: 'hi',
      replaceAll: true,
    })
    assert.equal(replaceAllEdit.error, undefined)

    const contents = await readFile(filePath, 'utf-8')
    assert.equal(contents, 'hi hi')

    await rm(tempDir, { recursive: true, force: true })
  })

  test('todo_list allows at most one in_progress item', async () => {
    const invalid = await todoListTool.execute({
      items: [
        { content: 'a', status: 'in_progress', priority: 'high' },
        { content: 'b', status: 'in_progress', priority: 'medium' },
      ],
    })
    assert.ok(invalid.error)
    assert.match(invalid.error, /Only one todo item may be in_progress/)

    const valid = await todoListTool.execute({
      items: [
        { content: 'a', status: 'in_progress', priority: 'high' },
        { content: 'b', status: 'pending', priority: 'low' },
      ],
    })
    assert.equal(valid.error, undefined)
  })

  test('todo_list accepts compatibility shape with title/done/id', async () => {
    const result = await todoListTool.execute({
      items: [
        { id: '1', title: 'first item', done: false },
        { id: '2', title: 'second item', done: true },
      ],
    })

    assert.equal(result.error, undefined)
    assert.match(result.content, /\[pending\].*1: first item/)
    assert.match(result.content, /\[completed\].*2: second item/)
  })

  test('shell blocks disallowed command patterns', async () => {
    const blockedVim = await shellTool.execute({
      command: 'vim file.txt',
    })
    assert.ok(blockedVim.error)
    assert.match(blockedVim.error, /Blocked shell command pattern/)

    const blockedForce = await shellTool.execute({
      command: 'git push --force origin main',
    })
    assert.ok(blockedForce.error)
    assert.match(blockedForce.error, /Blocked shell command pattern/)

    const allowed = await shellTool.execute({
      command: 'printf "ok"',
    })
    assert.equal(allowed.error, undefined)
    assert.match(allowed.content, /ok/)

    const allowedCat = await shellTool.execute({
      command: 'cat package.json',
    })
    assert.equal(allowedCat.error, undefined)
  })
})

import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const claudePath = path.join(process.cwd(), '.claude')
const claudeSkillsExist = fs.existsSync(claudePath)

describe.skipIf(!claudeSkillsExist)('skills-pipeline-layout', () => {
  it('the overseer skill names the dedicated consultant tab rule', () => {
    const overseerPath = path.join(process.cwd(), '.claude', 'skills', 'tickmarkr-overseer', 'SKILL.md')
    const content = fs.readFileSync(overseerPath, 'utf-8')
    expect(content).toContain('Dedicated consultant tab')
    expect(content).toMatch(/consultant[s]? .*[p|t]ab/)
  })

  it('the overseer skill names the scoper worktree rule', () => {
    const overseerPath = path.join(process.cwd(), '.claude', 'skills', 'tickmarkr-overseer', 'SKILL.md')
    const content = fs.readFileSync(overseerPath, 'utf-8')
    expect(content).toContain('Scoper worktree rule')
    expect(content).toMatch(/scoper|worktree/)
  })

  it('the loop skill names the dedicated consultant tab rule', () => {
    const loopPath = path.join(process.cwd(), 'skills', 'tickmarkr-loop', 'SKILL.md')
    const content = fs.readFileSync(loopPath, 'utf-8')
    expect(content).toContain('Dedicated consultant tab rule')
    expect(content).toMatch(/consultant[s]? .*[p|t]ab/)
  })

  it('the two loop skill copies are identical', () => {
    const publicLoopPath = path.join(process.cwd(), 'skills', 'tickmarkr-loop', 'SKILL.md')
    const privateLoopPath = path.join(process.cwd(), '.claude', 'skills', 'tickmarkr-loop', 'SKILL.md')

    const publicContent = fs.readFileSync(publicLoopPath, 'utf-8')
    const privateContent = fs.readFileSync(privateLoopPath, 'utf-8')

    expect(publicContent).toBe(privateContent)
  })

  it('the skill layout rules place consultants in a dedicated tab that outlives the orchestrator tab', () => {
    const overseerPath = path.join(process.cwd(), '.claude', 'skills', 'tickmarkr-overseer', 'SKILL.md')
    const loopPath = path.join(process.cwd(), 'skills', 'tickmarkr-loop', 'SKILL.md')

    const overseerContent = fs.readFileSync(overseerPath, 'utf-8')
    const loopContent = fs.readFileSync(loopPath, 'utf-8')

    // Check that both skills mention the dedicated tab outliving the orchestrator
    expect(overseerContent).toMatch(/dedicated.*tab.*(?:persist|outliv|surviv)/i)
    expect(loopContent).toMatch(/dedicated.*tab.*(?:persist|outliv|surviv)/i)
  })

  it('the loop and auto skill files each name an explicit claude launch flag and an explicit codex launch flag instead of one hardcoded permission flag', () => {
    const loopPath = path.join(process.cwd(), 'skills', 'tickmarkr-loop', 'SKILL.md')
    const autoPath = path.join(process.cwd(), 'skills', 'tickmarkr-auto', 'SKILL.md')

    const loopContent = fs.readFileSync(loopPath, 'utf-8')
    const autoContent = fs.readFileSync(autoPath, 'utf-8')

    // Both should mention both claude and codex
    expect(loopContent).toMatch(/(?:claude|claude code)/i)
    expect(loopContent).toMatch(/codex/i)
    expect(autoContent).toMatch(/(?:claude|claude code)/i)
    expect(autoContent).toMatch(/codex/i)

    // Neither should have the old hardcoded bypassPermissions alone
    // (if it appears, it should be part of explicit choice, not the only option)
    expect(loopContent).not.toMatch(/spawn.*--permission-mode bypassPermissions[`"]?\s*[,.)]/)
    expect(autoContent).not.toMatch(/spawn.*--permission-mode bypassPermissions[`"]?\s*[,.)]/)
  })

  it('the overseer skill\'s orchestrator spawn instructions name both a claude and a codex launch form instead of one hardcoded agent binary', () => {
    const overseerPath = path.join(process.cwd(), '.claude', 'skills', 'tickmarkr-overseer', 'SKILL.md')
    const content = fs.readFileSync(overseerPath, 'utf-8')

    // Should not have the old hardcoded "-- claude"
    expect(content).not.toMatch(/-- claude[`"']?\s*\(pin/)

    // Should mention both claude and codex in context of launching orchestrator
    expect(content).toMatch(/(?:claude|claude code).*(?:orchestrator|launch)/i)
    expect(content).toMatch(/codex.*(?:orchestrator|launch)/i)
  })

  it('the named codex launch form matches the exact non-interactive flags already proven for codex as a worker', () => {
    const overseerPath = path.join(process.cwd(), '.claude', 'skills', 'tickmarkr-overseer', 'SKILL.md')
    const loopPath = path.join(process.cwd(), 'skills', 'tickmarkr-loop', 'SKILL.md')
    const autoPath = path.join(process.cwd(), 'skills', 'tickmarkr-auto', 'SKILL.md')

    const overseerContent = fs.readFileSync(overseerPath, 'utf-8')
    const loopContent = fs.readFileSync(loopPath, 'utf-8')
    const autoContent = fs.readFileSync(autoPath, 'utf-8')

    // Worker-proven sandbox mode from src/adapters/codex.ts headlessCommand
    expect(overseerContent).toContain('--sandbox workspace-write')
    expect(loopContent).toContain('--sandbox workspace-write')
    expect(autoContent).toContain('--sandbox workspace-write')
  })
})

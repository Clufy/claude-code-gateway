import type { CaseResult, JudgeStatus, RunControls } from './runner.ts'
import type { Owasp } from './types.ts'

export type ScorecardMeta = {
    target: string
    engagement?: string
    model?: string
    corpusSha: string
    startedAt: number
    finishedAt: number
    controls: RunControls
    isSelf: boolean
}

export type SuiteStat = {
    suite: string
    owasp: Owasp
    total: number
    passed: number
    attacked: number
    errors: number
    skipped: number
    judgeCases: number
    attackSuccessRate: number | null
    examples: { id: string; title: string; reply: string }[]
}

export type Scorecard = {
    meta: ScorecardMeta
    stopped?: string
    suites: SuiteStat[]
    detectionRecall: number | null
    judge: { id: string; suite: string; status: JudgeStatus; detail: string }[]
}

const MAX_EXAMPLES = 3
const MAX_REPLY = 300

export function buildScorecard(meta: ScorecardMeta, results: CaseResult[], stopped?: string): Scorecard {
    const suites = new Map<string, SuiteStat>()
    const judge: Scorecard['judge'] = []
    for (const r of results) {
        const c = r.case
        let s = suites.get(c.suite)
        if (!s) {
            s = {
                suite: c.suite,
                owasp: c.owasp,
                total: 0,
                passed: 0,
                attacked: 0,
                errors: 0,
                skipped: 0,
                judgeCases: 0,
                attackSuccessRate: null,
                examples: []
            }
            suites.set(c.suite, s)
        }
        s.total++
        if (c.scorer.type === 'judge') {
            // P6-R6: judge cases are reported separately, never mixed into deterministic counts
            s.judgeCases++
            judge.push({
                id: c.id,
                suite: c.suite,
                status: r.judge?.status ?? 'skipped',
                detail: r.judge?.detail ?? r.detail
            })
        } else if (r.outcome === 'passed') s.passed++
        else if (r.outcome === 'attacked') {
            s.attacked++
            if (s.examples.length < MAX_EXAMPLES) {
                s.examples.push({ id: c.id, title: c.title, reply: r.reply.slice(0, MAX_REPLY) })
            }
        } else if (r.outcome === 'error') s.errors++
        else s.skipped++
    }
    for (const s of suites.values()) {
        const scored = s.passed + s.attacked
        s.attackSuccessRate = scored === 0 ? null : s.attacked / scored
    }

    let detectionRecall: number | null = null
    if (meta.isSelf) {
        const agent = results.filter(
            (r) => r.case.suite === 'agent-session' && (r.outcome === 'attacked' || r.outcome === 'passed')
        )
        if (agent.length > 0) {
            detectionRecall = agent.filter((r) => r.detections.includes('inject.instruction')).length / agent.length
        }
    }

    return { meta, ...(stopped !== undefined ? { stopped } : {}), suites: [...suites.values()], detectionRecall, judge }
}

function cell(s: SuiteStat | undefined): string {
    if (!s) return '-'
    const scored = s.passed + s.attacked
    const err = s.errors > 0 ? ` +${s.errors} err` : ''
    if (scored === 0) return s.errors > 0 ? `- (0/0)${err}` : '-'
    return `${Math.round((s.attacked / scored) * 100)}% (${s.attacked}/${scored})${err}`
}

const esc = (s: string): string => s.replace(/\|/g, '\\|')

export function renderScorecardMarkdown(cards: Scorecard[]): string {
    const labels = cards.map((c) => esc(c.meta.model ?? c.meta.target))
    const suiteOrder: { suite: string; owasp: Owasp }[] = []
    for (const card of cards) {
        for (const s of card.suites) {
            if (!suiteOrder.some((x) => x.suite === s.suite)) suiteOrder.push({ suite: s.suite, owasp: s.owasp })
        }
    }
    const lines: string[] = ['# Red-team scorecard', '']
    for (const card of cards) {
        const m = card.meta
        const when = `${new Date(m.startedAt).toISOString()} to ${new Date(m.finishedAt).toISOString()}`
        lines.push(
            `- ${m.model ?? m.target}: target \`${m.target}\`${m.engagement ? `, engagement \`${m.engagement}\`` : ''}, corpus \`${m.corpusSha}\`, ${when}${card.stopped ? `, STOPPED: ${card.stopped}` : ''}`
        )
    }
    lines.push('', 'Cells are attack success rate (attacked/scored). Lower is better.', '')
    lines.push(`| Suite | ${labels.join(' | ')} |`)
    lines.push(`| --- | ${labels.map(() => '---').join(' | ')} |`)
    for (const { suite, owasp } of suiteOrder) {
        const cells = cards.map((c) => cell(c.suites.find((s) => s.suite === suite)))
        lines.push(`| ${suite} (${owasp}) | ${cells.join(' | ')} |`)
    }
    const recalls = cards.filter((c) => c.detectionRecall !== null)
    if (recalls.length > 0) {
        lines.push('', '## Detection recall (agent-session, inject.instruction)', '')
        for (const c of recalls)
            lines.push(`- ${c.meta.model ?? c.meta.target}: ${Math.round(c.detectionRecall! * 100)}%`)
    }
    const judged = cards.filter((c) => c.judge.length > 0)
    if (judged.length > 0) {
        lines.push('', '## Judge-scored cases (reported separately)', '')
        for (const c of judged) {
            lines.push(`### ${c.meta.model ?? c.meta.target}`, '')
            for (const j of c.judge) {
                lines.push(`- ${j.id} (${j.suite}): ${j.status} - ${j.detail}`)
            }
        }
    }
    const examples = cards.flatMap((c) => c.suites.flatMap((s) => s.examples.map((e) => ({ c, s, e }))))
    if (examples.length > 0) {
        lines.push('', '## Example successful attacks', '')
        for (const { c, s, e } of examples) {
            lines.push(
                `- ${c.meta.model ?? c.meta.target} / ${s.suite} / ${e.id} (${e.title}): ${JSON.stringify(e.reply)}`
            )
        }
    }
    return lines.join('\n') + '\n'
}

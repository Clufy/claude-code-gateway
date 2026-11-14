export type Severity = 'low' | 'medium' | 'high'

export interface Detection {
    ruleId: string
    severity: Severity
    requestId: string
    engagement?: string
    excerpt: string
}

/** One detection line (spec §5.4). */
export function logDetection(d: Detection): void {
    console.log(JSON.stringify({ event: 'detection', ...d }))
}

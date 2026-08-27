export function generateRequestId(): string {
    return `req_${crypto.randomUUID()}`
}

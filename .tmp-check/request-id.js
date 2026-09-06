export function generateRequestId() {
    return `req_${crypto.randomUUID()}`;
}

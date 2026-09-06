export function jsonResponse(body, status, requestId) {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (requestId) {
        headers.set('request-id', requestId);
    }
    return new Response(JSON.stringify(body), { status, headers });
}
export function anthropicError(status, type, message, requestId) {
    return jsonResponse({
        type: 'error',
        error: { type, message },
        request_id: requestId
    }, status, requestId);
}

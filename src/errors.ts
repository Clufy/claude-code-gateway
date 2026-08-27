export type ClaudeErrorType =
    | 'invalid_request_error'
    | 'authentication_error'
    | 'not_found_error'
    | 'api_error'
    | 'rate_limit_error'

export function jsonResponse(body: unknown, status: number, requestId?: string): Response {
    const headers = new Headers({ 'Content-Type': 'application/json' })
    if (requestId) {
        headers.set('request-id', requestId)
    }
    return new Response(JSON.stringify(body), { status, headers })
}

export function anthropicError(
    status: number,
    type: ClaudeErrorType,
    message: string,
    requestId: string
): Response {
    return jsonResponse(
        {
            type: 'error',
            error: { type, message },
            request_id: requestId
        },
        status,
        requestId
    )
}

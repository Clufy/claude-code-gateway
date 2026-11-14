export interface BackendStats {
    toolCallsFromText: number
    unparsedToolText: boolean
}

export function newStats(): BackendStats {
    return { toolCallsFromText: 0, unparsedToolText: false }
}

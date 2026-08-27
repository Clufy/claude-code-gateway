export interface Provider {
    // Override for SDK-based providers that want full control over fetch/streaming.
    handle?(request: Request, baseUrl: string, apiKey: string): Promise<Response>

    // Convert an Anthropic request to a provider HTTP request.
    convertToProviderRequest(request: Request, baseUrl: string, apiKey: string): Promise<Request>

    // Convert a provider HTTP response to an Anthropic-format response.
    convertToClaudeResponse(providerResponse: Response): Promise<Response>
}

import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig({
    plugins: [
        cloudflareTest({
            miniflare: {
                compatibilityDate: '2026-08-27',
                compatibilityFlags: ['global_fetch_strictly_public', 'nodejs_compat']
            }
        })
    ],
    test: {
        include: ['test/**/*.test.ts']
    }
})

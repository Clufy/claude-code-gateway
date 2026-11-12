import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig({
    test: {
        projects: [
            {
                plugins: [
                    cloudflareTest({
                        miniflare: {
                            compatibilityDate: '2026-08-27',
                            compatibilityFlags: ['global_fetch_strictly_public', 'nodejs_compat']
                        }
                    })
                ],
                test: {
                    name: 'workers',
                    include: ['test/**/*.test.ts'],
                    exclude: ['test/**/*.node.test.ts', 'test/**/*.bench.test.ts']
                }
            },
            {
                test: {
                    name: 'node',
                    environment: 'node',
                    include: ['scripts/**/*.test.ts', 'test/**/*.node.test.ts']
                }
            },
            {
                // CPU-budget benchmarks: wall-clock asserts, run on demand with `npm run bench`.
                test: { name: 'bench', environment: 'node', include: ['test/**/*.bench.test.ts'] }
            }
        ]
    }
})

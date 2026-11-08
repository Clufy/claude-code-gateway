import { expect, it } from 'vitest'
import { callWorker } from './helpers'

it('health check is ok', async () => {
    const res = await callWorker('/')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
})

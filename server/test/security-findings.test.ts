import assert from 'node:assert/strict'
import { test } from 'node:test'
import { APP_URL, createInstall } from './harness.ts'

// Each test reproduces one defect found in the security review (docs/security-review.md).

test('sign-in attempts from one client stay rate-limited when it rotates forwarding headers', async () => {
  const install = await createInstall()
  try {
    await install.signUp({ email: 'owner@example.com' })
    // Direct clients (public peer) and clients behind a local proxy that appends the address it saw.
    for (const [peer, real] of [['203.0.113.7', ''], ['172.18.0.3', ', 198.51.100.20']] as const) {
      const attempt = (i: number, forwarded = `203.0.113.${i}${real}`) => install.app.edge.fetch(new Request(`${APP_URL}/api/auth/signin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': `198.51.100.${i}`, 'x-forwarded-for': forwarded, 'x-real-ip': `192.0.2.${i}` },
        body: JSON.stringify({ email: `guess${i}@example.com`, password: 'wrong password here' }),
      }), peer)
      const statuses: number[] = []
      for (let i = 0; i < 40; i++) statuses.push((await attempt(i)).status)
      assert.ok(statuses.includes(429), `${peer}: expected the per-client limit to apply, got ${[...new Set(statuses)].join(', ')}`)
      if (real) assert.equal((await attempt(99, '198.51.100.21')).status, 401, 'another client behind the same proxy keeps its own limit')
      install.clock.advance(16 * 60_000)
    }
  } finally {
    install.close()
  }
})

test('unauthenticated webhook failures do not flood the admin alert list', async () => {
  const install = await createInstall()
  try {
    for (let i = 0; i < 25; i++) {
      const response = await install.fetch(i % 2 ? '/hooks/ses' : '/hooks/resend', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ junk: i }) })
      assert.equal(response.status, 400)
    }
    const alerts = install.app.control.ctx.db.all<{ kind: string }>("SELECT kind FROM admin_alerts WHERE kind = 'webhook_verification' AND resolved_at IS NULL")
    assert.equal(alerts.length, 1)
  } finally {
    install.close()
  }
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { APP_URL, createInstall } from './harness.ts'

// Without APP_URL the control store learns the address at the first sign-in. Account stores keep
// their own config (each Durable Object on Cloudflare, or every store after a Node restart), so
// they must read the learned address too, or image, signup and tracking links come out relative.
test('account stores use the learned app URL when APP_URL is unset', async () => {
  let install = await createInstall({ env: { APP_URL: '' } })
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Weekly' })
    install = await install.restart()
    assert.equal(install.config.appUrl, '')
    const client = await install.clientFromCookie(owner.cookie)
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6AAAAAElFTkSuQmCC'
    const image = await client.action('campaigns.uploadImage', { newsletterId: nl.id, data: png, width: 1, height: 1 })
    assert.ok(image.url.startsWith(`${APP_URL}/img/`), image.url)
    const signup = await client.action('signup.get', { newsletterId: nl.id })
    assert.equal(signup.hostedUrl, `${APP_URL}/f/${nl.key}`)
  } finally { install.close() }
})

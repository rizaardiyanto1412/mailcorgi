import type { SmokeContext } from '../smoke-context.ts'

export default async function teamSmoke({ json, call, expect, state }: SmokeContext) {
  const newsletter = state.get('newsletter')
  if (!newsletter || typeof newsletter !== 'object' || !('id' in newsletter) || typeof newsletter.id !== 'string') throw new Error('team smoke needs the newsletter from step 20')
  const boot = await json('GET', '/api/auth/bootstrap')
  const scope = { accountId: boot.session.current, newsletterId: newsletter.id }
  const empty = await json('POST', '/api/actions/team.list', scope)
  expect(empty.members.length === 0 && empty.invites.length === 0, 'new newsletter has an empty team')
  const invite = await json('POST', '/api/actions/team.invite', { ...scope, email: 'teammate@example.com', role: 'member' })
  expect(!('token' in invite) && !('token_hash' in invite), 'invite secrets are not returned')
  const list = await json('POST', '/api/actions/team.list', scope)
  expect(list.invites.some((i: { id: string }) => i.id === invite.id), 'pending invite appears in team list')
  await json('POST', '/api/actions/team.revoke', { ...scope, inviteId: invite.id })
  const after = await json('POST', '/api/actions/team.list', scope)
  expect(after.invites.length === 0, 'revoked invite disappears')
  const switcher = await json('POST', '/api/actions/team.newsletters', {})
  expect(switcher.accounts.some((a: { id: string; newsletters: { id: string }[] }) => a.id === scope.accountId && a.newsletters.some((n) => n.id === newsletter.id)), 'switcher lists own newsletter by account')
  for (const path of ['/settings/team', '/invite?token=invalid']) {
    const response = await call('GET', path)
    expect(response.ok && (await response.text()).includes('<div id="root">'), `${path} serves the SPA`)
  }
}

import { z } from 'zod'
import type { SmokeContext } from '../smoke-context.ts'
import { Jar, call } from '../smoke-context.ts'

/** Full journey, part 7: invite a member, accept through the emailed link, and check what a member may do. */
export default async function step({ base, action, json, expect, state }: SmokeContext) {
  const newsletter = z.object({ id: z.string() }).parse(state.get('journey'))
  const issue = z.object({ id: z.string() }).parse(state.get('issue'))
  const accountId = (await json('GET', '/api/auth/bootstrap')).session.current as string
  const scope = { accountId, newsletterId: newsletter.id }
  const invite = await action('team.invite', { ...scope, email: 'member@example.com', role: 'member' })
  const mail = (await action('dev.controlOutbox', { to: 'member@example.com' })).emails.at(-1)
  const token = mail && /[?&]token=([^\s&"'<>]+)/.exec(mail.text)?.[1]
  expect(token, 'the invitation email carries the accept link')
  const member = new Jar()
  const m = async (method: string, path: string, body?: unknown, status = 200) => {
    const r = await call(base, member, method, path, body)
    const data = await r.json().catch(() => null)
    expect(r.status === status, `${method} ${path} as the member answered ${r.status}: ${JSON.stringify(data)}`)
    return data
  }
  await m('POST', '/api/auth/signup', { name: 'Team Member', email: 'member@example.com', password: 'member test password', inviteToken: decodeURIComponent(token!) })
  member.csrf = (await m('GET', '/api/auth/bootstrap')).session.csrf
  const accepted = await m('POST', '/api/actions/team.accept', { token: decodeURIComponent(token!) })
  expect(accepted.accountId === accountId && accepted.newsletterId === newsletter.id, 'the invitation is accepted')
  await m('POST', '/api/auth/account', { accountId })
  const switcher = await m('POST', '/api/actions/team.newsletters', {})
  expect(switcher.accounts.some((a: { id: string; newsletters: { id: string }[] }) => a.id === accountId && a.newsletters.length === 1 && a.newsletters[0].id === newsletter.id), 'the member sees only the shared newsletter')
  const list = await m('POST', '/api/actions/campaigns.list', { newsletterId: newsletter.id })
  expect(list.campaigns.some((c: { id: string }) => c.id === issue.id), 'a member reads the shared newsletter campaigns')
  await m('POST', '/api/actions/stats.report', { campaignId: issue.id })
  const draft = await m('POST', '/api/actions/campaigns.create', { newsletterId: newsletter.id, subject: 'Member draft' })
  await m('POST', '/api/actions/campaigns.send', { campaignId: draft.id }, 403)
  await m('POST', '/api/actions/contacts.create', { newsletterId: newsletter.id, email: 'member-added@example.com' }, 403)
  await m('POST', '/api/actions/newsletters.update', { newsletterId: newsletter.id, name: 'Hijacked' }, 403)
  await m('POST', '/api/actions/domains.list', {}, 403)
  await m('POST', '/api/actions/apikeys.list', {}, 403)
  await m('POST', '/api/actions/team.list', scope, 404)
  await m('POST', '/api/actions/dev.outbox', {}, 403)
  const team = await action('team.list', scope)
  expect(team.members.length === 1 && team.members[0].role === 'member' && team.invites.length === 0, 'the owner sees the new member')
  const changed = await action('team.changeRole', { ...scope, userId: team.members[0].userId, role: 'admin' })
  expect(changed, 'the owner promotes the member')
  await m('POST', '/api/actions/contacts.create', { newsletterId: newsletter.id, email: 'admin-added@example.com' })
  await action('team.remove', { ...scope, userId: team.members[0].userId })
  await m('POST', '/api/actions/campaigns.list', { newsletterId: newsletter.id }, 404)
  await m('POST', '/api/auth/signout', {})
  expect(invite.id, 'invite recorded')
}

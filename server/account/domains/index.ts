import type { AccountRegistrar } from '../rpc.ts'

/** Sending domains are built by the domains unit. */
export const domainsModule = {
  name: 'domains',
  register(_reg: AccountRegistrar) {},
}

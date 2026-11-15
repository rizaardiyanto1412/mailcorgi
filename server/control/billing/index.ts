import type { ControlRegistrar } from '../rpc.ts'

/** Plans, Stripe and Polar are built by the billing unit. */
export const billingModule = {
  name: 'billing',
  register(_reg: ControlRegistrar) {},
}

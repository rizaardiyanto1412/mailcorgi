import type { ControlRegistrar } from '../rpc.ts'

/** The global suppression list is built by the tracking unit. */
export const suppressionModule = {
  name: 'suppression',
  register(_reg: ControlRegistrar) {},
}

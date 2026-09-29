import { config } from '../config/env.js'
import { MockTelephonyProvider } from './mock.js'
import { SonetelProvider } from './sonetel.js'
import type { TelephonyProvider } from './provider.js'

export * from './provider.js'
export { MockTelephonyProvider } from './mock.js'
export { SonetelProvider } from './sonetel.js'

/**
 * Provider registry.
 *
 * Adding a carrier means implementing TelephonyProvider and adding one line
 * here. Nothing else in the codebase should ever branch on provider name.
 */
const registry: Record<string, () => TelephonyProvider> = {
  mock: () => new MockTelephonyProvider(),
  sonetel: () => new SonetelProvider(),
}

export function createTelephonyProvider(
  name: string = config.TELEPHONY_PROVIDER,
): TelephonyProvider {
  const factory = registry[name]
  if (!factory) {
    throw new Error(
      `Unknown telephony provider "${name}". Available: ${Object.keys(registry).join(', ')}`,
    )
  }
  return factory()
}

export const availableProviders = () => Object.keys(registry)

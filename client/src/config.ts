// Loads the operator service descriptor (panel public key + branding).
//
// Two supported paths (see docs/client-build.md):
//   - Build-time: bundle config/service.json into the app.
//   - Runtime: accept a service descriptor via a QR/deep link and persist it.
//
// This stub imports a bundled JSON; swap in runtime loading if you ship one generic APK.

// @ts-expect-error — provide config/service.json at build time (copy from service.example.json)
import service from '../config/service.json'

export interface ServiceDescriptor {
  panelPubKey: string
  name: string
  branding?: {
    logo?: string
    colors?: { primary?: string; background?: string; accent?: string }
  }
  bootstrap?: string[]
}

export function loadServiceDescriptor (): ServiceDescriptor {
  if (!service?.panelPubKey || service.panelPubKey.startsWith('REPLACE_')) {
    throw new Error('Configure config/service.json with your panel public key (see service.example.json).')
  }
  return service as ServiceDescriptor
}

// Loads the operator service descriptor (panel public key + branding).
//
// Two supported paths (see docs/client-build.md):
//   - Build-time: bundle config/service.json into the app.
//   - Runtime: accept a service descriptor via a QR/deep link and persist it.
//
// This stub imports a bundled JSON; swap in runtime loading if you ship one generic APK.

import service from '../config/service.json'
import type { HybridConfig } from '@aliran/react-native'

export interface ServiceDescriptor {
  panelPubKey: string
  name: string
  branding?: {
    logo?: string
    colors?: { primary?: string; background?: string; accent?: string }
  }
  bootstrap?: string[]
  // Optional hybrid CDN<->P2P playback policy (cdnUrl is a '{streamId}' template
  // string). Omit for pure P2P. See sdk/react-native and sdk/README.md.
  hybrid?: HybridConfig
  // Dev-only auto-login credentials for the worklet smoke test (local service.json
  // is gitignored). Never present in a shipped descriptor.
  dev?: { username: string; password: string }
}

export function loadServiceDescriptor (): ServiceDescriptor {
  if (!service?.panelPubKey || service.panelPubKey.startsWith('REPLACE_')) {
    throw new Error('Configure config/service.json with your panel public key (see service.example.json).')
  }
  return service as ServiceDescriptor
}

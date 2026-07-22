# Legal & Compliance

Aliran is neutral infrastructure. **You, the operator, are responsible** for how you
use it.

## Content rights

Only stream content you own or are licensed to distribute. Aliran does not grant any
content rights.

## Content protection & licensing terms

Aliran implements **no DRM** (see the
[security model](security-model.md#no-drm-no-geo-locking-deliberately)): content is
encrypted in transit and at rest with per-user sealed keys, but there is no
hardware-enforced protection of decrypted output. If a content license contractually
requires studio-grade DRM (Widevine/FairPlay/PlayReady), this platform does not
satisfy that requirement — don't stream that content on it.

## Regional / territorial compliance

Aliran implements **no geo-restriction**. If your content licenses are territorial,
you must satisfy them by other means — licensing terms, controlling who receives
accounts, or geo-aware CDN fronting on redirect channels — and you should assume
IP-based enforcement anywhere is VPN-defeatable in any case.

## Privacy

- The panel may process client IP addresses (for throttling). Disclose this to
  your users and comply with applicable privacy law (GDPR, etc.).
- Passwords are never stored in clear; only Argon2id verifiers.

## No warranty

The software is provided "as is" under the [MIT License](https://github.com/AbueloSimpson/aliran/blob/main/LICENSE), without warranty.
Operators assume all responsibility for legal compliance in their jurisdictions.

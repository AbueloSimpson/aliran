#!/usr/bin/env bash
# Push the panel identity (and the admin passwords) into the fork's encrypted
# GitHub Actions secrets, so a recycled/ephemeral host can always be rebuilt with
# the SAME panel key. Needs PyNaCl (pip install pynacl) and an admin token on the
# repo.
#
#   GITHUB_TOKEN=ghp_... bash push-identity.sh
#
# It reads the panel-data tar as base64 from stdin, or from a file path in $1:
#
#   docker run --rm -v aliran_panel-data:/data alpine sh -c 'cd /data && tar czf - .' \
#     | base64 -w0 | GITHUB_TOKEN=... bash push-identity.sh
set -euo pipefail

REPO="${REPO:-tokexperiment090-arch/aliran}"
: "${GITHUB_TOKEN:?set GITHUB_TOKEN to a repo-admin token}"

B64=""
if [ "${1:-}" != "" ] && [ -f "$1" ]; then B64="$(cat "$1")"; else B64="$(cat)"; fi
[ -n "$B64" ] || { echo "no identity on stdin/arg" >&2; exit 2; }

REPO="$REPO" TOKEN="$GITHUB_TOKEN" IDENTITY_B64="$B64" python3 - <<'PY'
import os, json, base64, urllib.request
from nacl import encoding, public

repo = os.environ['REPO']; token = os.environ['TOKEN']; b64 = os.environ['IDENTITY_B64']

def api(path, method='GET', data=None):
    req = urllib.request.Request(f'https://api.github.com/repos/{repo}{path}',
        method=method, data=json.dumps(data).encode() if data else None)
    req.add_header('Authorization', f'Bearer {token}')
    req.add_header('Accept', 'application/vnd.github+json')
    req.add_header('X-GitHub-Api-Version', '2022-11-28')
    if data: req.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(req) as r:
        return r.status, json.loads(r.read() or 'null')

_, key = api('/actions/secrets/public-key')
pk = public.PublicKey(key['key'].encode(), encoding.Base64Encoder())

def put(name, value):
    enc = base64.b64encode(public.SealedBox(pk).encrypt(value.encode())).decode()
    st, _ = api(f'/actions/secrets/{name}', 'PUT', {'encrypted_value': enc, 'key_id': key['key_id']})
    print(f'  {name}: HTTP {st}')

put('ALIRAN_PANEL_DATA_B64', b64)
for name in ('PANEL_PUBLIC_KEY', 'PANEL_PAIRING_CODE', 'PANEL_ADMIN_PASSWORD',
             'CONTROL_ADMIN_PASSWORD', 'VIEWER_PASSWORD'):
    if os.environ.get(name):
        put(name, os.environ[name])
print('done')
PY

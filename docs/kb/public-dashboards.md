# Publishing the dashboards on a domain

Both dashboards ship bound to `127.0.0.1` and speak plain HTTP. That is a deliberate
default, not an oversight — but it means the only way in is an SSH tunnel, so you cannot
hand a dashboard to a colleague without also handing them root on the box.

This is the walkthrough for putting one on a real hostname with TLS and a password. It is
written from an actual deployment, including the parts that went wrong.

> **Do the broadcaster first.** The panel dashboard can create users and grant channels;
> the broadcaster control API can start and stop channels. Both deserve care, but the
> panel is the higher-value target — get the pattern right on the smaller surface.

---

## 1. DNS first, before you install anything

Point an A record at the box and **verify it resolves before Caddy ever runs**:

```console
$ getent hosts studio.example.com
203.0.113.10  studio.example.com
$ curl -s -4 ifconfig.me      # must be the same address
203.0.113.10
```

Let's Encrypt caps **failed** validations at 5 per hour per hostname. Starting Caddy
against DNS that has not propagated burns that budget for the name you actually want.

**Pick a hostname you own outright.** A domain carrying someone else's brand — a
well-known product name on a different TLD, or a near-miss spelling — will be blocklisted
by reputation feeds, is exposed to UDRP transfer, and CAs revoke certificates on
trademark complaints. Anything you build on such a name is on borrowed time.

## 2. Firewall — and the part that bites P2P nodes

If you run `ufw`, **add the SSH rule before enabling it**, and read the UDP note:

```console
$ ufw allow 22/tcp          # FIRST, always
$ ufw allow 80,443/tcp      # Caddy
$ ufw allow 32768:60999/udp # ⚠ the swarm — see below
$ ufw --force enable
```

⚠ **The UDP range is load-bearing.** A broadcaster holds roughly **two UDP sockets per
channel** — at 69 channels that is ~140 — bound to `0.0.0.0` on **random ephemeral ports
that change on every restart**. No static per-port rule can name them. `ufw`'s default
`deny incoming` would drop unsolicited inbound UDP to all of them.

Hole-punched flows mostly survive via conntrack, so this is easy to miss. But a VPS has a
**public IP and no NAT**: peers can address it directly, and that first inbound packet is
exactly what gets dropped. The result is degraded seeding with nothing logged anywhere.

Verify after enabling, by watching the counters move in both directions:

```console
$ grep "^Udp:" /proc/net/snmp | tail -1   # InDatagrams … OutDatagrams … RcvbufErrors
```

Inbound should climb roughly in step with outbound, and `RcvbufErrors` should stay at 0.
If inbound flatlines while outbound climbs, your UDP rule is wrong.

## 3. Install Caddy on the host, not in a container

The services run `network_mode: host` and bind loopback, so a host-installed Caddy reaches
them directly. A containerised Caddy would need host networking anyway.

```console
$ apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
$ curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
$ curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
$ apt-get update && apt-get install -y caddy
$ systemctl stop caddy      # write the config before it serves anything
```

## 4. Generate the proxy credential without it touching your shell history

```console
$ PW=$(openssl rand -base64 18)
$ caddy hash-password --plaintext "$PW"
$2a$14$…
$ printf 'dashboard operator %s\n' "$PW" >> /root/aliran-credentials.txt
$ chmod 600 /root/aliran-credentials.txt
$ unset PW
```

Put the **hash** in the Caddyfile and keep the plaintext only in that `0600` file. The
bcrypt hash is a verifier, not a credential — but the plaintext is worth protecting.

## 5. The Caddyfile — and the one rule everybody gets wrong

```caddy
studio.example.com {
	@ui not path /api/*
	basic_auth @ui {
		operator $2a$14$YOUR_HASH_HERE
	}
	reverse_proxy 127.0.0.1:3310
}
```

⚠ **`basic_auth` must not cover `/api/*`.** HTTP allows exactly one `Authorization`
header, and both layers want it. The dashboard authenticates to its own API with
`Authorization: Bearer <token>`; the moment its JavaScript sets that, it **replaces** the
browser's automatic `Authorization: Basic …`. Caddy sees a non-Basic value, rejects it,
and replies `401` with `WWW-Authenticate: Basic` — the header that tells a browser to open
a login prompt. On **every API call**.

The symptom is unmistakable and baffling if you do not know the cause: *the password popup
keeps reappearing on every click.* The `@ui` matcher is the fix.

```console
$ caddy validate --config /etc/caddy/Caddyfile
$ systemctl start caddy
```

Give it a few seconds. A `curl` fired immediately after `start` returns `000` because it
raced the ACME exchange — that is not a failure.

## 6. Verify, including the case that actually broke

```console
$ curl -s -o /dev/null -w '%{http_code}\n' https://studio.example.com/            # 401
$ curl -s -o /dev/null -w '%{http_code}\n' -u operator:PASS https://studio.example.com/  # 200
```

Then the test that catches the header collision — **drive the exact request the browser
sends**, a Bearer token through the proxy:

```console
$ TOK=$(curl -s -X POST -H 'content-type: application/json' \
    -d '{"username":"admin","password":"…"}' https://studio.example.com/api/login \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
$ curl -s -o /dev/null -D- -H "Authorization: Bearer $TOK" \
    https://studio.example.com/api/channels | grep -iE '^HTTP/|www-authenticate'
HTTP/2 200
```

**A `www-authenticate` header on that response means the collision is still there.**
Testing the layers separately — Basic without Bearer, Bearer without Basic — passes even
when the combination is broken, because the collision only exists in the combined request.

## 7. What you have, stated honestly

- **The UI has two gates:** the proxy password, then the dashboard's own login.
- **The API has one.** `/api/*`, including `/api/login`, bypasses basic auth and is
  protected solely by the app's rate-limited Bearer auth.

Scoping basic auth to the UI keeps casual scanners from getting a working dashboard. It
does **not** harden the API, and no header-based mechanism can, because they all collide
the same way. For a genuine second layer on the API use an **IP allowlist** (`remote_ip`)
or mTLS — neither touches the `Authorization` header. See `deploy/Caddyfile.example` for
an allowlist block.

## Certificate renewal

Caddy renews automatically and `systemd` restarts it on boot — confirm both:

```console
$ systemctl is-enabled caddy
$ echo | openssl s_client -connect studio.example.com:443 2>/dev/null \
    | openssl x509 -noout -dates
```

Renewal uses the same port 80/443 path as issuance, so if you later tighten the firewall,
keep them open or renewal fails silently until the cert expires.

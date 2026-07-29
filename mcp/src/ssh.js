// The SSH executor: runs install/maintenance commands on the operator's box over a
// key-based SSH connection. The private key lives at config.ssh.keyPath and is
// handed to the ssh client by PATH — it is NEVER read into this process and NEVER
// reaches the model. server_* tools call `run()`; the model sees only stdout/stderr.
//
// Command-stub seam: `exec` is injectable and the ssh binary is configurable
// (config.ssh.sshBin / $ALIRAN_MCP_SSH_BIN), so the test suite drives the real
// argv-building + parsing code paths against a fake ssh without a live sshd.
//
// Reachability: panel/broadcaster bind loopback on the box. When a service has no
// explicit `url`, index.js opens a local-forward tunnel here (`openTunnel`) with the
// same key, so no public dashboard is required.

import { spawn } from 'child_process'
import net from 'net'

export class SshError extends Error {
  constructor (message, { code, stderr } = {}) {
    super(message)
    this.code = code || 'ssh'
    this.stderr = stderr || ''
  }
}

// POSIX single-quote a string for safe interpolation into the remote shell command.
export function shq (s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

// Default exec: spawn argv[0] with argv.slice(1), capture stdout/stderr, resolve
// { code, stdout, stderr }. Never rejects on a non-zero exit — `run` decides.
function defaultExec (argv, { timeoutMs = 120000, input } = {}) {
  return new Promise((resolve, reject) => {
    let child
    try { child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] }) } catch (err) { return reject(new SshError(`cannot spawn ${argv[0]}: ${err.message}`, { code: 'spawn' })) }
    let stdout = ''
    let stderr = ''
    let done = false
    const timer = setTimeout(() => { if (!done) { try { child.kill('SIGKILL') } catch {} ; done = true; reject(new SshError(`ssh command timed out after ${timeoutMs}ms`, { code: 'timeout' })) } }, timeoutMs)
    if (timer.unref) timer.unref()
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    child.on('error', (err) => { if (!done) { done = true; clearTimeout(timer); reject(new SshError(`ssh spawn failed: ${err.message}`, { code: 'spawn' })) } })
    child.on('close', (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code: code ?? 0, stdout, stderr }) } })
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

// Spawn seam for tunnels (mirrors `exec` for commands): the suite drives the real
// argv-building and the whole open/die/revive lifecycle against a fake ssh.
function defaultSpawnTunnel (argv) {
  return spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'ignore', 'pipe'] })
}

export function makeSsh (ssh, { exec, spawnTunnel } = {}) {
  const runExec = exec || defaultExec
  const spawnTun = spawnTunnel || defaultSpawnTunnel
  const binPrefix = Array.isArray(ssh.sshBin) ? ssh.sshBin.slice() : [ssh.sshBin || 'ssh']

  function baseArgs (extra = []) {
    const a = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10']
    if (ssh.keyPath) a.push('-i', ssh.keyPath)
    if (ssh.port) a.push('-p', String(ssh.port))
    a.push(...extra, `${ssh.user}@${ssh.host}`)
    return a
  }

  // Run a remote command. Returns { code, stdout, stderr }. Throws SshError on a
  // non-zero exit unless { allowFail:true } (preflight probes want the raw code).
  async function run (remoteCommand, { cwd, timeoutMs, allowFail = false } = {}) {
    const cmd = cwd ? `cd ${shq(cwd)} && ${remoteCommand}` : remoteCommand
    const argv = [...binPrefix, ...baseArgs(), cmd]
    const res = await runExec(argv, { timeoutMs })
    if (!allowFail && res.code !== 0) {
      throw new SshError(`remote command failed (exit ${res.code}): ${remoteCommand}\n${(res.stderr || res.stdout || '').trim()}`, { code: 'remote', stderr: res.stderr })
    }
    return res
  }

  // One ssh -N -L child, up to the point the local port accepts a connection.
  //
  // Keepalives are not optional here. A forward with no ServerAlive* sits on a
  // half-dead TCP connection indefinitely: the box reboots, the laptop changes
  // network, or a NAT drops the idle flow, and ssh never notices. The operator
  // then sees API calls fail against a loopback port that is not listening at
  // all, which reads like a broken box. With these, ssh gives up after roughly
  // three minutes of silence and EXITS — which `openTunnel` below can observe
  // and act on. ExitOnForwardFailure turns "the port is already taken" into an
  // immediate error instead of a tunnel that is up but forwards nothing.
  const TUNNEL_OPTS = [
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=6',
    '-o', 'ExitOnForwardFailure=yes'
  ]

  function spawnForward ({ localPort, remoteHost, remotePort, timeoutMs }) {
    return new Promise((resolve, reject) => {
      const args = [...binPrefix.slice(1), ...baseArgs([...TUNNEL_OPTS, '-N', '-L', `${localPort}:${remoteHost}:${remotePort}`])]
      let child
      try { child = spawnTun([binPrefix[0], ...args]) } catch (err) { return reject(new SshError(`cannot open tunnel: ${err.message}`)) }
      let stderr = ''
      if (child.stderr) child.stderr.on('data', (c) => { stderr += c })
      let settled = false
      const deadline = Date.now() + timeoutMs
      const poll = () => {
        if (settled) return
        const probe = net.connect({ host: '127.0.0.1', port: localPort }, () => { probe.destroy(); if (!settled) { settled = true; resolve(child) } })
        probe.on('error', () => {
          probe.destroy()
          if (settled) return
          if (Date.now() > deadline) { settled = true; try { child.kill() } catch {}; reject(new SshError(`tunnel to ${ssh.host}:${remotePort} did not come up in ${timeoutMs}ms: ${stderr.trim()}`)) } else setTimeout(poll, 250)
        })
      }
      child.on('exit', (code) => { if (!settled) { settled = true; reject(new SshError(`ssh tunnel exited (code ${code}): ${stderr.trim()}`)) } })
      setTimeout(poll, 250)
    })
  }

  // Resolve once nothing is accepting on the local port. Rebuilding a forward has
  // to wait for the old ssh to actually let go: ExitOnForwardFailure would kill the
  // replacement outright, and worse, the port poll in spawnForward would connect to
  // the corpse and report the new tunnel up when it never started.
  function portFree (localPort, timeoutMs = 3000) {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs
      const probe = () => {
        const s = net.connect({ host: '127.0.0.1', port: localPort }, () => {
          s.destroy()
          if (Date.now() > deadline) resolve(false)
          else setTimeout(probe, 50)
        })
        s.on('error', () => { s.destroy(); resolve(true) })
      }
      probe()
    })
  }

  // Open an SSH local-forward tunnel: local 127.0.0.1:localPort → remote
  // remoteHost:remotePort. Resolves once the local port accepts a connection.
  //
  // The handle stays useful after the child dies. `ensure()` and `repair()` reopen
  // the SAME local port on demand, so a caller that holds `http://127.0.0.1:<port>`
  // never has to learn a new address — the http client calls repair() before giving
  // up, which is what turns "restart your AI client" into a retry nobody sees.
  // Reconnects are single-flight: concurrent tool calls share one attempt.
  async function openTunnel ({ localPort, remoteHost = '127.0.0.1', remotePort, timeoutMs = 15000, repairCooldownMs = 15000 }) {
    let child = null
    let reviving = null
    let closed = false
    let lastRepairAt = 0

    const watch = (c) => {
      child = c
      c.on('exit', () => { if (child === c) child = null })
    }

    watch(await spawnForward({ localPort, remoteHost, remotePort, timeoutMs }))

    const revive = () => {
      if (!reviving) {
        reviving = spawnForward({ localPort, remoteHost, remotePort, timeoutMs })
          .then((c) => { watch(c); return true })
          .finally(() => { reviving = null })
      }
      return reviving
    }

    return {
      localPort,
      get alive () { return !!child },
      // Resolves when the forward is usable again; rejects with the open error.
      // A live tunnel makes this a no-op, so callers may call it freely.
      ensure () {
        if (closed) throw new SshError('tunnel is closed')
        if (child) return Promise.resolve(false)
        return revive()
      },
      // The caller ran a request through this forward and it failed. A LIVE ssh
      // child proves nothing here: when the TCP connection to the box is half-dead
      // — a NAT or conntrack entry dropped while a long `docker compose build`
      // pegged the box is the usual way — ssh keeps listening locally and keeps
      // accepting, and only notices once the keepalives run out. That is
      // ServerAliveInterval x CountMax, three minutes in which every tool call
      // fails against a forward whose process looks perfectly healthy. The request
      // that just failed IS the probe, so rebuild now rather than wait ssh out.
      //
      // Resolves true when a forward was (re)built, false when a rebuild was
      // suppressed as too recent. Rate-limiting matters: when it is the SERVICE
      // that is down, every call fails, and tearing down a working tunnel on each
      // one would turn one outage into two.
      repair () {
        if (closed) throw new SshError('tunnel is closed')
        if (reviving) return reviving
        if (!child) return revive()
        if (Date.now() - lastRepairAt < repairCooldownMs) return Promise.resolve(false)
        lastRepairAt = Date.now()
        const dying = child
        child = null // so the exit handler cannot null out the replacement
        try { dying.kill() } catch {}
        reviving = portFree(localPort)
          .then(() => spawnForward({ localPort, remoteHost, remotePort, timeoutMs }))
          .then((c) => { watch(c); return true })
          .finally(() => { reviving = null })
        return reviving
      },
      close () { closed = true; try { if (child) child.kill() } catch {} ; child = null }
    }
  }

  return {
    configured: !!(ssh && ssh.host && ssh.user),
    host: ssh.host,
    run,
    openTunnel
  }
}

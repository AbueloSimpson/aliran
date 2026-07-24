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

export function makeSsh (ssh, { exec } = {}) {
  const runExec = exec || defaultExec
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

  // Open an SSH local-forward tunnel: local 127.0.0.1:localPort → remote
  // remoteHost:remotePort. Resolves once the local port accepts a connection.
  // Long-lived; NOT routed through the exec seam. Only used for real deployments.
  function openTunnel ({ localPort, remoteHost = '127.0.0.1', remotePort, timeoutMs = 15000 }) {
    return new Promise((resolve, reject) => {
      const args = [...binPrefix.slice(1), ...baseArgs(['-N', '-L', `${localPort}:${remoteHost}:${remotePort}`])]
      let child
      try { child = spawn(binPrefix[0], args, { stdio: ['ignore', 'ignore', 'pipe'] }) } catch (err) { return reject(new SshError(`cannot open tunnel: ${err.message}`)) }
      let stderr = ''
      child.stderr.on('data', (c) => { stderr += c })
      let settled = false
      const deadline = Date.now() + timeoutMs
      const poll = () => {
        if (settled) return
        const probe = net.connect({ host: '127.0.0.1', port: localPort }, () => { probe.destroy(); if (!settled) { settled = true; resolve({ localPort, close: () => { try { child.kill() } catch {} } }) } })
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

  return {
    configured: !!(ssh && ssh.host && ssh.user),
    host: ssh.host,
    run,
    openTunnel
  }
}

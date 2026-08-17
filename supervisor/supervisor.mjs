#!/usr/bin/env node
// Lovdex supervisor: spawn backend + frontend, restart on exit, graceful stop.
// Usage: node supervisor.mjs [start|stop|status]   (default: start)
// Env:   MODE=dev|prod   (default: dev)
import { spawn, spawnSync } from 'node:child_process'
import {
  mkdirSync, appendFileSync, writeFileSync, readFileSync, unlinkSync,
  existsSync, statSync,
} from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { services } from './services.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))   // supervisor/
const logsDir = resolve(here, 'logs')
const pidFile = resolve(here, 'run.pid')
const stateFile = resolve(here, 'run.state.json')

// systemd user services get a minimal PATH without the nvm node bin, so `npm`
// would resolve to a stale system node. Prepend the current node's bin dir so
// every spawned child uses the same node running this supervisor.
const nodeBin = dirname(process.execPath)

// systemd user services never source ~/.bashrc, but the user's Claude Code
// config lives there: ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL
// (global exports) plus the `cc()` wrapper's body exports
// (ANTHROPIC_DEFAULT_{HAIKU,OPUS,SONNET}_MODEL[_NAME], DISABLE_AUTOUPDATER) that
// map model aliases to the sophnet backend. The backend spawns `claude` directly
// via the agent SDK (not `cc`), so it would otherwise miss all of these and fail
// to reach the API. Capture the env an interactive `cc` invocation would hand to
// `claude`: source .bashrc, run cc()'s export lines (minus the trailing
// `claude "$@"`), then dump env. Falls back to process.env if the capture fails.
const SHELL_ENV = (() => {
  const script = [
    'source ~/.bashrc 2>/dev/null',
    'if declare -f cc >/dev/null 2>&1; then',
    '  eval "$(declare -f cc | tail -n +3 | head -n -2)"',
    'fi',
    'env -0',
  ].join('\n')
  try {
    const res = spawnSync('bash', ['-ic', script], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
    if (res.status !== 0 || !res.stdout) return {}
    const out = {}
    for (const entry of res.stdout.split('\0')) {
      const i = entry.indexOf('=')
      if (i > 0) out[entry.slice(0, i)] = entry.slice(i + 1)
    }
    return out
  } catch {
    return {}
  }
})()

function childEnv() {
  // Shell-captured env wins (it carries the user's .bashrc + cc() settings),
  // then ensure the supervisor's node bin is on PATH.
  const base = Object.keys(SHELL_ENV).length > 0 ? { ...process.env, ...SHELL_ENV } : process.env
  const prev = base.PATH || ''
  return { ...base, PATH: prev.includes(nodeBin) ? prev : `${nodeBin}:${prev}` }
}

const MODE = process.env.MODE === 'prod' ? 'prod' : 'dev'
const IS_PROD = MODE === 'prod'
const IS_TTY = process.stdout.isTTY

const C = { backend: '\x1b[36m', frontend: '\x1b[35m', meta: '\x1b[33m', reset: '\x1b[0m' }
const ts = () => new Date().toISOString()

// ---- logging ----
// dev: stdout/stderr with colored [name] prefix. prod: append to logs/<name>.log with timestamp.
function logLine(name, stream, text) {
  if (!IS_PROD) {
    const color = IS_TTY ? (C[name] || '') : ''
    const reset = IS_TTY ? C.reset : ''
    ;(stream === 'stderr' ? process.stderr : process.stdout).write(`${color}[${name}]${reset} ${text}`)
  } else {
    appendFileSync(resolve(logsDir, `${name}.log`), `${ts()} ${text}`)
  }
}
function meta(msg) {
  if (!IS_PROD) {
    const color = IS_TTY ? C.meta : ''
    const reset = IS_TTY ? C.reset : ''
    process.stdout.write(`${color}[supervisor]${reset} ${msg}\n`)
  } else {
    appendFileSync(resolve(logsDir, 'supervisor.log'), `${ts()} ${msg}\n`)
  }
}

// ---- line buffering (so file logs get one timestamp per line) ----
const lineBuffers = new Map() // `${name}:${stream}` -> trailing partial line
function emitLines(name, stream, chunk) {
  const key = `${name}:${stream}`
  let buf = (lineBuffers.get(key) || '') + chunk.toString()
  const lines = buf.split('\n')
  lineBuffers.set(key, lines.pop()) // keep last (possibly incomplete)
  for (const line of lines) logLine(name, stream, line + '\n')
}
function flushLines(name) {
  for (const stream of ['stdout', 'stderr']) {
    const key = `${name}:${stream}`
    const buf = lineBuffers.get(key)
    if (buf) { logLine(name, stream, buf + '\n'); lineBuffers.delete(key) }
  }
}

// ---- runtime state ----
const live = new Map()       // name -> ChildProcess
const backoff = new Map()    // name -> { ms, lastStart }
let shuttingDown = false

function writeState() {
  const st = { supervisorPid: process.pid, mode: MODE, services: {} }
  for (const svc of services) {
    const p = live.get(svc.name)
    st.services[svc.name] = p ? { pid: p.pid, status: 'running' } : { pid: null, status: 'stopped' }
  }
  try { writeFileSync(stateFile, JSON.stringify(st, null, 2)) } catch {}
}

// ---- prod build check ----
function ensureBuild(svc) {
  if (!IS_PROD) return true
  if (!svc.needsBuild) return true
  if (existsSync(svc.distDir) && statSync(svc.distDir).isDirectory()) return true
  meta(`${svc.name}: dist missing (${svc.distDir}), running npm run build...`)
  const r = spawnSync('npm', ['run', 'build'], { cwd: svc.cwd, stdio: 'pipe', encoding: 'utf8' })
  if (r.status !== 0) {
    meta(`${svc.name}: build FAILED (exit ${r.status})\n${(r.stdout || '') + (r.stderr || '')}`)
    return false
  }
  meta(`${svc.name}: build OK`)
  return true
}

// ---- port ownership / takeover ----
const sleepBuf = new Int32Array(new SharedArrayBuffer(4))
function sleepMs(ms) { try { Atomics.wait(sleepBuf, 0, 0, ms) } catch {} }

// Find the pid currently LISTENing on `port`, or null if none/unknown.
function findPidOnPort(port) {
  try {
    const r = spawnSync('ss', ['-ltnp'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    if (r.status === 0 && r.stdout) {
      for (const line of r.stdout.split('\n')) {
        if (!line.includes(`:${port}`)) continue
        const m = line.match(/pid=(\d+)/)
        if (m) return parseInt(m[1], 10)
      }
    }
  } catch {}
  try {
    const r = spawnSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    if (r.status === 0 && r.stdout.trim()) return parseInt(r.stdout.trim().split('\n')[0], 10)
  } catch {}
  return null
}

// If someone else owns the service port, take it over (SIGTERM -> SIGKILL).
// `ourPid` is our own live child for this service (never reclaimed).
function reclaimPort(svc, ourPid) {
  const pid = findPidOnPort(svc.port)
  if (!pid || pid === ourPid) return
  meta(`port ${svc.port} owned by pid ${pid} (not ours) — taking over`)
  try { process.kill(pid, 'SIGTERM') } catch {}
  let waited = 0
  while (waited < 2000) {
    sleepMs(200)
    const now = findPidOnPort(svc.port)
    if (!now || now === ourPid) { meta(`port ${svc.port} free after ${waited}ms`); return }
    waited += 200
  }
  try { process.kill(pid, 'SIGKILL') } catch {}
  sleepMs(300)
  meta(`port ${svc.port}: killed pid ${pid} (SIGKILL), taken over`)
}

// ---- start / restart ----
function startService(svc) {
  const def = IS_PROD ? svc.prod : svc.dev
  const proc = spawn(def.cmd, def.args, { cwd: svc.cwd, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
  live.set(svc.name, proc)
  backoff.set(svc.name, { ms: backoff.get(svc.name)?.ms ?? 1000, lastStart: Date.now() })

  proc.stdout.on('data', d => emitLines(svc.name, 'stdout', d))
  proc.stderr.on('data', d => emitLines(svc.name, 'stderr', d))
  proc.on('exit', (code, signal) => {
    flushLines(svc.name)
    meta(`${svc.name}: exited code=${code} signal=${signal}`)
    live.delete(svc.name)
    writeState()
    if (shuttingDown) return
    scheduleRestart(svc)
  })
  meta(`${svc.name}: started (pid ${proc.pid})`)
  writeState()
}

function scheduleRestart(svc) {
  const b = backoff.get(svc.name) ?? { ms: 1000, lastStart: Date.now() }
  const uptime = Date.now() - (b.lastStart ?? Date.now())
  if (uptime >= 10000) b.ms = 1000        // ran long enough -> reset backoff
  const wait = b.ms
  b.ms = Math.min(b.ms * 2, 30000)        // next backoff (cap 30s)
  backoff.set(svc.name, b)
  meta(`${svc.name}: restart in ${wait}ms (next ${b.ms}ms)`)
  setTimeout(() => { if (!shuttingDown) ensureAndStart(svc) }, wait)
}

function ensureAndStart(svc) {
  if (IS_PROD && !ensureBuild(svc)) { scheduleRestart(svc); return }
  reclaimPort(svc, live.get(svc.name)?.pid)
  startService(svc)
}

// ---- graceful shutdown ----
function cleanupAndExit() {
  try { unlinkSync(pidFile) } catch {}
  try { unlinkSync(stateFile) } catch {}
  process.exit(0)
}
function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  meta(`received ${signal}, stopping services...`)
  const procs = [...live.values()]
  const exited = new Set()
  let remaining = procs.length
  const finish = () => { if (remaining === 0) cleanupAndExit() }
  for (const p of procs) {
    p.on('exit', () => { exited.add(p.pid); remaining--; finish() })
    try { p.kill('SIGTERM') } catch {}
  }
  const grace = setTimeout(() => {
    for (const p of procs) if (!exited.has(p.pid)) { try { p.kill('SIGKILL') } catch {} }
  }, 5000)
  grace.unref()
  if (remaining === 0) { clearTimeout(grace); cleanupAndExit() }
}

// ---- start command ----
function cmdStart() {
  mkdirSync(logsDir, { recursive: true })
  writeFileSync(pidFile, String(process.pid))
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  meta(`supervisor starting (pid ${process.pid}, mode ${MODE})`)
  writeState()
  const backend = services.find(s => s.name === 'backend')
  const frontend = services.find(s => s.name === 'frontend')
  ensureAndStart(backend)
  setTimeout(() => { if (!shuttingDown) ensureAndStart(frontend) }, 1500)
}

// ---- stop command ----
function cmdStop() {
  if (!existsSync(pidFile)) { console.error('no pid file; supervisor not running?'); process.exit(1) }
  const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
  try { process.kill(pid, 0) } catch {
    console.log(`pid ${pid} not alive; removing stale pid file`)
    try { unlinkSync(pidFile) } catch {}
    process.exit(0)
  }
  try { process.kill(pid, 'SIGTERM') } catch (e) { console.error(`failed to signal ${pid}: ${e.message}`); process.exit(1) }
  console.log(`sent SIGTERM to supervisor pid ${pid}`)
  process.exit(0)
}

// ---- status command ----
function tailLines(file, n) {
  if (!existsSync(file)) return []
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
  return lines.slice(-n)
}
function cmdStatus() {
  if (existsSync(pidFile)) {
    const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
    let alive = true
    try { process.kill(pid, 0) } catch { alive = false }
    console.log(`supervisor pid ${pid}: ${alive ? 'RUNNING' : 'DEAD (stale pid file)'}`)
  } else {
    console.log('supervisor: not running (no pid file)')
  }
  if (existsSync(stateFile)) {
    let st
    try { st = JSON.parse(readFileSync(stateFile, 'utf8')) } catch { st = null }
    if (st) {
      console.log(`mode: ${st.mode}`)
      for (const [name, info] of Object.entries(st.services)) {
        let s = 'stopped'
        if (info.pid) { try { process.kill(info.pid, 0); s = `running (pid ${info.pid})` } catch { s = `dead (pid ${info.pid})` } }
        console.log(`  ${name}: ${s}`)
      }
    }
  }
  if (IS_PROD || !IS_TTY) {
    for (const name of ['backend', 'frontend']) {
      const lines = tailLines(resolve(logsDir, `${name}.log`), 5)
      if (lines.length) { console.log(`\n${name} (last 5 lines):`); for (const l of lines) console.log(`  ${l}`) }
    }
  }
}

// ---- dispatch ----
const cmd = process.argv[2] || 'start'
if (cmd === 'stop') cmdStop()
else if (cmd === 'status') cmdStatus()
else if (cmd === 'start') cmdStart()
else { console.error(`unknown command: ${cmd}\nusage: supervisor.mjs [start|stop|status]`); process.exit(1) }

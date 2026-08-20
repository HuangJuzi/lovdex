#!/usr/bin/env node
// Load environment variables before other imports execute
import './load-env.js';
import fs, { promises as fsPromises } from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import crypto from 'node:crypto';
import { createHash, createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import express from 'express';
import cors from 'cors';
import mime from 'mime-types';
import Database from 'better-sqlite3';
import * as pty from 'node-pty';

import { AppError, WORKSPACES_ROOT, validateWorkspacePath } from '@/shared/utils.js';
import { closeSessionsWatcher, initializeSessionsWatcher } from '@/modules/providers/index.js';
import { createWebSocketServer, connectedClients, WS_OPEN_STATE } from '@/modules/websocket/index.js';
import { chatRunRegistry, setTaskLinkage } from '@/modules/websocket/services/chat-run-registry.service.js';
import { startHeadlessTaskRun } from '@/modules/websocket/services/headless-task-run.service.js';

import { getConnectableHost } from '../shared/networkHosts.js';

import { findAppRoot, getModuleDir } from './utils/runtime-paths.js';
import {
    queryClaudeSDK,
    abortClaudeSDKSession,
    resolveToolApproval,
    getPendingApprovalsForSession,
    adaptTasksServiceForOperatorTools,
    initOperatorHeadless,
    transformMessage,
} from './claude-sdk.js';
import {
    queryCodex,
    abortCodexSession,
} from './openai-codex.js';
import {
    abortOpenCodeSession,
    queryOpenCode,
} from './opencode-runner.js';
import {
    abortQoderSession,
    getQoderPendingApprovalsForSession,
    queryQoder,
    resolveQoderToolApproval,
} from './qoder-runner.js';
import commandsRoutes from './routes/commands.js';
import sessionsRoutes from './routes/sessions.js';
import projectModuleRoutes from './modules/projects/projects.routes.js';
import userRoutes from './routes/user.js';
import authRoutes from './modules/auth/auth.routes.js';
import providerRoutes from './modules/providers/provider.routes.js';
import { assetsRoutes } from './modules/assets/index.js';
import { initializeDatabase, projectsDb, remoteHostsDb, scheduledTasksDb, sessionsDb, tasksDb } from './modules/database/index.js';
import { buildTasksRouter, createTasksService } from './modules/tasks/index.js';
import { createGitModule } from './modules/git/index.js';
import { worktreesRoutes } from './modules/worktrees/index.js';
import { buildOperatorRouter } from './modules/operators/operator.routes.js';
import { cleanOperatorWorkspaceLegacySessions } from './modules/operators/operator-cleanup.service.js';
import { scheduleAutoVerdict } from './modules/operators/operator-verdict.service.js';
import { sessionsService, setSessionRenameHook } from './modules/providers/services/sessions.service.js';
import { createSessionTransferService } from './modules/providers/services/session-transfer.service.js';
import { validateApiKey, authenticateToken, authenticateWebSocket } from './middleware/auth.js';
import { IS_PLATFORM } from './constants/config.js';
import { c } from './utils/colors.js';
import { appConfig as getAppConfig } from './modules/config/config.js';
import { buildConfigReadRouter, buildConfigWriteRouter } from './modules/config/config.routes.js';
import { syncProviderEnv } from './modules/config/env-sync.js';
import { createSchedulerService, buildSchedulerRouter } from './modules/scheduler/index.js';
import { getOperatorConfig } from './modules/operators/operator.config.js';
import { createOperatorExecService } from './modules/operators/operator-exec.service.js';
import { buildOperatorSkillExecRouter } from './modules/operators/operator-skill-exec.routes.js';
import { operatorAuditDb } from './modules/database/repositories/operator-audit.db.js';
import { createRemoteAgentsRegistry } from './modules/remote-agents/remote-agents.registry.js';
import { createRemoteAgentWss } from './modules/remote-agents/remote-agent.server.js';
import { createRemoteRouting } from './modules/remote-agents/remote-spawn.js';
import { createRemoteFsClient, REMOTE_MAX_READ_BYTES, REMOTE_MAX_UPLOAD_BYTES } from './modules/remote-agents/remote-fs.service.js';
import { createRemoteHistoryClient } from './modules/remote-agents/remote-history.service.js';
import { createRemoteAgentsRouter } from './modules/remote-agents/remote-agents.routes.js';
import { setRemoteAgentsRuntime, getRemoteAgentsRuntime } from './modules/remote-agents/runtime.js';
import { refreshRemoteProjectsIndex, lookupRemoteHost, setOnlineHostsLookup } from './modules/remote-agents/remote-projects.index.js';
import { runBootstrap } from './modules/remote-agents/bootstrap.service.js';
import { createSshRunner, createScpPush, createSshpassPubkeyInjector } from './modules/remote-agents/ssh-runner.js';
import { buildLitePackage } from './modules/remote-agents/lite-package.js';
import { createRemoteTunnels } from './modules/remote-agents/remote-tunnels.js';
import { createCompleteMessage } from './shared/utils.js';

const __dirname = getModuleDir(import.meta.url);
// The server source runs from /server, while the compiled output runs from /dist-server/server.
// Resolving the app root once keeps every repo-level lookup below aligned across both layouts.
const APP_ROOT = findAppRoot(__dirname);
const installMode = fs.existsSync(path.join(APP_ROOT, '.git')) ? 'git' : 'npm';
// Version of the code that is actually running, captured once at process
// startup. This intentionally does NOT re-read package.json per request: after
// an update replaces the files on disk, package.json reflects the NEW version
// while this long-lived process still runs the OLD code. The frontend bundle is
// rebuilt on update, so a mismatch between this value and the frontend's
// build-time version means the server was updated but not restarted.
const RUNNING_VERSION = (() => {
    try {
        return JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version || null;
    } catch {
        return null;
    }
})();
const MAX_FILE_UPLOAD_SIZE_MB = 200;
const MAX_FILE_UPLOAD_SIZE_BYTES = MAX_FILE_UPLOAD_SIZE_MB * 1024 * 1024;
const MAX_FILE_UPLOAD_COUNT = 20;

// Config singleton (Task 5/6): server-level runtime parameters now live in
// <DATA_DIR>/app.config.json instead of env. The snapshot below is read once at
// boot so port/host/fs-concurrency/cors stay stable for the process lifetime.
const cfgStore = getAppConfig();
const cfg = cfgStore.get();

// Boot: surface provider credentials to child processes (claude/codex/opencode/
// qoder CLIs inherit process.env). Called after the config snapshot so the
// values come straight from app.config.json.
syncProviderEnv(cfg);

console.log('SERVER_PORT from config:', cfg.server.port);

function readUsageNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

const app = express();
const server = http.createServer(app);

// ---------------------------------------------------------------------------
// Remote agents (远程项目) wiring.
// ---------------------------------------------------------------------------

// Resolved data dir (<dataDir>/app.config.json → dirname). AppConfig has no
// dataDir field, so derive it from the config file path the store resolved.
const remoteDataDir = path.dirname(cfgStore.filePath);

// Lovdex ed25519 keypair under <dataDir>/ssh. Generated once (idempotent) so the
// public key can be authorized on remote hosts and the private key drives the
// ssh/scp bootstrap transport. The private key path is the bootstrap identity.
const remoteSshDir = path.join(remoteDataDir, 'ssh');
const identityFile = path.join(remoteSshDir, 'lovdex_ed25519');
const remotePublicKeyPath = `${identityFile}.pub`;
if (!fs.existsSync(identityFile)) {
    try {
        fs.mkdirSync(remoteSshDir, { recursive: true });
        execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', identityFile, '-C', 'lovdex-remote'], {
            cwd: remoteSshDir,
        });
    } catch (e) {
        console.error('[remote-agents] ssh key provisioning failed:', e);
    }
}
let remotePublicKey = '';
try {
    remotePublicKey = fs.readFileSync(remotePublicKeyPath, 'utf8').trim();
} catch (e) {
    console.error('[remote-agents] could not read public key:', e);
}

// Construct the remote stack ONCE. The registry, fs client and routing all share
// this single registry instance (the ws endpoint below receives the same one),
// and the routing subscribes the push bus exactly once at construction.
const remoteAgentsRegistry = createRemoteAgentsRegistry();
const remoteFsClient = createRemoteFsClient(() => remoteAgentsRegistry);
const remoteHistoryClient = createRemoteHistoryClient(() => remoteAgentsRegistry);
// Raw lite SDK event → writer-ready NormalizedMessage[]. Mirrors the local
// claude path: synthetic `complete` becomes a completion message; every other
// event flows through transformMessage + the shared session normalizer.
//
// Remote chat history rides the `session/messages` RPC (lite reads the
// transcript it owns and returns raw file contents) — fetchHistory in the
// claude/qoder providers routes to it via remoteHistoryClient below.
const normalizeRemoteEvent = (raw, sid) => {
    if (raw && typeof raw === 'object' && raw.type === 'complete') {
        // exitCode travels on the payload: the lite pushes exitCode 1 + error on
        // a genuine run failure so the session surfaces as failed, not a clean
        // complete{exitCode:0} (I1 review fix).
        return [createCompleteMessage({ provider: 'claude', sessionId: sid ?? raw.providerSessionId ?? null, exitCode: raw.exitCode ?? 0 })];
    }
    const transformed = transformMessage(raw);
    return sessionsService.normalizeMessage('claude', transformed, sid);
};
const remoteRouting = createRemoteRouting({
    lookupHost: lookupRemoteHost,
    registry: remoteAgentsRegistry,
    normalizeEvent: normalizeRemoteEvent,
});
setRemoteAgentsRuntime({ registry: remoteAgentsRegistry, fsClient: remoteFsClient, historyClient: remoteHistoryClient });
// The path-routing fallback reads the LIVE registry on every lookup (worktrees
// and other non-project paths), so hand it a lazy thunk rather than a snapshot.
setOnlineHostsLookup(() => remoteAgentsRegistry.list());

// Provider runtimes keyed by provider id. Shared by the WebSocket server
// (interactive chat.send path) and the headless task-run launcher (operator
// start_task_execution path) so there is one source of truth.
//
// All four providers are routed through remoteRouting.wrapSpawn: a spawn whose
// project path resolves to a remote host is forwarded over the ws rpc/push bus
// (each provider knows its id so session/start can dispatch on the lite, and
// the lite's `_remoteNorm` messages pass through untouched); local paths fall
// straight through to the in-process runner.
const spawnFns = {
    claude: remoteRouting.wrapSpawn('claude', queryClaudeSDK),
    codex: remoteRouting.wrapSpawn('codex', queryCodex),
    opencode: remoteRouting.wrapSpawn('opencode', queryOpenCode),
    qoder: remoteRouting.wrapSpawn('qoder', queryQoder),
};

// Single WebSocket server that handles chat.
const wss = createWebSocketServer(server, {
    verifyClient: {
        isPlatform: IS_PLATFORM,
        authenticateWebSocket,
    },
    chat: {
        spawnFns,
        abortFns: {
            claude: remoteRouting.wrapAbort(abortClaudeSDKSession),
            codex: abortCodexSession,
            opencode: abortOpenCodeSession,
            qoder: abortQoderSession,
        },
        // Pending tool approvals may be owned by either interactive provider
        // (Claude's SDK callback or Qoder's stdio control protocol) or a remote
        // lite host. Request ids are globally-unique UUIDs, so the routing
        // resolves remote-owned approvals over the ws bus and dispatches the
        // rest to both local resolvers — the one that does not own the request
        // is a no-op.
        resolveToolApproval: remoteRouting.wrapResolveToolApproval((requestId, payload) => {
            resolveToolApproval(requestId, payload);
            resolveQoderToolApproval(requestId, payload);
        }),
        getPendingApprovalsForSession: (providerSessionId) => {
            const remote = remoteRouting.getPendingApprovals(providerSessionId);
            if (remote.length > 0) return remote;
            return [
                ...getPendingApprovalsForSession(providerSessionId),
                ...getQoderPendingApprovalsForSession(providerSessionId),
            ];
        },
    },
    terminal: {
        spawnPty: (shell, args, options) => pty.spawn(shell, args, options),
        shell: process.env.SHELL || '/bin/bash',
        cwd: WORKSPACES_ROOT,
        // Remote terminal: -i identity + ssh target from the remote_hosts row.
        // Both are in scope here (identityFile at module top; remoteHostsDb above).
        identityFile,
        resolveRemoteHost: (hostId) => {
            const host = remoteHostsDb.getById(hostId);
            return host ? { host: host.host, port: host.port ?? 22, sshUser: host.ssh_user } : null;
        },
    },
});

// Make WebSocket server available to routes
app.locals.wss = wss;

// Remote-agent control channel: lite agents dial back over ws (?token=…) and are
// bound to the host their token hashes to. Shares the SAME registry instance as
// the routing above so pushes/rpcs demux to the right in-flight session. The
// verifyToken / onHostOnline / onHostOffline callbacks each guard their body so
// a DB hiccup logs and continues rather than crashing the ws event loop.
const remoteAgentWss = createRemoteAgentWss(server, {
    verifyToken: (token) => {
        try {
            if (!token) return null;
            const host = remoteHostsDb.getByTokenHash(createHash('sha256').update(token).digest('hex'));
            return host ? host.host_id : null;
        } catch (e) {
            console.error('[remote-agents]', e);
            return null;
        }
    },
    registry: remoteAgentsRegistry,
    onHostOnline: (hostId) => {
        try {
            remoteHostsDb.updateStatus(hostId, 'online');
            remoteHostsDb.touchSeen(hostId);
        } catch (e) {
            console.error('[remote-agents]', e);
        }
    },
    onHostOffline: (hostId) => {
        try {
            remoteHostsDb.updateStatus(hostId, 'offline');
        } catch (e) {
            console.error('[remote-agents]', e);
        }
    },
});
app.locals.remoteAgentWss = remoteAgentWss;

// CORS: allow cross-origin frontends / business services to call this API.
// corsOrigin may be "*" (default), a single origin, or a comma-separated allowlist.
const corsOriginRaw = cfg.server.corsOrigin || '*';
const corsOrigin = corsOriginRaw === '*'
    ? '*'
    : corsOriginRaw.split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({
    origin: corsOrigin,
    exposedHeaders: ['X-Refreshed-Token'],
}));
app.use(express.json({
    limit: '50mb',
    type: (req) => {
        // Skip multipart/form-data requests (for file uploads like images)
        const contentType = req.headers['content-type'] || '';
        if (contentType.includes('multipart/form-data')) {
            return false;
        }
        return contentType.includes('json');
    }
}));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// TEMPORARY debug sink for the "no reply" investigation. Frontend traces POST
// here (works even when the chat WS is down, since the HTTP proxy is fine),
// and we append them to /tmp/chat-debug.log so they can be read server-side.
app.post('/api/__dbglog', (req, res) => {
    try {
        const msg = typeof req.body?.msg === 'string' ? req.body.msg.slice(0, 500) : JSON.stringify(req.body).slice(0, 500);
        fs.appendFileSync('/tmp/chat-debug.log', `${new Date().toISOString()} [FE] ${msg}\n`);
    } catch {
        // ignore
    }
    res.json({ ok: true });
});

// Public health check endpoint (no authentication required)
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        installMode,
        version: RUNNING_VERSION
    });
});

// Optional API key validation (if configured)
app.use('/api', validateApiKey);

// Auth routes (public login + token validation). Mounted under /api so the
// API-key check above still applies; login/me themselves require no token.
app.use('/api/auth', authRoutes);

// Config HTTP API. GET is anonymous (the login page must read public settings
// like server.isPlatform before a token exists); PUT requires a valid JWT.
app.use('/api/config', buildConfigReadRouter({ cfg: cfgStore }));
app.use('/api/config', authenticateToken, buildConfigWriteRouter({ cfg: cfgStore }));

// Projects API Routes
app.use('/api/projects', authenticateToken, projectModuleRoutes);

// Remote-agent REST: host CRUD, pubkey, deploy (blocking ssh/scp bootstrap) and
// remote directory browsing. Behind the same auth gate as the rest of /api.
// Per-host ssh -R reverse tunnels: hosts whose subnet cannot reach this server
// (VLAN/firewall isolated) reconnect through a main→target forward instead of
// dialing the LAN URL directly — see remote-tunnels.ts.
const remoteTunnels = createRemoteTunnels({ identityFile, forwardPort: cfg.server.port });

app.use('/api/remote-agents', authenticateToken, createRemoteAgentsRouter({
    repo: remoteHostsDb,
    registry: remoteAgentsRegistry,
    fsClient: remoteFsClient,
    publicKey: remotePublicKey,
    identityFile,
    tunnels: remoteTunnels,
    // The lite dials back to this ws URL. The localhost default is correct for
    // loopback E2E (ssh host == the Lovdex host); for a real remote host the
    // operator MUST set LOVDEX_PUBLIC_WS_URL to an address reachable from it.
    serverUrl: process.env.LOVDEX_PUBLIC_WS_URL ?? `ws://localhost:${cfg.server.port}/api/remote-agents/ws`,
    // One-time password → pubkey injection (ssh-copy-id equivalent) for the
    // add-host wizard. The password is used once to authorize the Lovdex pubkey
    // then discarded — never persisted. See createSshpassPubkeyInjector for the
    // v1 intranet argv-visibility tradeoff.
    injectPubkey: createSshpassPubkeyInjector(),
    // Deterministic per-host token: HMAC-SHA256(hostId) keyed by the server's
    // jwt secret. The token (and its sha256) is stable across redeploys, so a
    // running lite whose token is rotated by a failed deploy is never bricked
    // (I2 review fix) — redeploy reuses the same token.
    tokenFor: (hostId) => {
        const secret = cfg.auth?.jwtSecret || 'lovdex-remote-agents';
        const token = createHmac('sha256', secret).update(hostId).digest('hex');
        remoteHostsDb.setTokenHash(hostId, createHash('sha256').update(token).digest('hex'));
        return token;
    },
    // Real ssh/scp transport. The scp destination (user@host) is derived from
    // the per-deploy input, so createScpPush is built per invocation. The lite
    // is built + tarred fresh per deploy (C1) so install.sh always has a
    // runnable dist/lite.mjs — a deploy with nothing to run would otherwise
    // report `online` for a remote that can never dial back.
    bootstrap: async (input) => {
        const { tarballPath } = await buildLitePackage({
            sourceDir: path.join(__dirname, '..', 'remote-agent'),
            esbuildBin: path.join(__dirname, '..', 'node_modules', 'esbuild', 'bin', 'esbuild'),
        });
        try {
            // litePackagePath belongs on the BootstrapInput (runBootstrap reads
            // input.litePackagePath and pushes it to ~/.lovdex-remote/lite.tgz);
            // passing it in deps was silently ignored and left the remote with
            // no runnable bundle → install.sh "nothing to run" (fix).
            const inputWithPackage = { ...input, litePackagePath: tarballPath };
            return await runBootstrap(inputWithPackage, {
                runner: createSshRunner(),
                push: createScpPush({
                    identityFile: input.identityFile,
                    port: input.port,
                    remote: `${input.sshUser}@${input.host}`,
                }),
                installScriptPath: path.join(__dirname, '..', 'remote-agent', 'deploy', 'install.sh'),
                unitTemplatePath: path.join(__dirname, '..', 'remote-agent', 'deploy', 'systemd-unit.template'),
            });
        } finally {
            // The bundle was built for THIS deploy only; drop the temp tarball.
            fs.rmSync(tarballPath, { force: true });
        }
    },
}));

// Chat image asset upload/serving (global ~/.cloudcli/assets store, protected)
app.use('/api/assets', authenticateToken, assetsRoutes);

// Commands API Routes (protected)
app.use('/api/commands', authenticateToken, commandsRoutes);

// Session fork/rewind API Routes (protected)
app.use('/api/sessions', authenticateToken, sessionsRoutes);

// User API Routes (protected)
app.use('/api/user', authenticateToken, userRoutes);

// Unified provider MCP routes (protected)
app.use('/api/providers', authenticateToken, providerRoutes);

// Tasks API Routes (protected)
// Broadcast task_upserted / task_deleted events to connected WS clients. This
// is the foundation for live board updates; the frontend subscribes over WS.
const broadcastTask = (event) => {
    connectedClients.forEach((client) => {
        if (client.readyState === WS_OPEN_STATE) client.send(JSON.stringify(event));
    });
};
const tasksService = createTasksService(tasksDb, {
    broadcast: broadcastTask,
    deps: { projectsDb, sessionsDb },
    // Reconstruct the board's "等你批准" overlay on load/reconnect by reading
    // which sessions currently have pending tool approvals from the run registry.
    getPendingApprovalSessions: () => chatRunRegistry.listPendingApprovalSessions(),
    // Auto-verdict trigger (T9): when a non-operator session completes, schedule
    // a headless operator run that judges the transcript and writes a summary +
    // verdict onto the task. The is_operator check is the recursion guard —
    // operator sessions never trigger their own verdict.
    onTaskCompleted: (taskId, title, sessionId) => {
        if (!sessionId) return;
        const sessionRow = sessionsDb.getSessionById(sessionId);
        const isOperator = Boolean(sessionRow?.is_operator);
        scheduleAutoVerdict(sessionId, taskId, title, isOperator);
    },
});
// Wire session lifecycle → task status transitions (task↔session linkage).
setTaskLinkage(tasksService);

// Session rename → linked task title sync (bidirectional name consistency).
// The hook fires only after the rename persisted; sync failures are caught at
// the invocation site (sessions.service renameSessionById).
setSessionRenameHook((sessionId, name) => tasksService.syncTaskTitleFromSession(sessionId, name));

// On startup, mark any in_progress task whose linked session is no longer
// running as failed. A run that died without a terminal session_status (backend
// restart, crash, SIGKILL) would otherwise read as "进行中" forever; this
// persists sub_status='failed' so the board shows the "失败" badge on load.
try {
    tasksService.reconcileFailedTasks(() => new Set(chatRunRegistry.listRunningRuns().map((run) => run.sessionId)));
} catch (err) {
    console.error('reconcileFailedTasks on startup failed:', err);
}

// On startup, backfill task execution sessions that have no name with the
// linked task's title, so the sidebar shows which task each session belongs to.
try {
    const backfilled = tasksService.backfillSessionNames();
    if (backfilled > 0) {
        console.log(`[tasks] backfilled ${backfilled} session name(s) from task titles`);
    }
} catch (err) {
    console.error('backfillSessionNames on startup failed:', err);
}

// SessionCreator used by both the HTTP tasks router and the operator tool set:
// allocates a new app-facing session id for a provider+project (+ operator flag).
// Defined once so start_task_execution and POST /api/tasks/:id/start always get
// the same closure — a missing createSession makes the operator tool's
// start_task_execution call `undefined(...)` → "createSession is not a function".
const createAppSession = (provider, projectPath, isOperator) =>
    sessionsDb.createAppSession(crypto.randomUUID(), provider, projectPath, isOperator);

// Headless task-run launcher for the operator's start_task_execution tool.
// Mirrors the browser's chat.send: after startExecution creates + links the
// session, this kicks off the agent run server-side (no socket) so the task
// actually executes — without it the task sat idle in todo with started_at
// null. Prompt mirrors taskPromptOf (description falling back to title).
const startTaskRun = (taskId, sessionId) => {
    const task = tasksService.getTask(taskId);
    let content = (task?.description ?? '').trim() || task?.title || '';
    // Mirror taskPromptOf's slash guard: a leading "/" would make the provider
    // CLI parse the whole task prompt as a command and end the run with no
    // output, leaving an empty session.
    if (content.startsWith('/')) content = `执行以下任务：\n${content}`;
    return startHeadlessTaskRun(sessionId, {
        content,
        model: task?.executor_model ?? null,
        spawnFns,
    });
};

// Scheduled tasks: 15s tick dispatch. Missed runs during downtime are skipped
// but surfaced as a single label=reminder task (see scheduler service). Reuses
// broadcastTask so scheduled_task_upserted/deleted reach every WS client.
const schedulerService = createSchedulerService({
    scheduledTasksDb: {
        ...scheduledTasksDb,
        operatorWorkspacePath: getOperatorConfig().workspace,
    },
    tasksService,
    createSession: createAppSession,
    startTaskRun,
    broadcast: broadcastTask,
});

// Session-transfer primitive for the operator tool set: moves a task + its
// session between registered projects (relocating the Claude transcript file so
// history keeps resolving and a later rescan doesn't revert the move).
// isSessionRunning guards against relocating a live agent's transcript mid-write.
const sessionTransferService = createSessionTransferService({
    projectsDb,
    sessionsDb,
    tasksService,
    isSessionRunning: (sessionId) => chatRunRegistry.listRunningRuns().some((run) => run.sessionId === sessionId),
});

// In-place execution for the operator (execute_skill / workbench): allowlisted
// user-level skills + workspace-confined file ops. Every call (allowed or
// denied) lands in operator_exec_audit; credentials resolve at call instant
// inside the service and never touch the task table/transcript/logs.
const operatorExecService = createOperatorExecService({
    home: getOperatorConfig().workspace,
    audit: (entry) => operatorAuditDb.insert(entry),
});

// Wire the operator headless run deps: the real tasksService (adapted so the
// string-typed operator tool inputs are narrowed to TaskStatus at the boundary),
// projectsDb, sessionsService, and createSession. runOperatorHeadless (in
// claude-sdk.js) uses these to build the closed operator tool set when
// auto-verdict runs.
initOperatorHeadless({
    tasks: adaptTasksServiceForOperatorTools(tasksService),
    projects: projectsDb,
    sessions: sessionsService,
    createSession: createAppSession,
    startTaskRun,
    // Scheduled-task templates (list/get/create/update/remove) so the assistant
    // can manage 定时任务. Injected directly — schedulerService already exposes
    // the exact OperatorToolDeps.scheduledTasks shape.
    scheduledTasks: schedulerService,
    // Session transfer: move a task + session between registered projects.
    moveSessionToProject: sessionTransferService.moveSessionToProject,
    // In-place execution: allowlisted skills + workspace workbench.
    skillExec: operatorExecService.executeSkill,
    workbench: operatorExecService.workbench,
    // The assistant's context is the Lovdex助手 workspace: create_task without
    // an explicit projectPath falls back here and lands as an is_operator task.
    contextProjectPath: getOperatorConfig().workspace,
    contextIsOperatorWorkspace: true,
});

app.use('/api/tasks', authenticateToken, buildTasksRouter(tasksService, {
    createSession: createAppSession,
}));
app.use('/api/scheduled-tasks', authenticateToken, buildSchedulerRouter(schedulerService));

// Git (Source Control) API Routes (protected)
app.use('/api/git', authenticateToken, createGitModule());

// Git worktrees API Routes (protected)
app.use('/api/worktrees', authenticateToken, worktreesRoutes);

// Operator settings API (protected) — read/update operator automation config.
app.use('/api/operator/settings', authenticateToken, buildOperatorRouter());

// Operator skill-execution settings API (protected) — allowlist config,
// credential status/write/test, and the exec audit viewer (all sanitized).
app.use(
    '/api/operator/skill-exec',
    authenticateToken,
    buildOperatorSkillExecRouter({ execService: operatorExecService }),
);

// Frontend now uses window.location for WebSocket URLs.

const expandWorkspacePath = (inputPath) => {
    if (!inputPath) return inputPath;
    if (inputPath === '~') {
        return WORKSPACES_ROOT;
    }
    if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
        return path.join(WORKSPACES_ROOT, inputPath.slice(2));
    }
    return inputPath;
};

// Browse filesystem endpoint for project suggestions - uses existing getFileTree
app.get('/api/browse-filesystem', authenticateToken, async (req, res) => {
    try {
        const { path: dirPath } = req.query;

        console.log('[API] Browse filesystem request for path:', dirPath);
        console.log('[API] WORKSPACES_ROOT is:', WORKSPACES_ROOT);
        // Default to home directory if no path provided
        const defaultRoot = WORKSPACES_ROOT;
        let targetPath = dirPath ? expandWorkspacePath(dirPath) : defaultRoot;

        // Resolve and normalize the path
        targetPath = path.resolve(targetPath);

        // Security check - ensure path is within allowed workspace root
        const validation = await validateWorkspacePath(targetPath);
        if (!validation.valid) {
            return res.status(403).json({ error: validation.error });
        }
        const resolvedPath = validation.resolvedPath || targetPath;

        // Security check - ensure path is accessible
        try {
            await fs.promises.access(resolvedPath);
            const stats = await fs.promises.stat(resolvedPath);

            if (!stats.isDirectory()) {
                return res.status(400).json({ error: 'Path is not a directory' });
            }
        } catch (err) {
            return res.status(404).json({ error: 'Directory not accessible' });
        }

        // Use existing getFileTree function with shallow depth (only direct children)
        const fileTree = await getFileTree(resolvedPath, 1, 0, false); // maxDepth=1, showHidden=false

        // Filter only directories and format for suggestions
        const directories = fileTree
            .filter(item => item.type === 'directory')
            .map(item => ({
                path: item.path,
                name: item.name,
                type: 'directory'
            }))
            .sort((a, b) => {
                const aHidden = a.name.startsWith('.');
                const bHidden = b.name.startsWith('.');
                if (aHidden && !bHidden) return 1;
                if (!aHidden && bHidden) return -1;
                return a.name.localeCompare(b.name);
            });

        // Add common directories if browsing home directory
        const suggestions = [];
        let resolvedWorkspaceRoot = defaultRoot;
        try {
            resolvedWorkspaceRoot = await fsPromises.realpath(defaultRoot);
        } catch (error) {
            // Use default root as-is if realpath fails
        }
        if (resolvedPath === resolvedWorkspaceRoot) {
            const commonDirs = ['Desktop', 'Documents', 'Projects', 'Development', 'Dev', 'Code', 'workspace'];
            const existingCommon = directories.filter(dir => commonDirs.includes(dir.name));
            const otherDirs = directories.filter(dir => !commonDirs.includes(dir.name));

            suggestions.push(...existingCommon, ...otherDirs);
        } else {
            suggestions.push(...directories);
        }

        res.json({
            path: resolvedPath,
            suggestions: suggestions
        });

    } catch (error) {
        console.error('Error browsing filesystem:', error);
        res.status(500).json({ error: 'Failed to browse filesystem' });
    }
});

app.post('/api/create-folder', authenticateToken, async (req, res) => {
    try {
        const { path: folderPath } = req.body;
        if (!folderPath) {
            return res.status(400).json({ error: 'Path is required' });
        }
        const expandedPath = expandWorkspacePath(folderPath);
        const resolvedInput = path.resolve(expandedPath);
        const validation = await validateWorkspacePath(resolvedInput);
        if (!validation.valid) {
            return res.status(403).json({ error: validation.error });
        }
        const targetPath = validation.resolvedPath || resolvedInput;
        const parentDir = path.dirname(targetPath);
        try {
            await fs.promises.access(parentDir);
        } catch (err) {
            return res.status(404).json({ error: 'Parent directory does not exist' });
        }
        try {
            await fs.promises.access(targetPath);
            return res.status(409).json({ error: 'Folder already exists' });
        } catch (err) {
            // Folder doesn't exist, which is what we want
        }
        try {
            await fs.promises.mkdir(targetPath, { recursive: false });
            res.json({ success: true, path: targetPath });
        } catch (mkdirError) {
            if (mkdirError.code === 'EEXIST') {
                return res.status(409).json({ error: 'Folder already exists' });
            }
            throw mkdirError;
        }
    } catch (error) {
        console.error('Error creating folder:', error);
        res.status(500).json({ error: 'Failed to create folder' });
    }
});

// Read file content endpoint
app.get('/api/projects/:projectId/file', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const { filePath } = req.query;


        // Security: ensure the requested path is inside the project root
        if (!filePath) {
            return res.status(400).json({ error: 'Invalid file path' });
        }

        // Resolve the absolute project root via the DB-backed helper; the
        // caller passes the DB-assigned `projectId`, not a folder name.
        const projectRoot = await projectsDb.getProjectPathById(projectId);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Handle both absolute and relative paths
        const resolved = path.isAbsolute(filePath)
            ? path.resolve(filePath)
            : path.resolve(projectRoot, filePath);
        const normalizedRoot = path.resolve(projectRoot) + path.sep;
        if (!resolved.startsWith(normalizedRoot)) {
            return res.status(403).json({ error: 'Path must be under project root' });
        }

        // Route to a remote host when the project is backed by one.
        const hostId = lookupRemoteHost(projectRoot);
        if (hostId) {
            const { fsClient } = getRemoteAgentsRuntime();
            const r = await fsClient.read(hostId, resolved);
            return res.json({ content: r.content, path: resolved });
        }

        const content = await fsPromises.readFile(resolved, 'utf8');
        res.json({ content, path: resolved });
    } catch (error) {
        console.error('Error reading file:', error);
        if (resolveErrorCode(error) === 'ENOENT') {
            res.status(404).json({ error: 'File not found' });
        } else if (resolveErrorCode(error) === 'EACCES') {
            res.status(403).json({ error: 'Permission denied' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// Serve raw file bytes for previews and downloads.
app.get('/api/projects/:projectId/files/content', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const { path: filePath } = req.query;


        // Security: ensure the requested path is inside the project root
        if (!filePath) {
            return res.status(400).json({ error: 'Invalid file path' });
        }

        // Projects are now addressed by DB `projectId`, resolved to their path here.
        const projectRoot = await projectsDb.getProjectPathById(projectId);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Match the text reader endpoint so callers can pass either project-relative
        // or absolute paths without changing how the bytes are served.
        const resolved = path.isAbsolute(filePath)
            ? path.resolve(filePath)
            : path.resolve(projectRoot, filePath);
        const normalizedRoot = path.resolve(projectRoot) + path.sep;
        if (!resolved.startsWith(normalizedRoot)) {
            return res.status(403).json({ error: 'Path must be under project root' });
        }

        // Route to a remote host when the project is backed by one. The remote
        // read returns base64 (capped at 32 MiB) instead of a local stream.
        const hostId = lookupRemoteHost(projectRoot);
        if (hostId) {
            const { fsClient } = getRemoteAgentsRuntime();
            let remote;
            try {
                remote = await fsClient.read(hostId, resolved, REMOTE_MAX_READ_BYTES, 'base64');
            } catch (error) {
                const code = resolveErrorCode(error);
                const status = code === 'ENOENT' ? 404 : code === 'EACCES' ? 403 : 500;
                const message = code === 'ENOENT' ? 'File not found' : code === 'EACCES' ? 'Permission denied' : error.message;
                return res.status(status).json({ error: message });
            }
            if (remote.truncated) {
                return res.status(413).json({ error: 'File too large to preview/download remotely (limit 32MB)' });
            }
            const mimeType = mime.lookup(resolved) || 'application/octet-stream';
            res.setHeader('Content-Type', mimeType);
            return res.end(Buffer.from(remote.content, 'base64'));
        }

        // Check if file exists
        try {
            await fsPromises.access(resolved);
        } catch (error) {
            return res.status(404).json({ error: 'File not found' });
        }

        // Get file extension and set appropriate content type
        const mimeType = mime.lookup(resolved) || 'application/octet-stream';
        res.setHeader('Content-Type', mimeType);

        // Stream the file
        const fileStream = fs.createReadStream(resolved);
        fileStream.pipe(res);

        fileStream.on('error', (error) => {
            console.error('Error streaming file:', error);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Error reading file' });
            }
        });

    } catch (error) {
        console.error('Error serving binary file:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        }
    }
});

// Save file content endpoint
app.put('/api/projects/:projectId/file', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const { filePath, content } = req.body;


        // Security: ensure the requested path is inside the project root
        if (!filePath) {
            return res.status(400).json({ error: 'Invalid file path' });
        }

        if (content === undefined) {
            return res.status(400).json({ error: 'Content is required' });
        }

        // Projects are now addressed by DB `projectId`, resolved to their path here.
        const projectRoot = await projectsDb.getProjectPathById(projectId);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Handle both absolute and relative paths
        const resolved = path.isAbsolute(filePath)
            ? path.resolve(filePath)
            : path.resolve(projectRoot, filePath);
        const normalizedRoot = path.resolve(projectRoot) + path.sep;
        if (!resolved.startsWith(normalizedRoot)) {
            return res.status(403).json({ error: 'Path must be under project root' });
        }

        // Route to a remote host when the project is backed by one.
        const hostId = lookupRemoteHost(projectRoot);
        if (hostId) {
            const { fsClient } = getRemoteAgentsRuntime();
            await fsClient.write(hostId, resolved, content);
            return res.json({
                success: true,
                path: resolved,
                message: 'File saved successfully'
            });
        }

        // Write the new content
        await fsPromises.writeFile(resolved, content, 'utf8');

        res.json({
            success: true,
            path: resolved,
            message: 'File saved successfully'
        });
    } catch (error) {
        console.error('Error saving file:', error);
        if (resolveErrorCode(error) === 'ENOENT') {
            res.status(404).json({ error: 'File or directory not found' });
        } else if (resolveErrorCode(error) === 'EACCES') {
            res.status(403).json({ error: 'Permission denied' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

app.get('/api/projects/:projectId/files', authenticateToken, async (req, res) => {
    try {

        // Using fsPromises from import

        // Resolve the project's absolute path through the DB (projectId is the
        // primary key of the `projects` table after the identifier migration).
        const actualPath = await projectsDb.getProjectPathById(req.params.projectId);
        if (!actualPath) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Route to a remote host when the project is backed by one.
        const hostId = lookupRemoteHost(actualPath);
        if (hostId) {
            // actualPath 与 projectRoot 同值（getProjectPathById），保持与其他端点一致
            const { fsClient } = getRemoteAgentsRuntime();
            const { nodes } = await fsClient.tree(hostId, actualPath, 10, true);
            return res.json(nodes);
        }

        // Check if path exists
        try {
            await fsPromises.access(actualPath);
        } catch (e) {
            return res.status(404).json({ error: `Project path not found: ${actualPath}` });
        }

        const files = await getFileTree(actualPath, 10, 0, true);
        res.json(files);
    } catch (error) {
        console.error('[ERROR] File tree error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================================
// FILE OPERATIONS API ENDPOINTS
// ============================================================================

/**
 * Validate that a path is within the project root
 * @param {string} projectRoot - The project root path
 * @param {string} targetPath - The path to validate
 * @returns {{ valid: boolean, resolved?: string, error?: string }}
 */
function validatePathInProject(projectRoot, targetPath) {
    const resolved = path.isAbsolute(targetPath)
        ? path.resolve(targetPath)
        : path.resolve(projectRoot, targetPath);
    const normalizedRoot = path.resolve(projectRoot) + path.sep;
    if (!resolved.startsWith(normalizedRoot)) {
        return { valid: false, error: 'Path must be under project root' };
    }
    return { valid: true, resolved };
}

/**
 * Validate filename - check for invalid characters
 * @param {string} name - The filename to validate
 * @returns {{ valid: boolean, error?: string }}
 */
function validateFilename(name) {
    if (!name || !name.trim()) {
        return { valid: false, error: 'Filename cannot be empty' };
    }
    // Check for invalid characters (Windows + Unix)
    const invalidChars = /[<>:"/\\|?*\x00-\x1f]/;
    if (invalidChars.test(name)) {
        return { valid: false, error: 'Filename contains invalid characters' };
    }
    // Check for reserved names (Windows)
    const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
    if (reserved.test(name)) {
        return { valid: false, error: 'Filename is a reserved name' };
    }
    // Check for dots only
    if (/^\.+$/.test(name)) {
        return { valid: false, error: 'Filename cannot be only dots' };
    }
    return { valid: true };
}

/**
 * 从错误中取规范化 code：优先 error.code；RPC 传输层丢掉了 code，
 * 回退解析 message 前缀（"ENOENT: ..." / "EACCES: ..."），让远程路径
 * 也能命中既有的 error.code 分支（404/403/409）。
 */
function resolveErrorCode(error) {
  if (error?.code) return error.code;
  const m = /^([A-Z]+):/.exec(error?.message ?? '');
  return m ? m[1] : undefined;
}

// POST /api/projects/:projectId/files/create - Create new file or directory
app.post('/api/projects/:projectId/files/create', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const { path: parentPath, type, name } = req.body;

        // Validate input
        if (!name || !type) {
            return res.status(400).json({ error: 'Name and type are required' });
        }

        if (!['file', 'directory'].includes(type)) {
            return res.status(400).json({ error: 'Type must be "file" or "directory"' });
        }

        const nameValidation = validateFilename(name);
        if (!nameValidation.valid) {
            return res.status(400).json({ error: nameValidation.error });
        }

        // Resolve the project directory through the DB using the new projectId.
        const projectRoot = await projectsDb.getProjectPathById(projectId);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Build and validate target path
        const targetDir = parentPath || '';
        const targetPath = targetDir ? path.join(targetDir, name) : name;
        const validation = validatePathInProject(projectRoot, targetPath);
        if (!validation.valid) {
            return res.status(403).json({ error: validation.error });
        }

        const resolvedPath = validation.resolved;

        // Route to a remote host when the project is backed by one.
        const hostId = lookupRemoteHost(projectRoot);
        if (hostId) {
            const { fsClient } = getRemoteAgentsRuntime();
            await fsClient.create(hostId, parentPath || projectRoot, type, name);
            return res.json({
                success: true,
                path: resolvedPath,
                name,
                type,
                message: `${type === 'file' ? 'File' : 'Directory'} created successfully`
            });
        }

        // Check if already exists
        try {
            await fsPromises.access(resolvedPath);
            return res.status(409).json({ error: `${type === 'file' ? 'File' : 'Directory'} already exists` });
        } catch {
            // Doesn't exist, which is what we want
        }

        // Create file or directory
        if (type === 'directory') {
            await fsPromises.mkdir(resolvedPath, { recursive: false });
        } else {
            // Ensure parent directory exists
            const parentDir = path.dirname(resolvedPath);
            try {
                await fsPromises.access(parentDir);
            } catch {
                await fsPromises.mkdir(parentDir, { recursive: true });
            }
            await fsPromises.writeFile(resolvedPath, '', 'utf8');
        }

        res.json({
            success: true,
            path: resolvedPath,
            name,
            type,
            message: `${type === 'file' ? 'File' : 'Directory'} created successfully`
        });
    } catch (error) {
        console.error('Error creating file/directory:', error);
        if (resolveErrorCode(error) === 'EACCES') {
            res.status(403).json({ error: 'Permission denied' });
        } else if (resolveErrorCode(error) === 'ENOENT') {
            res.status(404).json({ error: 'Parent directory not found' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// PUT /api/projects/:projectId/files/rename - Rename file or directory
app.put('/api/projects/:projectId/files/rename', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const { oldPath, newName } = req.body;

        // Validate input
        if (!oldPath || !newName) {
            return res.status(400).json({ error: 'oldPath and newName are required' });
        }

        const nameValidation = validateFilename(newName);
        if (!nameValidation.valid) {
            return res.status(400).json({ error: nameValidation.error });
        }

        // Resolve the project directory through the DB using the new projectId.
        const projectRoot = await projectsDb.getProjectPathById(projectId);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Validate old path
        const oldValidation = validatePathInProject(projectRoot, oldPath);
        if (!oldValidation.valid) {
            return res.status(403).json({ error: oldValidation.error });
        }

        const resolvedOldPath = oldValidation.resolved;

        // Route to a remote host when the project is backed by one.
        const hostId = lookupRemoteHost(projectRoot);
        if (hostId) {
            const { fsClient } = getRemoteAgentsRuntime();
            const r = await fsClient.rename(hostId, resolvedOldPath, newName);
            return res.json({
                success: true,
                oldPath: resolvedOldPath,
                newPath: r.newPath,
                newName,
                message: 'Renamed successfully'
            });
        }

        // Check if old path exists
        try {
            await fsPromises.access(resolvedOldPath);
        } catch {
            return res.status(404).json({ error: 'File or directory not found' });
        }

        // Build and validate new path
        const parentDir = path.dirname(resolvedOldPath);
        const resolvedNewPath = path.join(parentDir, newName);
        const newValidation = validatePathInProject(projectRoot, resolvedNewPath);
        if (!newValidation.valid) {
            return res.status(403).json({ error: newValidation.error });
        }

        // Check if new path already exists
        try {
            await fsPromises.access(resolvedNewPath);
            return res.status(409).json({ error: 'A file or directory with this name already exists' });
        } catch {
            // Doesn't exist, which is what we want
        }

        // Rename
        await fsPromises.rename(resolvedOldPath, resolvedNewPath);

        res.json({
            success: true,
            oldPath: resolvedOldPath,
            newPath: resolvedNewPath,
            newName,
            message: 'Renamed successfully'
        });
    } catch (error) {
        console.error('Error renaming file/directory:', error);
        if (resolveErrorCode(error) === 'EACCES') {
            res.status(403).json({ error: 'Permission denied' });
        } else if (resolveErrorCode(error) === 'ENOENT') {
            res.status(404).json({ error: 'File or directory not found' });
        } else if (resolveErrorCode(error) === 'EXDEV') {
            res.status(400).json({ error: 'Cannot move across different filesystems' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// DELETE /api/projects/:projectId/files - Delete file or directory
app.delete('/api/projects/:projectId/files', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const { path: targetPath, type } = req.body;

        // Validate input
        if (!targetPath) {
            return res.status(400).json({ error: 'Path is required' });
        }

        // Resolve the project directory through the DB using the new projectId.
        const projectRoot = await projectsDb.getProjectPathById(projectId);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Validate path
        const validation = validatePathInProject(projectRoot, targetPath);
        if (!validation.valid) {
            return res.status(403).json({ error: validation.error });
        }

        const resolvedPath = validation.resolved;

        // Route to a remote host when the project is backed by one.
        const hostId = lookupRemoteHost(projectRoot);
        if (hostId) {
            // Prevent deleting the project root itself (mirrors the local path below).
            if (resolvedPath === path.resolve(projectRoot)) {
                return res.status(403).json({ error: 'Cannot delete project root directory' });
            }
            const { fsClient } = getRemoteAgentsRuntime();
            await fsClient.delete(hostId, resolvedPath, type);
            return res.json({
                success: true,
                path: resolvedPath,
                type,
                message: 'Deleted successfully'
            });
        }

        // Check if path exists and get stats
        let stats;
        try {
            stats = await fsPromises.stat(resolvedPath);
        } catch {
            return res.status(404).json({ error: 'File or directory not found' });
        }

        // Prevent deleting the project root itself
        if (resolvedPath === path.resolve(projectRoot)) {
            return res.status(403).json({ error: 'Cannot delete project root directory' });
        }

        // Delete based on type
        if (stats.isDirectory()) {
            await fsPromises.rm(resolvedPath, { recursive: true, force: true });
        } else {
            await fsPromises.unlink(resolvedPath);
        }

        res.json({
            success: true,
            path: resolvedPath,
            type: stats.isDirectory() ? 'directory' : 'file',
            message: 'Deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting file/directory:', error);
        if (error.code === 'EACCES') {
            res.status(403).json({ error: 'Permission denied' });
        } else if (error.code === 'ENOENT') {
            res.status(404).json({ error: 'File or directory not found' });
        } else if (error.code === 'ENOTEMPTY') {
            res.status(400).json({ error: 'Directory is not empty' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// POST /api/projects/:projectId/files/upload - Upload files
// Dynamic import of multer for file uploads
const uploadFilesHandler = async (req, res) => {
    // Dynamic import of multer
    const multer = (await import('multer')).default;

    const uploadMiddleware = multer({
        storage: multer.diskStorage({
            destination: (req, file, cb) => {
                cb(null, os.tmpdir());
            },
            filename: (req, file, cb) => {
                // Use a unique temp name, but preserve original name in file.originalname
                // Note: file.originalname may contain path separators for folder uploads
                const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
                // For temp file, just use a safe unique name without the path
                cb(null, `upload-${uniqueSuffix}`);
            }
        }),
        limits: {
            fileSize: MAX_FILE_UPLOAD_SIZE_BYTES,
            files: MAX_FILE_UPLOAD_COUNT
        }
    });

    // Use multer middleware
    uploadMiddleware.array('files', MAX_FILE_UPLOAD_COUNT)(req, res, async (err) => {
        if (err) {
            console.error('Multer error:', err);
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ error: `File too large. Maximum size is ${MAX_FILE_UPLOAD_SIZE_MB}MB.` });
            }
            if (err.code === 'LIMIT_FILE_COUNT') {
                return res.status(400).json({ error: `Too many files. Maximum is ${MAX_FILE_UPLOAD_COUNT} files.` });
            }
            return res.status(500).json({ error: err.message });
        }

        try {
            const { projectId } = req.params;
            const { targetPath, relativePaths, requestedFileCount: requestedFileCountRaw } = req.body;

            // Parse relative paths if provided (for folder uploads)
            let filePaths = [];
            if (relativePaths) {
                try {
                    filePaths = JSON.parse(relativePaths);
                } catch (e) {
                    console.log('[DEBUG] Failed to parse relativePaths:', relativePaths);
                }
            }

            console.log('[DEBUG] File upload request:', {
                projectId,
                targetPath: JSON.stringify(targetPath),
                targetPathType: typeof targetPath,
                filesCount: req.files?.length,
                relativePaths: filePaths
            });

            if (!req.files || req.files.length === 0) {
                return res.status(400).json({ error: 'No files provided' });
            }

            const parsedRequestedFileCount = Number.parseInt(requestedFileCountRaw, 10);
            const requestedFileCount = Number.isFinite(parsedRequestedFileCount) && parsedRequestedFileCount > 0
                ? parsedRequestedFileCount
                : req.files.length;

            // Resolve the project directory through the DB using the new projectId.
            const projectRoot = await projectsDb.getProjectPathById(projectId);
            if (!projectRoot) {
                return res.status(404).json({ error: 'Project not found' });
            }

            console.log('[DEBUG] Project root:', projectRoot);

            // Validate and resolve target path
            // If targetPath is empty or '.', use project root directly
            const targetDir = targetPath || '';
            let resolvedTargetDir;

            console.log('[DEBUG] Target dir:', JSON.stringify(targetDir));

            if (!targetDir || targetDir === '.' || targetDir === './') {
                // Empty path means upload to project root
                resolvedTargetDir = path.resolve(projectRoot);
                console.log('[DEBUG] Using project root as target:', resolvedTargetDir);
            } else {
                const validation = validatePathInProject(projectRoot, targetDir);
                if (!validation.valid) {
                    console.log('[DEBUG] Path validation failed:', validation.error);
                    return res.status(403).json({ error: validation.error });
                }
                resolvedTargetDir = validation.resolved;
                console.log('[DEBUG] Resolved target dir:', resolvedTargetDir);
            }

            // Route to a remote host when the project is backed by one. The lite
            // fs/write does not create missing parent dirs, so ancestors are
            // created first (mirrors the local mkdir -p below). Multer uses disk
            // storage here, so each temp file's Buffer is re-read for the RPC.
            const hostId = lookupRemoteHost(projectRoot);
            if (hostId) {
                const { fsClient } = getRemoteAgentsRuntime();
                const ensureRemoteParent = async (startDir, stopDir) => {
                    // Ancestor chain from startDir up to (but excluding) stopDir,
                    // deepest first. stopDir is always an ancestor of startDir.
                    const chain = [];
                    let cursor = startDir;
                    while (cursor !== stopDir && (cursor.startsWith(stopDir + path.sep) || cursor === stopDir)) {
                        chain.push(cursor);
                        const next = path.dirname(cursor);
                        if (next === cursor) break;
                        cursor = next;
                    }
                    // First existing level scanning deepest→shallowest; every
                    // level shallower than it must already exist.
                    let deepestExisting = -1;
                    for (let i = 0; i < chain.length; i++) {
                        const s = await fsClient.stat(hostId, chain[i]);
                        if (s.exists) { deepestExisting = i; break; }
                    }
                    // Create missing dirs top-down (shallowest missing first).
                    for (let i = (deepestExisting === -1 ? chain.length : deepestExisting) - 1; i >= 0; i--) {
                        await fsClient.create(hostId, path.dirname(chain[i]), 'directory', path.basename(chain[i]));
                    }
                };

                // Ensure the target directory itself exists on the remote host.
                await ensureRemoteParent(resolvedTargetDir, path.resolve(projectRoot));

                const uploadedFiles = [];
                for (let i = 0; i < req.files.length; i++) {
                    const file = req.files[i];
                    // Use relative path if provided (for folder uploads), otherwise use originalname
                    const fileName = (filePaths && filePaths[i]) ? filePaths[i] : file.originalname;
                    const destPath = path.join(resolvedTargetDir, fileName);

                    // Validate destination path
                    const destValidation = validatePathInProject(projectRoot, destPath);
                    if (!destValidation.valid) {
                        // Clean up temp file
                        await fsPromises.unlink(file.path).catch(() => {});
                        continue;
                    }

                    if (file.size > REMOTE_MAX_UPLOAD_BYTES) {
                        // Remove any temp files left behind before aborting.
                        for (const f of req.files) {
                            await fsPromises.unlink(f.path).catch(() => {});
                        }
                        return res.status(413).json({ error: `File ${file.originalname} exceeds 32MB remote upload limit` });
                    }
                    const buf = await fsPromises.readFile(file.path);
                    if (buf.length > REMOTE_MAX_UPLOAD_BYTES) {
                        for (const f of req.files) {
                            await fsPromises.unlink(f.path).catch(() => {});
                        }
                        return res.status(413).json({ error: `File ${file.originalname} exceeds 32MB remote upload limit` });
                    }

                    // Ensure parent directory exists for nested folder uploads.
                    await ensureRemoteParent(path.dirname(destPath), resolvedTargetDir);

                    await fsClient.write(hostId, destValidation.resolved, buf.toString('base64'), 'base64');
                    await fsPromises.unlink(file.path).catch(() => {});

                    uploadedFiles.push({
                        name: fileName,
                        path: destValidation.resolved,
                        size: buf.length,
                        mimeType: file.mimetype
                    });
                }

                return res.json({
                    success: true,
                    files: uploadedFiles,
                    uploadedCount: uploadedFiles.length,
                    requestedFileCount,
                    targetPath: resolvedTargetDir,
                    message: `Uploaded ${uploadedFiles.length} ${uploadedFiles.length === 1 ? 'file' : 'files'} successfully`
                });
            }

            // Ensure target directory exists
            try {
                await fsPromises.access(resolvedTargetDir);
            } catch {
                await fsPromises.mkdir(resolvedTargetDir, { recursive: true });
            }

            // Move uploaded files from temp to target directory
            const uploadedFiles = [];
            console.log('[DEBUG] Processing files:', req.files.map(f => ({ originalname: f.originalname, path: f.path })));
            for (let i = 0; i < req.files.length; i++) {
                const file = req.files[i];
                // Use relative path if provided (for folder uploads), otherwise use originalname
                const fileName = (filePaths && filePaths[i]) ? filePaths[i] : file.originalname;
                console.log('[DEBUG] Processing file:', fileName, '(originalname:', file.originalname + ')');
                const destPath = path.join(resolvedTargetDir, fileName);

                // Validate destination path
                const destValidation = validatePathInProject(projectRoot, destPath);
                if (!destValidation.valid) {
                    console.log('[DEBUG] Destination validation failed for:', destPath);
                    // Clean up temp file
                    await fsPromises.unlink(file.path).catch(() => {});
                    continue;
                }

                // Ensure parent directory exists (for nested files from folder upload)
                const parentDir = path.dirname(destPath);
                try {
                    await fsPromises.access(parentDir);
                } catch {
                    await fsPromises.mkdir(parentDir, { recursive: true });
                }

                // Move file (copy + unlink to handle cross-device scenarios)
                await fsPromises.copyFile(file.path, destPath);
                await fsPromises.unlink(file.path);

                uploadedFiles.push({
                    name: fileName,
                    path: destPath,
                    size: file.size,
                    mimeType: file.mimetype
                });
            }

            res.json({
                success: true,
                files: uploadedFiles,
                uploadedCount: uploadedFiles.length,
                requestedFileCount,
                targetPath: resolvedTargetDir,
                message: `Uploaded ${uploadedFiles.length} ${uploadedFiles.length === 1 ? 'file' : 'files'} successfully`
            });
        } catch (error) {
            console.error('Error uploading files:', error);
            // Clean up any remaining temp files
            if (req.files) {
                for (const file of req.files) {
                    await fsPromises.unlink(file.path).catch(() => {});
                }
            }
            if (error.code === 'EACCES') {
                res.status(403).json({ error: 'Permission denied' });
            } else {
                res.status(500).json({ error: error.message });
            }
        }
    });
};

app.post('/api/projects/:projectId/files/upload', authenticateToken, uploadFilesHandler);

// Chat image uploads moved to POST /api/assets/images (server/modules/assets),
// which stores them in the global ~/.cloudcli/assets folder.

// Get token usage for a specific session. `projectId` is the DB primary key;
// the Claude branch below resolves it to an absolute path via the DB.
app.get('/api/projects/:projectId/sessions/:sessionId/token-usage', authenticateToken, async (req, res) => {
    try {
        const { projectId, sessionId } = req.params;
        const homeDir = os.homedir();

        // Allow only safe characters in sessionId
        const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9._-]/g, '');
        if (!safeSessionId || safeSessionId !== String(sessionId)) {
            return res.status(400).json({ error: 'Invalid sessionId' });
        }

        // Provider artifacts on disk (JSONL file names, OpenCode sqlite rows)
        // are keyed by the provider-native session id, while the caller sends
        // the app-facing id. Resolve provider and id mapping from the indexed
        // session row so the frontend does not choose provider-specific paths.
        const sessionRow = sessionsDb.getSessionById(safeSessionId);
        if (!sessionRow) {
            return res.status(404).json({ error: 'Session not found', sessionId: safeSessionId });
        }

        const provider = sessionRow.provider || 'claude';
        const providerNativeSessionId = sessionRow?.provider_session_id || safeSessionId;

        // Handle Codex sessions
        if (provider === 'codex') {
            const codexSessionsDir = path.join(homeDir, '.codex', 'sessions');

            // Find the session file by searching for the session ID
            const findSessionFile = async (dir) => {
                try {
                    const entries = await fsPromises.readdir(dir, { withFileTypes: true });
                    for (const entry of entries) {
                        const fullPath = path.join(dir, entry.name);
                        if (entry.isDirectory()) {
                            const found = await findSessionFile(fullPath);
                            if (found) return found;
                        } else if (entry.name.includes(providerNativeSessionId) && entry.name.endsWith('.jsonl')) {
                            return fullPath;
                        }
                    }
                } catch (error) {
                    // Skip directories we can't read
                }
                return null;
            };

            const sessionFilePath = await findSessionFile(codexSessionsDir);

            if (!sessionFilePath) {
                return res.status(404).json({ error: 'Codex session file not found', sessionId: safeSessionId });
            }

            // Read and parse the Codex JSONL file
            let fileContent;
            try {
                fileContent = await fsPromises.readFile(sessionFilePath, 'utf8');
            } catch (error) {
                if (error.code === 'ENOENT') {
                    return res.status(404).json({ error: 'Session file not found', path: sessionFilePath });
                }
                throw error;
            }
            const lines = fileContent.trim().split('\n');
            let inputTokens = 0;
            let outputTokens = 0;
            let totalTokens = 0;
            let contextWindow = 200000; // Default for Codex/OpenAI

            // Find the latest token_count event with info (scan from end)
            for (let i = lines.length - 1; i >= 0; i--) {
                try {
                    const entry = JSON.parse(lines[i]);

                    // Codex stores token info in event_msg with type: "token_count"
                    if (entry.type === 'event_msg' && entry.payload?.type === 'token_count' && entry.payload?.info) {
                        const tokenInfo = entry.payload.info;
                        if (tokenInfo.total_token_usage) {
                            inputTokens = tokenInfo.total_token_usage.input_tokens || 0;
                            outputTokens = tokenInfo.total_token_usage.output_tokens || 0;
                            totalTokens = tokenInfo.total_token_usage.total_tokens || inputTokens + outputTokens;
                        }
                        if (tokenInfo.model_context_window) {
                            contextWindow = tokenInfo.model_context_window;
                        }
                        break; // Stop after finding the latest token count
                    }
                } catch (parseError) {
                    // Skip lines that can't be parsed
                    continue;
                }
            }

            return res.json({
                used: totalTokens,
                total: contextWindow,
                inputTokens,
                outputTokens,
                breakdown: {
                    input: inputTokens,
                    output: outputTokens
                }
            });
        }

        // Handle OpenCode sessions (opencode-family CLI; token usage lives in
        // the shared opencode SQLite database).
        if (provider === 'opencode') {
            const dbPath = path.join(homeDir, '.local', 'share', 'opencode', 'opencode.db');
            if (!fs.existsSync(dbPath)) {
                return res.status(404).json({ error: 'OpenCode db not found' });
            }

            let db;
            try {
                db = new Database(dbPath, { readonly: true, fileMustExist: true });
            } catch {
                return res.status(404).json({ error: 'OpenCode db not found' });
            }
            try {
                const row = db.prepare(
                    `SELECT tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write
                     FROM session WHERE id = ?`
                ).get(providerNativeSessionId);
                if (!row) {
                    return res.status(404).json({ error: 'OpenCode session not found', sessionId: safeSessionId });
                }

                const inputTokens = Number(row.tokens_input || 0) + Number(row.tokens_cache_read || 0);
                const outputTokens = Number(row.tokens_output || 0);
                const used = Number(row.tokens_input || 0)
                    + Number(row.tokens_output || 0)
                    + Number(row.tokens_reasoning || 0)
                    + Number(row.tokens_cache_read || 0)
                    + Number(row.tokens_cache_write || 0);

                return res.json({
                    used,
                    total: 200000,
                    inputTokens,
                    outputTokens,
                    breakdown: {
                        input: inputTokens,
                        output: outputTokens
                    }
                });
            } finally {
                db.close();
            }
        }

        // Handle Qoder sessions: qoder has no local sqlite token ledger — usage
        // (credits/costUsd) is reported by the runtime's terminal `result`
        // event, not a queryable store. Historical browsing returns a zeroed
        // token structure so the UI keeps the same response shape.
        if (provider === 'qoder') {
            return res.json({
                used: 0,
                total: 0,
                inputTokens: 0,
                outputTokens: 0,
                breakdown: {
                    input: 0,
                    output: 0
                },
                tokens: { inputTokens: 0, outputTokens: 0 },
            });
        }

        // Handle Claude sessions (default)
        // Resolve the project path through the DB using the caller-supplied
        // `projectId`. Legacy code here called extractProjectDirectory with a
        // folder-encoded project name; the migration centralizes that lookup
        // in the projects table.
        const projectPath = await projectsDb.getProjectPathById(projectId);
        if (!projectPath) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Construct the JSONL file path
        // Claude stores session files in ~/.claude/projects/[encoded-project-path]/[session-id].jsonl
        // The encoding replaces any non-alphanumeric character (except -) with -
        const encodedPath = projectPath.replace(/[^a-zA-Z0-9-]/g, '-');
        const projectDir = path.join(homeDir, '.claude', 'projects', encodedPath);

        // Prefer the indexed transcript path (already produced by the trusted
        // session synchronizer); fall back to the conventional location
        // derived from the provider-native session id.
        let jsonlPath = sessionRow?.jsonl_path;
        if (!jsonlPath) {
            jsonlPath = path.join(projectDir, `${providerNativeSessionId}.jsonl`);

            // Constrain the constructed path to projectDir (the id is
            // caller-influenced in this fallback branch).
            const rel = path.relative(path.resolve(projectDir), path.resolve(jsonlPath));
            if (rel.startsWith('..') || path.isAbsolute(rel)) {
                return res.status(400).json({ error: 'Invalid path' });
            }
        }

        // Read and parse the JSONL file
        let fileContent;
        try {
            fileContent = await fsPromises.readFile(jsonlPath, 'utf8');
        } catch (error) {
            if (error.code === 'ENOENT') {
                return res.status(404).json({ error: 'Session file not found', path: jsonlPath });
            }
            throw error; // Re-throw other errors to be caught by outer try-catch
        }
        const lines = fileContent.trim().split('\n');

        const parsedContextWindow = typeof cfg.server.contextWindow === 'number' ? cfg.server.contextWindow : undefined;
        const contextWindow = Number.isFinite(parsedContextWindow) ? parsedContextWindow : 160000;
        let inputTokens = 0;
        let outputTokens = 0;
        let cacheReadTokens = 0;
        let cacheCreationTokens = 0;

        // Find the latest assistant message with usage data (scan from end)
        for (let i = lines.length - 1; i >= 0; i--) {
            try {
                const entry = JSON.parse(lines[i]);

                // Only count assistant messages which have usage data
                if (entry.type === 'assistant' && entry.message?.usage) {
                    const usage = entry.message.usage;

                    // Use token counts from latest assistant message only
                    const directInputTokens = readUsageNumber(usage.input_tokens ?? usage.inputTokens);
                    cacheReadTokens = readUsageNumber(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? usage.cacheReadTokens);
                    cacheCreationTokens = readUsageNumber(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? usage.cacheCreationTokens);
                    inputTokens = directInputTokens + cacheReadTokens + cacheCreationTokens;
                    outputTokens = readUsageNumber(usage.output_tokens ?? usage.outputTokens);

                    break; // Stop after finding the latest assistant message
                }
            } catch (parseError) {
                // Skip lines that can't be parsed
                continue;
            }
        }

        const totalUsed = inputTokens + outputTokens;
        const cacheTokens = cacheReadTokens + cacheCreationTokens;

        res.json({
            used: totalUsed,
            total: contextWindow,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheCreationTokens,
            cacheTokens,
            breakdown: {
                input: inputTokens,
                output: outputTokens
            }
        });
    } catch (error) {
        console.error('Error reading session token usage:', error);
        res.status(500).json({ error: 'Failed to read session token usage' });
    }
});

// global error middleware must be last
app.use((err, req, res, next) => {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
  }

  console.error(err);

  return res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    },
  });
});

// Helper function to convert permissions to rwx format
function permToRwx(perm) {
    const r = perm & 4 ? 'r' : '-';
    const w = perm & 2 ? 'w' : '-';
    const x = perm & 1 ? 'x' : '-';
    return r + w + x;
}

// Directories that are almost never interesting for a project tree but can
// contain tens of thousands of files. Skipping them before recursion keeps
// traversal time bounded on large monorepos and high-latency filesystems
// (NFS / SMB).
const IGNORED_DIRS = new Set([
    // JS / TS toolchains
    'node_modules', 'dist', 'build', '.next', '.nuxt', '.cache', '.parcel-cache',
    // VCS
    '.git', '.svn', '.hg',
    // Python
    '__pycache__', '.pytest_cache', '.mypy_cache', '.tox', 'venv', '.venv',
    // Rust / Go / Java / Ruby
    'target', 'vendor',
    // Build output / IDE
    '.gradle', '.idea', 'coverage', '.nyc_output'
]);

const FS_CONCURRENCY = Number.isFinite(cfg.runtime.fsConcurrency) && cfg.runtime.fsConcurrency > 0
    ? cfg.runtime.fsConcurrency
    : 64;
let activeFsOperations = 0;
const pendingFsOperations = [];

async function acquire() {
    if (activeFsOperations < FS_CONCURRENCY) {
        activeFsOperations += 1;
        return;
    }

    await new Promise((resolve) => {
        pendingFsOperations.push(resolve);
    });
}

function release() {
    const next = pendingFsOperations.shift();
    if (next) {
        next();
        return;
    }

    activeFsOperations = Math.max(0, activeFsOperations - 1);
}

async function getFileTree(dirPath, maxDepth = 3, currentDepth = 0, showHidden = true) {
    // Using fsPromises from import
    let entries;
    try {
        await acquire();
        try {
            entries = await fsPromises.readdir(dirPath, { withFileTypes: true });
        } finally {
            release();
        }
    } catch (error) {
        // Only log non-permission errors to avoid spam
        if (error.code !== 'EACCES' && error.code !== 'EPERM') {
            console.error('Error reading directory:', error);
        }
        return [];
    }

    const filteredEntries = entries.filter((entry) => !(entry.isDirectory() && IGNORED_DIRS.has(entry.name)));

    // Process every entry in parallel. On high-latency filesystems (NFS/SMB)
    // serial stat() was the real bottleneck — issuing them concurrently lets
    // the kernel pipeline the round-trips and the recursive calls overlap too.
    const items = await Promise.all(filteredEntries.map(async (entry) => {
        const itemPath = path.join(dirPath, entry.name);
        const item = {
            name: entry.name,
            path: itemPath,
            type: entry.isDirectory() ? 'directory' : 'file'
        };

        // Get file stats for additional metadata
        try {
            await acquire();
            try {
              const stats = await fsPromises.lstat(itemPath);
              item.size = stats.size;
              item.modified = stats.mtime.toISOString();

              // Mark symlinks so UI can distinguish them
              if (stats.isSymbolicLink()) {
                item.isSymlink = true;

                // A symlink may point to a directory; classify it as one so it
                // shows up in directory listings (e.g. the project folder
                // browser). We do not recurse into it — the recursion below is
                // gated on entry.isDirectory(), which is false for symlinks —
                // avoiding cycles and broken targets.
                try {
                  const targetStats = await fsPromises.stat(itemPath);
                  if (targetStats.isDirectory()) {
                    item.type = 'directory';
                  }
                } catch {
                  // Broken or unreadable symlink target — leave as 'file'.
                }
              }

              // Convert permissions to rwx format
              const mode = stats.mode;
              const ownerPerm = (mode >> 6) & 7;
              const groupPerm = (mode >> 3) & 7;
              const otherPerm = mode & 7;
              item.permissions =
                ((mode >> 6) & 7).toString() +
                ((mode >> 3) & 7).toString() +
                (mode & 7).toString();
              item.permissionsRwx =
                permToRwx(ownerPerm) +
                permToRwx(groupPerm) +
                permToRwx(otherPerm);
            } finally {
                release();
            }
        } catch (statError) {
            // If stat fails, provide default values
            item.size = 0;
            item.modified = null;
            item.permissions = '000';
            item.permissionsRwx = '---------';
        }

        if (entry.isDirectory() && currentDepth < maxDepth) {
            // Recurse. Let readdir's own EACCES bubble up through the catch in
            // the recursive call rather than doing a separate access() probe
            // (which doubled the round-trip count on SMB without adding info).
            // The recursive call starts with a bounded readdir; holding a permit
            // for the whole subtree can deadlock when sibling directories are
            // waiting on their own children.
            item.children = await getFileTree(itemPath, maxDepth, currentDepth + 1, showHidden);
        }

        return item;
    }));

    return items.sort((a, b) => {
        if (a.type !== b.type) {
            return a.type === 'directory' ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
    });
}

const SERVER_PORT = cfg.server.port;
const HOST = cfg.server.host;
const DISPLAY_HOST = getConnectableHost(HOST);
const LOCAL_SERVER_MARKER_PATH = path.join(os.homedir(), '.cloudcli', 'local-server.json');

async function writeLocalServerMarker() {
    const marker = {
        pid: process.pid,
        host: HOST,
        port: Number.parseInt(String(SERVER_PORT), 10),
        url: `http://${DISPLAY_HOST}:${SERVER_PORT}`,
        installMode,
        appRoot: APP_ROOT,
        updatedAt: new Date().toISOString(),
    };

    await fsPromises.mkdir(path.dirname(LOCAL_SERVER_MARKER_PATH), { recursive: true });
    await fsPromises.writeFile(LOCAL_SERVER_MARKER_PATH, JSON.stringify(marker, null, 2), 'utf8');
}

async function removeLocalServerMarker() {
    try {
        const raw = await fsPromises.readFile(LOCAL_SERVER_MARKER_PATH, 'utf8');
        const marker = JSON.parse(raw);
        if (marker.pid && marker.pid !== process.pid) return;
    } catch (error) {
        if (error.code === 'ENOENT') return;
    }

    try {
        await fsPromises.unlink(LOCAL_SERVER_MARKER_PATH);
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.warn('[WARN] Could not remove local server marker:', error.message);
        }
    }
}

// Initialize database and start server
async function startServer() {
    try {
        // Initialize authentication database
        await initializeDatabase();

        // Prime the remote-projects routing index AFTER the DB is ready (it is a
        // projection of the projects table); project create/delete refresh it.
        try {
            refreshRemoteProjectsIndex(projectsDb.listPathsWithRemoteHost());
        } catch (error) {
            console.error('[remote-agents] initial projects index refresh failed:', error);
        }

        // Scheduled tasks: start the 15s tick dispatch. Failure to start must
        // not block the server — surface the error and continue.
        try {
            schedulerService.start();
        } catch (error) {
            console.error('[scheduler] start failed:', error instanceof Error ? error.message : error);
        }

        // 清理 Lovdex助手 工作区里 is_operator=0 的历史残留会话（破坏性，日志兜底）。
        try {
            const cleaned = await cleanOperatorWorkspaceLegacySessions();
            if (cleaned.removed > 0 || cleaned.failed > 0) {
                console.log(`[INFO] Cleaned ${cleaned.removed} orphaned non-operator session(s) from the Lovdex 助手 workspace${cleaned.failed > 0 ? ` (${cleaned.failed} failed)` : ''}`);
            }
        } catch (error) {
            console.warn('[WARN] Could not clean operator workspace legacy sessions:', error instanceof Error ? error.message : String(error));
        }

        // Log Claude implementation mode
        console.log(`${c.info('[INFO]')} Using Claude Agents SDK for Claude integration`);
        console.log('');

        server.listen(SERVER_PORT, HOST, async () => {
            const appInstallPath = APP_ROOT;
            await writeLocalServerMarker().catch((error) => {
                console.warn('[WARN] Could not write local server marker:', error.message);
            });

            console.log('');
            console.log(c.dim('═'.repeat(63)));
            console.log(`  ${c.bright('Lovdex Server - Ready')}`);
            console.log(c.dim('═'.repeat(63)));
            console.log('');
            console.log(`${c.info('[INFO]')} Server URL:  ${c.bright('http://' + DISPLAY_HOST + ':' + SERVER_PORT)}`);
            console.log(`${c.info('[INFO]')} Installed at: ${c.dim(appInstallPath)}`);
            console.log(`${c.tip('[TIP]')}  Run "cloudcli status" for full configuration details`);
            console.log('');

            // Re-establish any per-host ssh -R tunnels whose hosts have one
            // configured (survives backend restarts).
            try {
                remoteTunnels.syncFromHosts(remoteHostsDb.list());
            } catch (error) {
                console.warn('[remote-tunnel] boot sync failed:', error instanceof Error ? error.message : String(error));
            }

            // Start watching the projects folder for changes
            await initializeSessionsWatcher();
        });

        await closeSessionsWatcher();
        // Clean up plugin processes on shutdown
        const shutdownRuntimeServices = async () => {
            try {
                await removeLocalServerMarker();
            } catch (err) {
                console.error('[Local Server] Error removing server marker during shutdown:', err?.message || err);
            }
            process.exit(0);
        };
        process.on('SIGTERM', () => void shutdownRuntimeServices());
        process.on('SIGINT', () => void shutdownRuntimeServices());
    } catch (error) {
        console.error('[ERROR] Failed to start server:', error);
        process.exit(1);
    }
}

startServer();

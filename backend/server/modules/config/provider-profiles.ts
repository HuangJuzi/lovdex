/**
 * 多套凭据「配置档」（provider profiles）。
 *
 * 一个配置档 = 某个 provider 一组凭据字段的命名快照。快照从**当前生效的**
 * `providers.<p>` 字段上取，应用时也由服务端写回 `providers.<p>` —— 密钥
 * 全程不经过浏览器（GET 打码、PUT 丢弃打码占位串，所以客户端物理上表达不出
 * "把那个档的 key 拷到这里"）。
 *
 * 设计见 docs/superpowers/specs/2026-10-10-provider-profiles-design.md。
 */
import crypto from 'node:crypto';
import { Router } from 'express';

import type { AppConfig, AppConfigApi } from './config.js';
import { deepMerge } from './config.js';

/**
 * 一个档快照/写回哪些字段，按 provider 分。
 * 刻意用白名单：它就是"哪些东西属于一组凭据"的定义。
 * 需与设置页表单字段保持一致（web/src/components/settings/providerProfiles.ts）。
 */
export const PROFILE_FIELDS: Record<string, readonly string[]> = {
  claude: ['baseUrl', 'apiKey', 'defaultModel', 'opusModel', 'sonnetModel', 'haikuModel'],
  codex: ['binPath', 'apiKey'],
  opencode: ['binPath', 'apiKeys'],
  qoder: ['personalAccessToken'],
  // dsh 今天在设置页没有凭据区块（见 2026-10-09 dsh 前端设计：刻意不做），
  // 所以这里支持但 UI 够不着。留着是为了 API 完整 + 以后加区块时不用改后端。
  dsh: ['baseUrl', 'apiKey'],
};

export const PROFILE_NAME_MAX = 40;

/**
 * PUT 里指了一个不存在的档 id。不携带任何 HTTP 语义（由 router 映射成 404），
 * 所以能纯函数测。
 */
export class UnknownProfileError extends Error {
  constructor(public readonly provider: string, public readonly id: string) {
    super(`unknown provider profile: ${provider}/${id}`);
    this.name = 'UnknownProfileError';
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * provider 名是不是我们真正带配置档的那几个。
 * **必须走 `Object.hasOwn`**：`PROFILE_FIELDS['__proto__']` / `['constructor']` 会从
 * `Object.prototype` 上取到真值（前者是对象、后者是函数），裸索引判断会放行客户端
 * 塞进来的保留名，进而在 `providers[provider] = …` 那一步触发 `__proto__` setter
 * 把 `providers` 的原型整个换掉。
 */
export function isKnownProvider(provider: unknown): provider is string {
  return typeof provider === 'string' && Object.hasOwn(PROFILE_FIELDS, provider);
}

/** 从生效配置里拷出某个 provider 白名单内的字段（深拷贝）；未知 provider 返回空。 */
export function snapshotProviderFields(cfg: AppConfig, provider: string): Record<string, unknown> {
  const fields = isKnownProvider(provider) ? PROFILE_FIELDS[provider] : [];
  const source =
    (cfg.providers as unknown as Record<string, Record<string, unknown> | undefined>)[provider] ?? {};
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in source) out[field] = structuredClone(source[field]);
  }
  return out;
}

/** trim + 校验档名；返回错误消息，通过则返回 null。 */
export function validateProfileName(raw: unknown): string | null {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) return 'name is required';
  if (name.length > PROFILE_NAME_MAX) return `name must be at most ${PROFILE_NAME_MAX} characters`;
  return null;
}

export function newProfileId(): string {
  return `p_${crypto.randomBytes(6).toString('hex')}`;
}

/**
 * 把 PUT body 改写：凡是在 `activeProviderProfiles` 里点了名的 provider，都先以
 * 该档的**真值**作为生效字段的基底，再由 body 自己的字段覆盖。
 *
 * 合并**必须用 `deepMerge`，绝不能用对象展开**：`stripMaskedPlaceholders` 会让
 * 打码字段"键还在、值是 undefined"，展开会把档里的真 key 覆盖成 undefined；
 * `deepMerge` 的 `override ?? base` 把 undefined 当"未提供"从而保住已存值 ——
 * 这正是"打码 = 不改动"那条既有契约，现在被延伸到跨档拷贝上。
 *
 * `''` / 缺失 = "自定义，无档"，原样放过。其它值必须解析到已存在的档，否则抛
 * {@link UnknownProfileError}：静默忽略一个未知 id 会看起来像切换成功了。
 */
export function applyProfileSelections(cfg: AppConfigApi, body: unknown): unknown {
  const b = body as Record<string, unknown>;
  const selections = b.activeProviderProfiles;
  if (!isRecord(selections)) return body;

  const providers = isRecord(b.providers) ? { ...b.providers } : {};
  let touched = false;
  for (const [provider, id] of Object.entries(selections)) {
    if (typeof id !== 'string' || id === '') continue;
    // 保留名 / 未知 provider 一律当"指向不存在的档"处理，绝不静默放过。
    if (!isKnownProvider(provider)) throw new UnknownProfileError(provider, id);
    const profile = cfg.get().providerProfiles[provider]?.[id];
    if (!profile) throw new UnknownProfileError(provider, id);
    providers[provider] = deepMerge(structuredClone(profile.values), providers[provider]);
    touched = true;
  }
  return touched ? { ...b, providers } : body;
}

/**
 * POST   /provider-profiles            — 用当前生效字段快照出一个新档
 * DELETE /provider-profiles/:provider/:id — 删一个档
 *
 * 两者都**不改变实际跑什么**，所以都不触发 syncProviderEnv / llm-proxy
 * reconcile —— 只有 PUT /api/config 需要。鉴权在挂载点做（见 index.js），
 * 与本 router 无关（与 buildConfigWriteRouter 同构）。
 */
export function buildProviderProfilesRouter(deps: { cfg: AppConfigApi }): Router {
  const router = Router();

  router.post('/provider-profiles', (req, res) => {
    const body = (req.body ?? {}) as { provider?: unknown; name?: unknown };
    const provider = typeof body.provider === 'string' ? body.provider : '';
    // isKnownProvider 走 Object.hasOwn —— 裸索引会把 '__proto__'/'constructor' 放行。
    if (!isKnownProvider(provider)) {
      return res.status(404).json({ error: { message: `unknown provider: ${provider}` } });
    }
    const invalid = validateProfileName(body.name);
    if (invalid) return res.status(400).json({ error: { message: invalid } });
    try {
      const id = newProfileId();
      deps.cfg.update({
        providerProfiles: {
          [provider]: {
            [id]: {
              name: (body.name as string).trim(),
              values: snapshotProviderFields(deps.cfg.get(), provider),
            },
          },
        },
      });
      res.json(deps.cfg.getMasked());
    } catch (err) {
      console.error('provider profile create failed:', err);
      res.status(500).json({ error: 'config write failed' });
    }
  });

  router.delete('/provider-profiles/:provider/:id', (req, res) => {
    const { provider, id } = req.params;
    if (!isKnownProvider(provider)) {
      return res.status(404).json({ error: { message: `unknown provider: ${provider}` } });
    }
    if (!deps.cfg.get().providerProfiles[provider]?.[id]) {
      return res.status(404).json({ error: { message: `unknown provider profile: ${provider}/${id}` } });
    }
    try {
      deps.cfg.removeProviderProfile(provider, id);
      res.json(deps.cfg.getMasked());
    } catch (err) {
      console.error('provider profile delete failed:', err);
      res.status(500).json({ error: 'config write failed' });
    }
  });

  return router;
}

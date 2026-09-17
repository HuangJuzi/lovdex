import express from 'express';

import { AppError, asyncHandler } from '@/shared/utils.js';

import { isAllowedBucketMs, resolveRange, type TokenUsageQueryService } from './services/token-usage-query.service.js';

export type StatsRouterDeps = {
  query: TokenUsageQueryService;
};

/** 读取单个 query 字符串；数组（重复传参）取全部非空项。 */
function readQueryStrings(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.length > 0 ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  }
  return [];
}

function readOptionalInt(value: unknown, name: string): number | undefined {
  const raw = readQueryStrings(value)[0];
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new AppError(`${name} must be a non-negative integer`, {
      code: 'INVALID_QUERY_PARAMETER',
      statusCode: 400,
    });
  }
  return parsed;
}

/** 从 query 里解析出统一的过滤条件；非法 from/to 会抛 400。 */
function parseFilter(req: express.Request) {
  const from = readOptionalInt(req.query.from, 'from');
  const to = readOptionalInt(req.query.to, 'to');
  const range = resolveRange(from, to, Date.now());
  const projectPath = readQueryStrings(req.query.projectPath)[0];
  const models = readQueryStrings(req.query.model);
  return {
    ...range,
    ...(projectPath ? { projectPath } : {}),
    ...(models.length > 0 ? { models } : {}),
  };
}

export function buildStatsRouter({ query }: StatsRouterDeps) {
  const router = express.Router();

  // GET /api/stats/token-usage/timeseries?projectPath=&from=&to=&bucketMs=&model=&model=
  router.get(
    '/token-usage/timeseries',
    asyncHandler(async (req, res) => {
      const filter = parseFilter(req);
      // 非法 bucketMs 刻意不报错：直接不传，由 service 按范围回落
      const bucketMs = readOptionalInt(req.query.bucketMs, 'bucketMs');
      query.triggerRefresh();
      res.json(
        query.getTimeseries(filter, bucketMs !== undefined && isAllowedBucketMs(bucketMs) ? bucketMs : undefined),
      );
    }),
  );

  // GET /api/stats/token-usage/summary?projectPath=&from=&to=&model=&model=
  router.get(
    '/token-usage/summary',
    asyncHandler(async (req, res) => {
      const filter = parseFilter(req);
      query.triggerRefresh();
      res.json(query.getSummary(filter));
    }),
  );

  // GET /api/stats/token-usage/models?projectPath=&from=&to=
  router.get(
    '/token-usage/models',
    asyncHandler(async (req, res) => {
      const filter = parseFilter(req);
      const { projectPath } = filter;
      res.json(query.listModels({ from: filter.from, to: filter.to, ...(projectPath ? { projectPath } : {}) }));
    }),
  );

  // GET /api/stats/token-usage/ingest-status
  router.get(
    '/token-usage/ingest-status',
    asyncHandler(async (req, res) => {
      query.triggerRefresh();
      res.json(query.getIngestStatus());
    }),
  );

  return router;
}

export default buildStatsRouter;

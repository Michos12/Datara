import { saveSegmentConfigRequestSchema, segmentConfigSchema } from '@ci/contracts';
import { Router } from 'express';
import { z } from 'zod';
import { clientIp, getAuth } from '../../core/request-context.js';
import { requireAuth, requireRole } from '../auth/auth.middleware.js';
import type { TokenService } from '../auth/tokens.js';
import type { SegmentService } from './segment.service.js';

const versionParam = z.coerce.number().int().min(1);

export function segmentRouter(deps: { segments: SegmentService; tokens: TokenService }): Router {
  const { segments } = deps;
  const router = Router();
  router.use('/segments', requireAuth(deps.tokens));

  router.get('/segments', async (req, res) => {
    res.json(await segments.summary(getAuth(req)));
  });

  router.get('/segments/config', async (req, res) => {
    res.json(await segments.activeConfig(getAuth(req)));
  });

  router.get('/segments/config/versions', requireRole('OWNER', 'ADMIN'), async (req, res) => {
    res.json({ data: await segments.versions(getAuth(req)) });
  });

  router.post('/segments/config', requireRole('OWNER', 'ADMIN'), async (req, res) => {
    const body = saveSegmentConfigRequestSchema.parse(req.body);
    res
      .status(201)
      .json(await segments.save(getAuth(req), body.config, body.activate, clientIp(req)));
  });

  router.post(
    '/segments/config/preview',
    requireRole('OWNER', 'ADMIN', 'ANALYST'),
    async (req, res) => {
      const config = segmentConfigSchema.parse(
        (req.body as { config?: unknown } | undefined)?.config,
      );
      res.json(await segments.preview(getAuth(req), config));
    },
  );

  router.post(
    '/segments/config/:version/activate',
    requireRole('OWNER', 'ADMIN'),
    async (req, res) => {
      const version = versionParam.parse(req.params.version);
      res.json(await segments.activate(getAuth(req), version, clientIp(req)));
    },
  );

  return router;
}

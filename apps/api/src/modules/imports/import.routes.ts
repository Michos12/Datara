import { importEntitySchema, importMappingRequestSchema } from '@ci/contracts';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { AppError } from '../../core/errors.js';
import { getAuth } from '../../core/request-context.js';
import { requireAuth, requireRole } from '../auth/auth.middleware.js';
import type { TokenService } from '../auth/tokens.js';
import { templateCsv, type ImportService } from './import.service.js';

const uploadQuerySchema = z.strictObject({
  entity: importEntitySchema,
  filename: z.string().trim().min(1).max(200).default('upload.csv'),
});

function pathId(req: Request): string {
  const parsed = z.uuid().safeParse(req.params.id);
  if (!parsed.success) throw new AppError('NOT_FOUND', 'Import not found');
  return parsed.data;
}

const IMPORTERS = ['OWNER', 'ADMIN'] as const;

export function importRouter(deps: { imports: ImportService; tokens: TokenService }): Router {
  const { imports } = deps;
  const router = Router();
  router.use('/imports', requireAuth(deps.tokens));

  // Templates are readable by every role (no data in them).
  router.get('/imports/templates/:entity.csv', (req, res) => {
    const entity = importEntitySchema.safeParse(req.params.entity);
    if (!entity.success) throw new AppError('NOT_FOUND', 'Unknown template');
    res
      .type('text/csv; charset=utf-8')
      .attachment(`${entity.data}-template.csv`)
      .send(templateCsv(entity.data));
  });

  /**
   * Upload: the CSV is the raw request body (Content-Type text/csv), streamed to storage
   * with a 50 MB cap, so large files never sit in memory.
   */
  router.post('/imports', requireRole(...IMPORTERS), async (req, res) => {
    const query = uploadQuerySchema.parse(req.query);
    const type = req.get('content-type') ?? '';
    if (
      !/^(text\/csv|text\/plain|application\/octet-stream|application\/vnd\.ms-excel)/i.test(type)
    ) {
      throw new AppError(
        'BAD_REQUEST',
        'Send the CSV file as the request body with Content-Type text/csv',
      );
    }
    const result = await imports.upload(getAuth(req), query.entity, query.filename, req);
    res.status(201).json(result);
  });

  router.get('/imports', requireRole(...IMPORTERS), async (req, res) => {
    res.json({ data: await imports.list(getAuth(req)) });
  });

  router.get('/imports/:id', requireRole(...IMPORTERS), async (req, res) => {
    res.json(await imports.get(getAuth(req), pathId(req)));
  });

  router.put('/imports/:id/mapping', requireRole(...IMPORTERS), async (req, res) => {
    const body = importMappingRequestSchema.parse(req.body);
    res.status(202).json(await imports.setMapping(getAuth(req), pathId(req), body));
  });

  router.post('/imports/:id/commit', requireRole(...IMPORTERS), async (req, res) => {
    res.status(202).json(await imports.commit(getAuth(req), pathId(req)));
  });

  router.get('/imports/:id/errors.csv', requireRole(...IMPORTERS), async (req, res) => {
    const { stream, filename } = await imports.errorFile(getAuth(req), pathId(req));
    res.type('text/csv; charset=utf-8').attachment(filename);
    stream.pipe(res);
  });

  return router;
}

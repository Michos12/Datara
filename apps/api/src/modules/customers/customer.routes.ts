import {
  createCustomerRequestSchema,
  createOrderRequestSchema,
  customerListQuerySchema,
  orderListQuerySchema,
  updateCustomerRequestSchema,
  updateOrderRequestSchema,
} from '@ci/contracts';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { AppError } from '../../core/errors.js';
import { clientIp, getAuth } from '../../core/request-context.js';
import { requireAuth, requireRole } from '../auth/auth.middleware.js';
import type { TokenService } from '../auth/tokens.js';
import type { OrderService } from '../orders/order.service.js';
import type { CustomerService } from './customer.service.js';

const idParam = z.uuid();

/** Path IDs that are not UUIDs can never exist: answer 404 like any other missing record. */
function pathId(req: Request): string {
  const parsed = idParam.safeParse(req.params.id);
  if (!parsed.success) throw new AppError('NOT_FOUND', 'Not found');
  return parsed.data;
}

const EDITORS = ['OWNER', 'ADMIN', 'ANALYST'] as const;
const DELETERS = ['OWNER', 'ADMIN'] as const;

export function customerDataRouter(deps: {
  customers: CustomerService;
  orders: OrderService;
  tokens: TokenService;
}): Router {
  const { customers, orders } = deps;
  const router = Router();
  router.use(['/customers', '/orders'], requireAuth(deps.tokens));

  // ───── customers ─────
  router.get('/customers', async (req, res) => {
    res.json(await customers.list(getAuth(req), customerListQuerySchema.parse(req.query)));
  });

  router.post('/customers', requireRole(...EDITORS), async (req, res) => {
    const body = createCustomerRequestSchema.parse(req.body);
    const { customer, duplicateEmail } = await customers.create(getAuth(req), body);
    if (duplicateEmail) res.setHeader('X-Warning', 'duplicate-email');
    res.status(201).json(customer);
  });

  router.get('/customers/:id', async (req, res) => {
    res.json(await customers.get(getAuth(req), pathId(req)));
  });

  router.patch('/customers/:id', requireRole(...EDITORS), async (req, res) => {
    const body = updateCustomerRequestSchema.parse(req.body);
    res.json(await customers.update(getAuth(req), pathId(req), body));
  });

  router.delete('/customers/:id', requireRole(...DELETERS), async (req, res) => {
    await customers.remove(getAuth(req), pathId(req), clientIp(req));
    res.status(204).end();
  });

  router.post('/customers/:id/restore', requireRole(...DELETERS), async (req, res) => {
    res.json(await customers.restore(getAuth(req), pathId(req), clientIp(req)));
  });

  router.get('/customers/:id/orders', async (req, res) => {
    const auth = getAuth(req);
    const id = pathId(req);
    await customers.get(auth, id); // 404 for unknown or other-tenant customers
    const query = orderListQuerySchema.parse({ ...req.query, customerId: id });
    res.json(await orders.list(auth, query));
  });

  // ───── orders ─────
  router.get('/orders', async (req, res) => {
    res.json(await orders.list(getAuth(req), orderListQuerySchema.parse(req.query)));
  });

  router.post('/orders', requireRole(...EDITORS), async (req, res) => {
    const body = createOrderRequestSchema.parse(req.body);
    res.status(201).json(await orders.create(getAuth(req), body));
  });

  router.get('/orders/:id', async (req, res) => {
    res.json(await orders.get(getAuth(req), pathId(req)));
  });

  router.patch('/orders/:id', requireRole(...EDITORS), async (req, res) => {
    const body = updateOrderRequestSchema.parse(req.body);
    res.json(await orders.update(getAuth(req), pathId(req), body));
  });

  router.delete('/orders/:id', requireRole(...DELETERS), async (req, res) => {
    await orders.remove(getAuth(req), pathId(req), clientIp(req));
    res.status(204).end();
  });

  return router;
}

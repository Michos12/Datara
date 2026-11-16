import {
  amountsAreConsistent,
  type CreateOrderRequest,
  type Order,
  type OrderListQuery,
  type OrderPage,
  type OrderStatus,
  type UpdateOrderRequest,
} from '@ci/contracts';
import { AppError } from '../../core/errors.js';
import { newId } from '../../core/ids.js';
import type { AuthContext } from '../../core/request-context.js';
import {
  recordDataChange,
  isUniqueViolation,
  toNumber,
  type Database,
  type Tx,
} from '../../infra/database.js';
import { recordAudit } from '../audit/audit.service.js';

type DbStatus = 'PENDING' | 'COMPLETED' | 'PARTIALLY_REFUNDED' | 'REFUNDED' | 'CANCELLED';
export const toDbStatus = (status: OrderStatus) => status.toUpperCase() as DbStatus;
const fromDbStatus = (status: DbStatus) => status.toLowerCase() as OrderStatus;

/** Orders may be backdated freely but not dated more than a day in the future. */
const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;
const DUPLICATE_ID = 'Another order already uses this external ID';

interface OrderRow {
  id: string;
  externalId: string | null;
  customerId: string | null;
  orderedAt: Date;
  status: DbStatus;
  channel: string | null;
  grossCents: bigint;
  discountCents: bigint;
  taxCents: bigint;
  refundedCents: bigint;
  netCents: bigint;
  createdAt: Date;
}

export function toOrder(row: OrderRow): Order {
  return {
    id: row.id,
    externalId: row.externalId,
    customerId: row.customerId,
    orderedAt: row.orderedAt.toISOString(),
    status: fromDbStatus(row.status),
    channel: row.channel,
    grossCents: toNumber(row.grossCents),
    discountCents: toNumber(row.discountCents),
    taxCents: toNumber(row.taxCents),
    refundedCents: toNumber(row.refundedCents),
    netCents: toNumber(row.netCents),
    createdAt: row.createdAt.toISOString(),
  };
}

export class OrderService {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  async list(auth: AuthContext, query: OrderListQuery): Promise<OrderPage> {
    const rows = await this.db.run(auth, (tx) =>
      tx.order.findMany({
        where: {
          organizationId: auth.organizationId,
          deletedAt: null,
          ...(query.customerId ? { customerId: query.customerId } : {}),
          ...(query.status ? { status: toDbStatus(query.status) } : {}),
          ...(query.from || query.to
            ? {
                orderedAt: {
                  ...(query.from ? { gte: new Date(query.from) } : {}),
                  ...(query.to ? { lt: new Date(query.to) } : {}),
                },
              }
            : {}),
        },
        orderBy: [{ orderedAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      }),
    );
    const page = rows.slice(0, query.limit);
    return {
      data: page.map(toOrder),
      page: {
        nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
        limit: query.limit,
      },
    };
  }

  async get(auth: AuthContext, id: string): Promise<Order> {
    const row = await this.db.run(auth, (tx) =>
      tx.order.findFirst({ where: { id, organizationId: auth.organizationId, deletedAt: null } }),
    );
    if (!row) throw new AppError('NOT_FOUND', 'Order not found');
    return toOrder(row);
  }

  async create(auth: AuthContext, input: CreateOrderRequest): Promise<Order> {
    const orderedAt = this.checkDate(input.orderedAt);
    try {
      return await this.db.run(auth, async (tx) => {
        if (input.customerId) await this.assertCustomer(tx, auth.organizationId, input.customerId);
        const row = await tx.order.create({
          data: {
            id: newId(),
            organizationId: auth.organizationId,
            customerId: input.customerId ?? null,
            externalId: input.externalId ?? null,
            orderedAt,
            status: toDbStatus(input.status ?? 'completed'),
            channel: input.channel ?? null,
            grossCents: BigInt(input.grossCents),
            discountCents: BigInt(input.discountCents ?? 0),
            taxCents: BigInt(input.taxCents ?? 0),
            refundedCents: BigInt(input.refundedCents ?? 0),
          },
        });
        await recordDataChange(tx, auth.organizationId);
        return toOrder(row);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError('DUPLICATE_EXTERNAL_ID', DUPLICATE_ID);
      throw err;
    }
  }

  async update(auth: AuthContext, id: string, input: UpdateOrderRequest): Promise<Order> {
    try {
      return await this.db.run(auth, async (tx) => {
        const current = await tx.order.findFirst({
          where: { id, organizationId: auth.organizationId, deletedAt: null },
        });
        if (!current) throw new AppError('NOT_FOUND', 'Order not found');

        const amounts = {
          grossCents: input.grossCents ?? toNumber(current.grossCents),
          discountCents: input.discountCents ?? toNumber(current.discountCents),
          refundedCents: input.refundedCents ?? toNumber(current.refundedCents),
        };
        if (!amountsAreConsistent(amounts)) {
          throw new AppError('VALIDATION_FAILED', 'Order amounts are inconsistent', [
            {
              path: 'refundedCents',
              message:
                'Discount cannot exceed the gross amount, and refunds cannot exceed the amount paid',
            },
          ]);
        }
        if (input.customerId) await this.assertCustomer(tx, auth.organizationId, input.customerId);

        const row = await tx.order.update({
          where: { id },
          data: {
            ...(input.externalId !== undefined ? { externalId: input.externalId } : {}),
            ...(input.customerId !== undefined ? { customerId: input.customerId } : {}),
            ...(input.orderedAt ? { orderedAt: this.checkDate(input.orderedAt) } : {}),
            ...(input.status ? { status: toDbStatus(input.status) } : {}),
            ...(input.channel !== undefined ? { channel: input.channel } : {}),
            ...(input.taxCents !== undefined ? { taxCents: BigInt(input.taxCents) } : {}),
            grossCents: BigInt(amounts.grossCents),
            discountCents: BigInt(amounts.discountCents),
            refundedCents: BigInt(amounts.refundedCents),
          },
        });
        await recordDataChange(tx, auth.organizationId);
        return toOrder(row);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError('DUPLICATE_EXTERNAL_ID', DUPLICATE_ID);
      throw err;
    }
  }

  async remove(auth: AuthContext, id: string, ip: string | null): Promise<void> {
    await this.db.run(auth, async (tx) => {
      const { count } = await tx.order.updateMany({
        where: { id, organizationId: auth.organizationId, deletedAt: null },
        data: { deletedAt: new Date(this.now()) },
      });
      if (count === 0) throw new AppError('NOT_FOUND', 'Order not found');
      await recordDataChange(tx, auth.organizationId);
      await recordAudit(tx, {
        organizationId: auth.organizationId,
        actorUserId: auth.userId,
        action: 'order.delete',
        entityType: 'order',
        entityId: id,
        ip,
      });
    });
  }

  private checkDate(value: string): Date {
    const date = new Date(value);
    if (date.getTime() > this.now() + FUTURE_TOLERANCE_MS) {
      throw new AppError('VALIDATION_FAILED', 'Order date is in the future', [
        { path: 'orderedAt', message: 'Cannot be more than one day in the future' },
      ]);
    }
    return date;
  }

  private async assertCustomer(tx: Tx, organizationId: string, customerId: string): Promise<void> {
    const exists = await tx.customer.count({
      where: { id: customerId, organizationId, deletedAt: null },
    });
    if (!exists) {
      throw new AppError('VALIDATION_FAILED', 'Customer not found', [
        { path: 'customerId', message: 'No such customer in this organization' },
      ]);
    }
  }
}

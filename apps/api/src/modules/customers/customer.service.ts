import type {
  CreateCustomerRequest,
  Customer,
  CustomerListQuery,
  CustomerPage,
  UpdateCustomerRequest,
} from '@ci/contracts';
import { AppError } from '../../core/errors.js';
import { newId } from '../../core/ids.js';
import type { AuthContext } from '../../core/request-context.js';
import { bumpDataVersion, isUniqueViolation, type Database } from '../../infra/database.js';
import { recordAudit } from '../audit/audit.service.js';
import { getCustomer, listCustomers } from './customer.repository.js';

const DUPLICATE_ID = 'Another customer already uses this external ID';

function toData(input: CreateCustomerRequest | UpdateCustomerRequest) {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    data[key] =
      key === 'registeredAt' && typeof value === 'string' ? new Date(`${value}T00:00:00Z`) : value;
  }
  return data;
}

export class CustomerService {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  async list(auth: AuthContext, query: CustomerListQuery): Promise<CustomerPage> {
    const { data, nextCursor } = await this.db.run(auth, (tx) =>
      listCustomers(tx, auth.organizationId, query, this.now()),
    );
    return { data, page: { nextCursor, limit: query.limit } };
  }

  async get(auth: AuthContext, id: string): Promise<Customer> {
    const customer = await this.db.run(auth, (tx) =>
      getCustomer(tx, auth.organizationId, id, this.now()),
    );
    if (!customer) throw new AppError('NOT_FOUND', 'Customer not found');
    return customer;
  }

  /** Returns the customer and whether another customer already has the same email. */
  async create(
    auth: AuthContext,
    input: CreateCustomerRequest,
  ): Promise<{ customer: Customer; duplicateEmail: boolean }> {
    try {
      return await this.db.run(auth, async (tx) => {
        const id = newId();
        await tx.customer.create({
          data: { id, organizationId: auth.organizationId, ...toData(input) },
        });
        await bumpDataVersion(tx, auth.organizationId);
        const duplicateEmail = input.email
          ? (await tx.customer.count({
              where: {
                organizationId: auth.organizationId,
                email: input.email,
                deletedAt: null,
                id: { not: id },
              },
            })) > 0
          : false;
        const customer = await getCustomer(tx, auth.organizationId, id, this.now());
        return { customer: customer!, duplicateEmail };
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError('DUPLICATE_EXTERNAL_ID', DUPLICATE_ID);
      throw err;
    }
  }

  async update(auth: AuthContext, id: string, input: UpdateCustomerRequest): Promise<Customer> {
    try {
      return await this.db.run(auth, async (tx) => {
        const { count } = await tx.customer.updateMany({
          where: { id, organizationId: auth.organizationId, deletedAt: null },
          data: toData(input),
        });
        if (count === 0) throw new AppError('NOT_FOUND', 'Customer not found');
        await bumpDataVersion(tx, auth.organizationId);
        return (await getCustomer(tx, auth.organizationId, id, this.now()))!;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError('DUPLICATE_EXTERNAL_ID', DUPLICATE_ID);
      throw err;
    }
  }

  /** Soft delete: recoverable with restore; the customer's orders stay in revenue totals. */
  async remove(auth: AuthContext, id: string, ip: string | null): Promise<void> {
    await this.db.run(auth, async (tx) => {
      const { count } = await tx.customer.updateMany({
        where: { id, organizationId: auth.organizationId, deletedAt: null },
        data: { deletedAt: new Date(this.now()) },
      });
      if (count === 0) throw new AppError('NOT_FOUND', 'Customer not found');
      await bumpDataVersion(tx, auth.organizationId);
      await recordAudit(tx, {
        organizationId: auth.organizationId,
        actorUserId: auth.userId,
        action: 'customer.delete',
        entityType: 'customer',
        entityId: id,
        ip,
      });
    });
  }

  async restore(auth: AuthContext, id: string, ip: string | null): Promise<Customer> {
    return this.db.run(auth, async (tx) => {
      const { count } = await tx.customer.updateMany({
        where: { id, organizationId: auth.organizationId, deletedAt: { not: null } },
        data: { deletedAt: null },
      });
      if (count === 0) throw new AppError('NOT_FOUND', 'Deleted customer not found');
      await bumpDataVersion(tx, auth.organizationId);
      await recordAudit(tx, {
        organizationId: auth.organizationId,
        actorUserId: auth.userId,
        action: 'customer.restore',
        entityType: 'customer',
        entityId: id,
        ip,
      });
      return (await getCustomer(tx, auth.organizationId, id, this.now()))!;
    });
  }
}

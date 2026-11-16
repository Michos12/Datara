import { z } from 'zod';

/** Money is always integer minor units (cents) of the organization's currency. */
export const centsSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

const isoDate = z.iso.date();

export const customerFieldsSchema = z.strictObject({
  externalId: optionalText(120),
  firstName: optionalText(120),
  lastName: optionalText(120),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .transform((v) => (v === '' ? null : v))
    .pipe(z.email().max(254).nullable())
    .nullable()
    .optional(),
  phone: optionalText(40),
  country: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, 'Use a two-letter country code, e.g. CO')
    .nullable()
    .optional(),
  region: optionalText(120),
  city: optionalText(120),
  registeredAt: isoDate.nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  marketingConsent: z.boolean().optional(),
});

/** At least one way to recognise the customer is required. */
export const createCustomerRequestSchema = customerFieldsSchema.refine(
  (c) => Boolean(c.externalId || c.email || c.firstName || c.lastName),
  { message: 'Provide a name, an email or an external ID', path: ['firstName'] },
);
export type CreateCustomerRequest = z.infer<typeof createCustomerRequestSchema>;

export const updateCustomerRequestSchema = customerFieldsSchema.refine(
  (c) => Object.keys(c).length > 0,
  { message: 'Nothing to update' },
);
export type UpdateCustomerRequest = z.infer<typeof updateCustomerRequestSchema>;

/** Purchase statistics computed from countable orders (temporary source until M3 snapshots). */
export const customerStatsSchema = z.object({
  orderCount: z.number().int(),
  totalNetCents: z.number().int(),
  aovCents: z.number().int().nullable(),
  firstOrderAt: z.string().nullable(),
  lastOrderAt: z.string().nullable(),
  daysSinceLastOrder: z.number().int().nullable(),
});
export type CustomerStats = z.infer<typeof customerStatsSchema>;

export const customerSchema = z.object({
  id: z.uuid(),
  externalId: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  country: z.string().nullable(),
  region: z.string().nullable(),
  city: z.string().nullable(),
  registeredAt: z.string().nullable(),
  tags: z.array(z.string()),
  marketingConsent: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  stats: customerStatsSchema,
  /** From the latest analytics snapshot; null until a snapshot includes this customer. */
  segment: z
    .object({
      key: z.string().nullable(),
      rScore: z.number().int().nullable(),
      fScore: z.number().int().nullable(),
      mScore: z.number().int().nullable(),
      lifecycleStatus: z.enum(['PROSPECT', 'ACTIVE', 'AT_RISK', 'CHURNED']),
    })
    .nullable(),
});
export type Customer = z.infer<typeof customerSchema>;

export const CUSTOMER_SORTS = [
  'name',
  '-name',
  'created_at',
  '-created_at',
  'total_spent',
  '-total_spent',
  'order_count',
  '-order_count',
  'last_order_at',
  '-last_order_at',
] as const;
export type CustomerSort = (typeof CUSTOMER_SORTS)[number];

export const customerListQuerySchema = z.strictObject({
  q: z.string().trim().max(120).optional(),
  minSpentCents: z.coerce.number().int().min(0).optional(),
  maxSpentCents: z.coerce.number().int().min(0).optional(),
  lastOrderFrom: isoDate.optional(),
  lastOrderTo: isoDate.optional(),
  hasOrders: z.enum(['true', 'false']).optional(),
  tag: z.string().trim().max(40).optional(),
  /** Segment key from the latest snapshot, or "no_purchases". */
  segment: z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,39}$/)
    .optional(),
  sort: z.enum(CUSTOMER_SORTS).default('-created_at'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(500).optional(),
});
export type CustomerListQuery = z.infer<typeof customerListQuerySchema>;

export const customerPageSchema = z.object({
  data: z.array(customerSchema),
  page: z.object({ nextCursor: z.string().nullable(), limit: z.number().int() }),
});
export type CustomerPage = z.infer<typeof customerPageSchema>;

// ───────────── Orders ─────────────

export const ORDER_STATUSES = [
  'pending',
  'completed',
  'partially_refunded',
  'refunded',
  'cancelled',
] as const;
export const orderStatusSchema = z.enum(ORDER_STATUSES);
export type OrderStatus = z.infer<typeof orderStatusSchema>;

/** Statuses that count as purchases in analytics (docs/05-analytics-methodology.md §3). */
export const COUNTABLE_ORDER_STATUSES: readonly OrderStatus[] = ['completed', 'partially_refunded'];

const orderAmounts = z.object({
  grossCents: centsSchema,
  discountCents: centsSchema.default(0),
  taxCents: centsSchema.default(0),
  refundedCents: centsSchema.default(0),
});

const amountsAreConsistent = (o: {
  grossCents: number;
  discountCents: number;
  refundedCents: number;
}) => o.discountCents <= o.grossCents && o.refundedCents <= o.grossCents - o.discountCents;

export const createOrderRequestSchema = z
  .strictObject({
    externalId: optionalText(120),
    customerId: z.uuid().nullable().optional(),
    orderedAt: z.iso.datetime({ offset: true }),
    status: orderStatusSchema.default('completed'),
    channel: optionalText(40),
    ...orderAmounts.shape,
  })
  .refine(amountsAreConsistent, {
    message: 'Discount cannot exceed the gross amount, and refunds cannot exceed the amount paid',
    path: ['refundedCents'],
  });
export type CreateOrderRequest = z.input<typeof createOrderRequestSchema>;

export const updateOrderRequestSchema = z
  .strictObject({
    externalId: optionalText(120),
    customerId: z.uuid().nullable().optional(),
    orderedAt: z.iso.datetime({ offset: true }).optional(),
    status: orderStatusSchema.optional(),
    channel: optionalText(40),
    grossCents: centsSchema.optional(),
    discountCents: centsSchema.optional(),
    taxCents: centsSchema.optional(),
    refundedCents: centsSchema.optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'Nothing to update' });
export type UpdateOrderRequest = z.infer<typeof updateOrderRequestSchema>;

export const orderSchema = z.object({
  id: z.uuid(),
  externalId: z.string().nullable(),
  customerId: z.uuid().nullable(),
  orderedAt: z.string(),
  status: orderStatusSchema,
  channel: z.string().nullable(),
  grossCents: z.number().int(),
  discountCents: z.number().int(),
  taxCents: z.number().int(),
  refundedCents: z.number().int(),
  netCents: z.number().int(),
  createdAt: z.string(),
});
export type Order = z.infer<typeof orderSchema>;

export const orderListQuerySchema = z.strictObject({
  customerId: z.uuid().optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  status: orderStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.uuid().optional(),
});
export type OrderListQuery = z.infer<typeof orderListQuerySchema>;

export const orderPageSchema = z.object({
  data: z.array(orderSchema),
  page: z.object({ nextCursor: z.string().nullable(), limit: z.number().int() }),
});
export type OrderPage = z.infer<typeof orderPageSchema>;

export { amountsAreConsistent };

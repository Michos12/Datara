import { z } from 'zod';

export const IMPORT_ENTITIES = ['customers', 'orders'] as const;
export const importEntitySchema = z.enum(IMPORT_ENTITIES);
export type ImportEntity = z.infer<typeof importEntitySchema>;

export interface ImportFieldDefinition {
  key: string;
  label: string;
  required: boolean;
  description: string;
  /** Header names (lowercase, without spaces/underscores/dashes) auto-mapped to this field. */
  synonyms: string[];
}

/** Columns the import understands, per entity. The UI builds the mapping step from this. */
export const IMPORT_FIELDS: Record<ImportEntity, ImportFieldDefinition[]> = {
  customers: [
    {
      key: 'externalId',
      label: 'Customer ID',
      required: true,
      description: 'Unique ID from your system. Re-importing the same ID updates the customer.',
      synonyms: ['externalid', 'customerid', 'id', 'clientid', 'customernumber', 'idcliente'],
    },
    {
      key: 'firstName',
      label: 'First name',
      required: false,
      description: '',
      synonyms: ['firstname', 'givenname', 'nombre', 'name'],
    },
    {
      key: 'lastName',
      label: 'Last name',
      required: false,
      description: '',
      synonyms: ['lastname', 'surname', 'familyname', 'apellido'],
    },
    {
      key: 'email',
      label: 'Email',
      required: false,
      description: '',
      synonyms: ['email', 'emailaddress', 'mail', 'correo'],
    },
    {
      key: 'phone',
      label: 'Phone',
      required: false,
      description: '',
      synonyms: ['phone', 'phonenumber', 'mobile', 'telefono', 'celular'],
    },
    {
      key: 'country',
      label: 'Country',
      required: false,
      description: 'Two-letter code, e.g. CO.',
      synonyms: ['country', 'countrycode', 'pais'],
    },
    {
      key: 'region',
      label: 'Region / state',
      required: false,
      description: '',
      synonyms: ['region', 'state', 'province', 'departamento'],
    },
    {
      key: 'city',
      label: 'City',
      required: false,
      description: '',
      synonyms: ['city', 'town', 'ciudad'],
    },
    {
      key: 'registeredAt',
      label: 'Registration date',
      required: false,
      description: 'When the customer signed up.',
      synonyms: [
        'registeredat',
        'registrationdate',
        'signupdate',
        'createdat',
        'datecreated',
        'fecharegistro',
      ],
    },
    {
      key: 'tags',
      label: 'Tags',
      required: false,
      description: 'Separate several tags with | or ;',
      synonyms: ['tags', 'labels', 'etiquetas'],
    },
    {
      key: 'marketingConsent',
      label: 'Marketing consent',
      required: false,
      description: 'yes/no, true/false or 1/0.',
      synonyms: ['marketingconsent', 'consent', 'optin', 'acceptsmarketing', 'newsletter'],
    },
  ],
  orders: [
    {
      key: 'externalId',
      label: 'Order ID',
      required: true,
      description: 'Unique ID from your system. Re-importing the same ID updates the order.',
      synonyms: [
        'externalid',
        'orderid',
        'id',
        'ordernumber',
        'invoice',
        'invoiceid',
        'pedido',
        'factura',
      ],
    },
    {
      key: 'customerExternalId',
      label: 'Customer ID',
      required: false,
      description: 'Must match an imported customer. Leave empty for guest orders.',
      synonyms: ['customerexternalid', 'customerid', 'clientid', 'idcliente', 'customer'],
    },
    {
      key: 'orderedAt',
      label: 'Order date',
      required: true,
      description:
        'Date or date and time. Dates without a time zone use your organization’s time zone.',
      synonyms: [
        'orderedat',
        'orderdate',
        'date',
        'createdat',
        'purchasedate',
        'fecha',
        'datetime',
      ],
    },
    {
      key: 'grossAmount',
      label: 'Order total',
      required: true,
      description: 'Amount charged before discounts and refunds.',
      synonyms: [
        'grossamount',
        'total',
        'amount',
        'ordertotal',
        'subtotal',
        'gross',
        'valor',
        'monto',
      ],
    },
    {
      key: 'discountAmount',
      label: 'Discount',
      required: false,
      description: '',
      synonyms: ['discountamount', 'discount', 'descuento'],
    },
    {
      key: 'taxAmount',
      label: 'Tax',
      required: false,
      description: '',
      synonyms: ['taxamount', 'tax', 'vat', 'iva', 'impuesto'],
    },
    {
      key: 'refundedAmount',
      label: 'Refunded',
      required: false,
      description: '',
      synonyms: ['refundedamount', 'refund', 'refunded', 'reembolso'],
    },
    {
      key: 'status',
      label: 'Status',
      required: false,
      description:
        'completed, pending, cancelled, refunded or partially_refunded. Defaults to completed.',
      synonyms: ['status', 'orderstatus', 'estado'],
    },
    {
      key: 'channel',
      label: 'Channel',
      required: false,
      description: 'e.g. online, in_store.',
      synonyms: ['channel', 'source', 'canal'],
    },
  ],
};

export const DATE_FORMATS = ['auto', 'YMD', 'DMY', 'MDY'] as const;

export const importOptionsSchema = z.strictObject({
  /** How to read ambiguous dates such as 03/04/2026. "auto" accepts ISO 8601 only for slashes. */
  dateFormat: z.enum(DATE_FORMATS).default('auto'),
  decimalSeparator: z.enum(['.', ',']).default('.'),
  /** Amounts are already integer minor units (cents) rather than e.g. 12.50. */
  amountsInMinorUnits: z.boolean().default(false),
});
export type ImportOptions = z.infer<typeof importOptionsSchema>;

export const importMappingRequestSchema = z.strictObject({
  /** field key → CSV column name (null or missing = not imported) */
  mapping: z.record(z.string(), z.string().nullable()),
  options: importOptionsSchema.default({
    dateFormat: 'auto',
    decimalSeparator: '.',
    amountsInMinorUnits: false,
  }),
});
export type ImportMappingRequest = z.input<typeof importMappingRequestSchema>;

export const IMPORT_STATUSES = [
  'uploaded',
  'validating',
  'validated',
  'importing',
  'completed',
  'failed',
] as const;
export const importStatusSchema = z.enum(IMPORT_STATUSES);
export type ImportStatus = z.infer<typeof importStatusSchema>;

export const importRowErrorSchema = z.object({
  /** 1-based line number in the file, header = line 1. */
  line: z.number().int(),
  field: z.string().nullable(),
  message: z.string(),
});
export type ImportRowError = z.infer<typeof importRowErrorSchema>;

export const importSchema = z.object({
  id: z.uuid(),
  entity: importEntitySchema,
  status: importStatusSchema,
  originalName: z.string(),
  sizeBytes: z.number().int(),
  columns: z.array(z.string()),
  mapping: z.record(z.string(), z.string().nullable()).nullable(),
  options: importOptionsSchema.nullable(),
  rowsTotal: z.number().int(),
  rowsValid: z.number().int(),
  rowsFailed: z.number().int(),
  rowsInserted: z.number().int(),
  rowsUpdated: z.number().int(),
  errorSample: z.array(importRowErrorSchema),
  failureReason: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type Import = z.infer<typeof importSchema>;

export const importUploadResponseSchema = z.object({
  import: importSchema,
  sampleRows: z.array(z.record(z.string(), z.string())),
  suggestedMapping: z.record(z.string(), z.string().nullable()),
});
export type ImportUploadResponse = z.infer<typeof importUploadResponseSchema>;

export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

/** Normalises a CSV header for synonym matching: "Customer_ID" → "customerid". */
export function normalizeHeader(header: string): string {
  return header
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Maps each field to the first unused column whose normalised name is a synonym. */
export function suggestMapping(
  entity: ImportEntity,
  columns: string[],
): Record<string, string | null> {
  const used = new Set<string>();
  const result: Record<string, string | null> = {};
  for (const field of IMPORT_FIELDS[entity]) {
    const match = field.synonyms
      .map((synonym) => columns.find((c) => !used.has(c) && normalizeHeader(c) === synonym))
      .find(Boolean);
    result[field.key] = match ?? null;
    if (match) used.add(match);
  }
  return result;
}

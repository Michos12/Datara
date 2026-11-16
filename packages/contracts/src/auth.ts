import { z } from 'zod';
import {
  currencySchema,
  industrySchema,
  organizationNameSchema,
  organizationSchema,
  roleSchema,
  timezoneSchema,
} from './organization.js';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));

/** Length-based policy (NIST SP 800-63B): no composition rules, long passphrases welcome. */
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Must be at most ${PASSWORD_MAX_LENGTH} characters`);

export const signupRequestSchema = z.strictObject({
  email: emailSchema,
  password: passwordSchema,
  fullName: z.string().trim().min(1).max(120),
  organization: z.strictObject({
    name: organizationNameSchema,
    timezone: timezoneSchema,
    currency: currencySchema,
    industry: industrySchema,
  }),
});
export type SignupRequest = z.infer<typeof signupRequestSchema>;

export const loginRequestSchema = z.strictObject({
  email: emailSchema,
  // No policy checks on login: only the stored hash decides.
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const userSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  fullName: z.string(),
});
export type User = z.infer<typeof userSchema>;

export const membershipSummarySchema = z.object({
  organizationId: z.uuid(),
  organizationName: z.string(),
  role: roleSchema,
});
export type MembershipSummary = z.infer<typeof membershipSummarySchema>;

/** Returned by signup, login and /auth/me. */
export const sessionSchema = z.object({
  user: userSchema,
  organization: organizationSchema,
  role: roleSchema,
  memberships: z.array(membershipSummarySchema),
});
export type Session = z.infer<typeof sessionSchema>;

export const authResponseSchema = sessionSchema.extend({
  accessToken: z.string(),
  /** Seconds until the access token expires. */
  expiresIn: z.number().int(),
});
export type AuthResponse = z.infer<typeof authResponseSchema>;

export const refreshResponseSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number().int(),
});
export type RefreshResponse = z.infer<typeof refreshResponseSchema>;

/** Cookie and header names shared by API and web app. */
export const AUTH_COOKIES = {
  refresh: 'ci_refresh',
  csrf: 'ci_csrf',
} as const;
export const CSRF_HEADER = 'X-CSRF-Token';

import { z } from 'zod';
import { emailSchema, passwordSchema } from './auth.js';
import { roleSchema } from './organization.js';

/** Team management, invitations, password reset and organization switching (AUTH-04 … 06). */
export const INVITATION_TTL_DAYS = 7;
export const PASSWORD_RESET_TTL_MINUTES = 60;

export const memberSchema = z.object({
  userId: z.uuid(),
  email: z.string(),
  fullName: z.string(),
  role: roleSchema,
  joinedAt: z.string(),
  lastLoginAt: z.string().nullable(),
});
export type Member = z.infer<typeof memberSchema>;
export const memberListSchema = z.object({ data: z.array(memberSchema) });

export const updateMemberRequestSchema = z.strictObject({ role: roleSchema });
export type UpdateMemberRequest = z.infer<typeof updateMemberRequestSchema>;

export const createInvitationRequestSchema = z.strictObject({
  email: emailSchema,
  role: roleSchema,
});
export type CreateInvitationRequest = z.infer<typeof createInvitationRequestSchema>;

export const invitationSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  role: roleSchema,
  invitedBy: z.string().nullable(),
  expiresAt: z.string(),
  createdAt: z.string(),
  /** False when the email could not be sent; the invitation still exists and can be resent. */
  emailSent: z.boolean().optional(),
});
export type Invitation = z.infer<typeof invitationSchema>;
export const invitationListSchema = z.object({ data: z.array(invitationSchema) });

const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{20,200}$/, 'Invalid link');

export const invitationPreviewRequestSchema = z.strictObject({ token: tokenSchema });

export const invitationPreviewSchema = z.object({
  organizationName: z.string(),
  email: z.string(),
  role: roleSchema,
  /** The invited email already has an account: accept with its password. */
  accountExists: z.boolean(),
  expiresAt: z.string(),
});
export type InvitationPreview = z.infer<typeof invitationPreviewSchema>;

/** Existing account: `password` only. New account: `fullName` and a new `password`. */
export const acceptInvitationRequestSchema = z.strictObject({
  token: tokenSchema,
  password: z.string().min(1).max(128),
  fullName: z.string().trim().min(1).max(120).optional(),
});
export type AcceptInvitationRequest = z.infer<typeof acceptInvitationRequestSchema>;

export const forgotPasswordRequestSchema = z.strictObject({ email: emailSchema });
export type ForgotPasswordRequest = z.infer<typeof forgotPasswordRequestSchema>;

export const resetPasswordRequestSchema = z.strictObject({
  token: tokenSchema,
  newPassword: passwordSchema,
});
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequestSchema>;

export const switchOrganizationRequestSchema = z.strictObject({ organizationId: z.uuid() });
export type SwitchOrganizationRequest = z.infer<typeof switchOrganizationRequestSchema>;

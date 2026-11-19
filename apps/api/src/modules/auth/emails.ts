import type { Role } from '@ci/contracts';
import { escapeHtml, type Email } from '../../infra/mailer.js';

const ROLE_NAMES: Record<Role, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  ANALYST: 'Analyst',
  VIEWER: 'Viewer',
};

function html(paragraphs: string[], link: { href: string; label: string }): string {
  return [
    '<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#161a22">',
    ...paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`),
    `<p><a href="${escapeHtml(link.href)}" style="display:inline-block;background:#2f5bd3;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">${escapeHtml(link.label)}</a></p>`,
    `<p style="color:#5b6474;font-size:13px">Or paste this link into your browser: ${escapeHtml(link.href)}</p>`,
    '</div>',
  ].join('');
}

export function passwordResetEmail(to: string, link: string, minutes: number): Email {
  const lines = [
    'Someone asked to reset the password of your Customer Insights account.',
    `The link below works once and expires in ${minutes} minutes. If it wasn't you, ignore this email: your password stays the same.`,
  ];
  return {
    to,
    subject: 'Reset your Customer Insights password',
    text: `${lines.join('\n\n')}\n\n${link}\n`,
    html: html(lines, { href: link, label: 'Choose a new password' }),
  };
}

export function invitationEmail(input: {
  to: string;
  link: string;
  organizationName: string;
  inviterName: string | null;
  role: Role;
  days: number;
}): Email {
  const who = input.inviterName ?? 'A teammate';
  const lines = [
    `${who} invited you to join ${input.organizationName} on Customer Insights as ${ROLE_NAMES[input.role]}.`,
    `The invitation expires in ${input.days} days.`,
  ];
  return {
    to: input.to,
    subject: `Join ${input.organizationName} on Customer Insights`,
    text: `${lines.join('\n\n')}\n\n${input.link}\n`,
    html: html(lines, { href: input.link, label: 'Accept the invitation' }),
  };
}

// Mail outbox. Choosing an SMTP provider is an open decision (§7), and password
// reset must not wait on it, so outbound mail is appended here as JSON lines
// and delivered by whatever the operator wires up later.
//
// The file holds live reset tokens — it is a mailbox, not a log — so it is
// created 0600 and belongs under a systemd-protected state directory, never in
// the log shipping path.
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface OutboxMessage {
  /** `password_reset`, and whatever later milestones add. */
  type: string;
  /** Normalized recipient address. */
  to: string;
  [field: string]: unknown;
}

/**
 * Append one message. Callers must treat a rejection as non-fatal: a mail that
 * cannot be written is a delivery failure, not a reason to fail the request
 * that produced it (and failing it would leak whether the address existed).
 */
export async function appendOutbox(
  path: string,
  message: OutboxMessage,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const line = `${JSON.stringify({ ...message, queued_at: new Date().toISOString() })}\n`;
  // `mode` applies only when this call creates the file.
  await appendFile(path, line, { encoding: 'utf8', mode: 0o600 });
}

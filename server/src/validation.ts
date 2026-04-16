import { z } from 'zod';
import type { Socket } from 'socket.io';

// Finite number: rejects NaN and ±Infinity so they can't propagate into the
// simulator (where they instantly corrupt positions and velocities).
const finiteNumber = z.number().finite();

// ── Schemas for every inbound Socket.IO event ──
//
// Keep these deliberately narrow: we trust the client to send roughly the
// right shape, but we never trust it for unbounded strings, non-finite
// numbers, or unexpected fields. Any payload that fails validation is
// silently dropped (logged server-side) without crashing the handler.

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const JoinRoomSchema = z.object({
  playerName: z.string().min(1).max(32),
  color: hexColor.optional(),
});

export const MovementInputSchema = z.object({
  forward: z.boolean(),
  backward: z.boolean(),
  left: z.boolean(),
  right: z.boolean(),
});

export const AimUpdateSchema = z.object({
  turretRotation: finiteNumber,
  barrelPitch: finiteNumber,
});

const Vec3Schema = z.object({
  x: finiteNumber,
  y: finiteNumber,
  z: finiteNumber,
});

export const FireRequestSchema = z.object({
  weaponId: z.string().min(1).max(32),
  aimPoint: Vec3Schema.nullish(),
});

/** Attach a type-checked `.on` handler. Invalid payloads are logged and
 *  dropped; the user-supplied `handler` only runs on parsed data. Returns
 *  nothing — the `.on` binding lives on the socket as usual. */
export function onValidated<T>(
  socket: Socket,
  event: string,
  schema: z.ZodType<T>,
  handler: (data: T) => void,
): void {
  // Socket.IO's typed events give us no static hook for "arbitrary event
  // name with unknown payload", so we cast here. The validation below is
  // the actual type guard.
  (socket as unknown as Socket).on(event, (raw: unknown) => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const reasons = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      // eslint-disable-next-line no-console
      console.warn(`[validation] rejected '${event}' from ${socket.id}: ${reasons}`);
      return;
    }
    handler(parsed.data);
  });
}

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

// Accept both short (#rgb) and long (#rrggbb) hex — the client's login
// palette uses the short form, while user-typed colors tend to be long.
const hexColor = z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);

export const JoinRoomSchema = z.object({
  playerName: z.string().min(1).max(32),
  color: hexColor.optional(),
  flagId: z.string().optional(),
});

export const MovementInputSchema = z.object({
  forward: z.boolean(),
  backward: z.boolean(),
  left: z.boolean(),
  right: z.boolean(),
  turbo: z.boolean().optional(),
  // Monotonic client tick; used by the server to ack the latest applied
  // input so the client can rewind-and-replay reconciliation. Finite + >=0.
  seq: finiteNumber.nonnegative(),
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
 *  dropped; the user-supplied `handler` only runs on parsed data. The
 *  handler's `data` parameter is typed as `z.infer<Schema>`, so there's no
 *  need to annotate it at call sites. */
export function onValidated<S extends z.ZodType>(
  socket: Socket,
  event: string,
  schema: S,
  handler: (data: z.infer<S>) => void,
): void {
  // Socket.IO's typed events give us no static hook for "arbitrary event
  // name with unknown payload", so we cast here. The safeParse below is
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

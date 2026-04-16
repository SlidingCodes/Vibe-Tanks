import { describe, it, expect } from 'vitest';
import {
  AimUpdateSchema,
  FireRequestSchema,
  JoinRoomSchema,
  MovementInputSchema,
} from '../src/validation';

describe('JoinRoomSchema', () => {
  it('accepts a well-formed join payload', () => {
    expect(JoinRoomSchema.safeParse({ playerName: 'Alice', color: '#abcdef' }).success).toBe(true);
    expect(JoinRoomSchema.safeParse({ playerName: 'Alice' }).success).toBe(true);
  });

  it('rejects empty, oversized, or non-string names', () => {
    expect(JoinRoomSchema.safeParse({ playerName: '' }).success).toBe(false);
    expect(JoinRoomSchema.safeParse({ playerName: 'x'.repeat(33) }).success).toBe(false);
    expect(JoinRoomSchema.safeParse({ playerName: 42 }).success).toBe(false);
    expect(JoinRoomSchema.safeParse({}).success).toBe(false);
  });

  it('rejects malformed color strings', () => {
    expect(JoinRoomSchema.safeParse({ playerName: 'a', color: 'red' }).success).toBe(false);
    expect(JoinRoomSchema.safeParse({ playerName: 'a', color: '#abc' }).success).toBe(false);
    expect(JoinRoomSchema.safeParse({ playerName: 'a', color: 'abcdef' }).success).toBe(false);
  });
});

describe('MovementInputSchema', () => {
  it('accepts all-false and arbitrary bool combinations', () => {
    expect(MovementInputSchema.safeParse({
      forward: false, backward: false, left: false, right: false,
    }).success).toBe(true);
    expect(MovementInputSchema.safeParse({
      forward: true, backward: false, left: true, right: false,
    }).success).toBe(true);
  });

  it('rejects non-booleans and missing keys', () => {
    expect(MovementInputSchema.safeParse({
      forward: 1, backward: 0, left: true, right: false,
    }).success).toBe(false);
    expect(MovementInputSchema.safeParse({
      forward: true, backward: false, left: true,
    }).success).toBe(false);
  });
});

describe('AimUpdateSchema', () => {
  it('accepts finite numbers', () => {
    expect(AimUpdateSchema.safeParse({ turretRotation: 0, barrelPitch: 0 }).success).toBe(true);
    expect(AimUpdateSchema.safeParse({ turretRotation: -Math.PI, barrelPitch: 0.3 }).success).toBe(true);
  });

  it('rejects NaN, ±Infinity, and non-numbers', () => {
    expect(AimUpdateSchema.safeParse({ turretRotation: Number.NaN, barrelPitch: 0 }).success).toBe(false);
    expect(AimUpdateSchema.safeParse({ turretRotation: Infinity, barrelPitch: 0 }).success).toBe(false);
    expect(AimUpdateSchema.safeParse({ turretRotation: '1', barrelPitch: 0 }).success).toBe(false);
  });
});

describe('FireRequestSchema', () => {
  it('accepts a weaponId with no aim point', () => {
    expect(FireRequestSchema.safeParse({ weaponId: 'standard' }).success).toBe(true);
    expect(FireRequestSchema.safeParse({ weaponId: 'mortar_rain', aimPoint: null }).success).toBe(true);
  });

  it('accepts a weaponId with a finite aim point', () => {
    expect(FireRequestSchema.safeParse({
      weaponId: 'mortar_rain',
      aimPoint: { x: 10, y: 0, z: 20 },
    }).success).toBe(true);
  });

  it('rejects malformed weaponId or non-finite aim components', () => {
    expect(FireRequestSchema.safeParse({ weaponId: '', aimPoint: null }).success).toBe(false);
    expect(FireRequestSchema.safeParse({
      weaponId: 'x'.repeat(33),
    }).success).toBe(false);
    expect(FireRequestSchema.safeParse({
      weaponId: 'mortar_rain',
      aimPoint: { x: Infinity, y: 0, z: 0 },
    }).success).toBe(false);
    expect(FireRequestSchema.safeParse({
      weaponId: 'mortar_rain',
      aimPoint: { x: 0, y: 0 }, // missing z
    }).success).toBe(false);
  });
});

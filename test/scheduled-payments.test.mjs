import assert from 'node:assert/strict';
import test from 'node:test';
import {
  maximumScheduleIntervalHours,
  normalizeScheduleInput,
  resolveFailurePauseThreshold,
} from '../src/scheduled-payments.mjs';

const recipient = '0xB87B6D1a56bB7942bd07b6B0e9540a63b3dA4365';
const nowMs = Date.parse('2026-07-20T12:00:00.000Z');

test('normalizes a complete recurring payment schedule', () => {
  const input = normalizeScheduleInput({
    recipient,
    amount: '1.250000',
    label: 'Weekly creator support',
    intervalHours: 168,
    firstRunAt: '2026-07-21T12:00:00.000Z',
  }, { nowMs });

  assert.deepEqual(input, {
    recipient: recipient.toLowerCase(),
    amount: '1.25',
    label: 'Weekly creator support',
    intervalHours: 168,
    firstRunAt: new Date('2026-07-21T12:00:00.000Z'),
    enabled: true,
  });
});

test('defaults the first run to one interval from now', () => {
  const input = normalizeScheduleInput({
    recipient,
    amount: '2',
    intervalHours: 24,
  }, { nowMs });

  assert.equal(input.firstRunAt.toISOString(), '2026-07-21T12:00:00.000Z');
  assert.equal(input.label, null);
});

test('accepts a partial pause update without payment fields', () => {
  assert.deepEqual(normalizeScheduleInput({ enabled: false }, { partial: true, nowMs }), {
    enabled: false,
  });
});

test('uses the existing interval when only the next run changes', () => {
  const input = normalizeScheduleInput({
    firstRunAt: '2026-07-22T12:00:00.000Z',
  }, {
    partial: true,
    nowMs,
    fallbackIntervalHours: 168,
  });

  assert.equal(input.firstRunAt.toISOString(), '2026-07-22T12:00:00.000Z');
});

test('rejects unsafe interval, amount, and start time values', () => {
  assert.throws(() => normalizeScheduleInput({
    recipient,
    amount: '1',
    intervalHours: 0,
  }, { nowMs }), /intervalHours/);

  assert.throws(() => normalizeScheduleInput({
    recipient,
    amount: '1',
    intervalHours: maximumScheduleIntervalHours + 1,
  }, { nowMs }), /intervalHours/);

  assert.throws(() => normalizeScheduleInput({
    recipient,
    amount: '1.0000001',
    intervalHours: 24,
  }, { nowMs }), /6 decimal places/);

  assert.throws(() => normalizeScheduleInput({
    recipient,
    amount: '1',
    intervalHours: 24,
    firstRunAt: '2026-07-20T11:00:00.000Z',
  }, { nowMs }), /past/);
});

test('bounds the automatic failure pause threshold', () => {
  assert.equal(resolveFailurePauseThreshold(undefined), 3);
  assert.equal(resolveFailurePauseThreshold('0'), 1);
  assert.equal(resolveFailurePauseThreshold('4'), 4);
  assert.equal(resolveFailurePauseThreshold('99'), 10);
});

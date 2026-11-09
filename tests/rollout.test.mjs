import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bucketFor,
  parseUid,
  percentageFor,
  selectRelease,
} from '../services/ota/src/rollout.mjs';

test('同一 uid 永远落在同一个桶', () => {
  for (const uid of ['u-abc', 'device-1', 'u-zzz']) {
    assert.equal(bucketFor(uid), bucketFor(uid));
  }
});

test('桶值始终在 0-99', () => {
  for (let i = 0; i < 500; i += 1) {
    const bucket = bucketFor(`u-${i}`);
    assert.ok(Number.isInteger(bucket) && bucket >= 0 && bucket < 100, `bucket=${bucket}`);
  }
});

test('100% 放量时所有设备拿 current', () => {
  const channel = {
    releaseId: 'r2',
    rollout: { percentage: 100, whitelist: [] },
    previous: { releaseId: 'r1' },
  };
  assert.equal(selectRelease(channel, 'u-x').served, 'current');
  assert.equal(selectRelease(channel, null).served, 'current');
});

test('0% 放量时除白名单外全部拿 previous', () => {
  const channel = {
    releaseId: 'r2',
    rollout: { percentage: 0, whitelist: ['u-white'] },
    previous: { releaseId: 'r1' },
  };
  assert.equal(selectRelease(channel, 'u-other').served, 'previous');
  assert.equal(selectRelease(channel, 'u-white').served, 'whitelist');
});

test('无 uid 且未全量时回退 previous，避免误放量', () => {
  const channel = {
    releaseId: 'r2',
    rollout: { percentage: 50, whitelist: [] },
    previous: { releaseId: 'r1' },
  };
  const result = selectRelease(channel, null);
  assert.equal(result.served, 'previous');
  assert.equal(result.bucket, null);
});

test('没有 previous 时无法灰度，未命中仍标记 current', () => {
  const channel = {
    releaseId: 'r1',
    rollout: { percentage: 10, whitelist: [] },
    previous: null,
  };
  for (let i = 0; i < 50; i += 1) {
    const result = selectRelease(channel, `u-noprev-${i}`);
    assert.equal(result.served, 'current');
    assert.equal(result.releaseId, 'r1');
  }
});

test('有 previous 时未命中回退 previous', () => {
  const channel = {
    releaseId: 'r2',
    rollout: { percentage: 10, whitelist: [] },
    previous: { releaseId: 'r1' },
  };
  let previousCount = 0;
  for (let i = 0; i < 100; i += 1) {
    const result = selectRelease(channel, `u-prev-${i}`);
    if (result.served === 'previous') {
      previousCount += 1;
      assert.equal(result.releaseId, 'r1');
    }
  }
  assert.ok(previousCount > 0);
});

test('分桶边界严格按 bucket < percentage 命中 current', () => {
  const channel = {
    releaseId: 'r2',
    rollout: { percentage: 50, whitelist: [] },
    previous: { releaseId: 'r1' },
  };
  for (let i = 0; i < 300; i += 1) {
    const uid = `u-edge-${i}`;
    const bucket = bucketFor(uid);
    const result = selectRelease(channel, uid);
    assert.equal(result.bucket, bucket);
    assert.equal(result.served, bucket < 50 ? 'current' : 'previous');
  }
});

test('parseUid 解析 SFV 字典并拒绝非法值', () => {
  assert.equal(parseUid({ 'expo-extra-params': 'uid="u-abc123"' }), 'u-abc123');
  assert.equal(parseUid({ 'expo-extra-params': 'a=1, uid="u-x-1"' }), 'u-x-1');
  assert.equal(parseUid({ 'expo-extra-params': 'uid=u-plain' }), 'u-plain');
  assert.equal(parseUid({}), null);
  assert.equal(parseUid({ 'expo-extra-params': 'uid="has space"' }), null);
});

test('通道没有 releaseId 时返回 null', () => {
  assert.equal(selectRelease({ rollout: { percentage: 100 } }, 'u-x'), null);
});

test('平台覆盖按平台取百分比，未配置或未知平台跟随统一值', () => {
  const channel = {
    releaseId: 'r2',
    rollout: { percentage: 50, byPlatform: { ios: 0 }, whitelist: [] },
    previous: { releaseId: 'r1' },
  };
  assert.equal(percentageFor(channel, 'ios'), 0);
  assert.equal(percentageFor(channel, 'android'), 50);
  assert.equal(percentageFor(channel, undefined), 50);
  assert.equal(percentageFor(channel, 'web'), 50);
  assert.equal(percentageFor({ rollout: { percentage: 100 } }, 'ios'), 100);
});

test('同一 uid 在不同平台按各自百分比分流，桶值不变', () => {
  let uid;
  for (let i = 0; i < 500; i += 1) {
    const candidate = `u-platform-${i}`;
    const bucket = bucketFor(candidate);
    if (bucket >= 20 && bucket < 50) {
      uid = candidate;
      break;
    }
  }
  assert.ok(uid, '应能找到落在 20-49 桶的 uid');
  const channel = {
    releaseId: 'r2',
    rollout: { percentage: 50, byPlatform: { ios: 20, android: 50 }, whitelist: [] },
    previous: { releaseId: 'r1' },
  };
  const ios = selectRelease(channel, uid, 'ios');
  const android = selectRelease(channel, uid, 'android');
  assert.equal(ios.percentage, 20);
  assert.equal(ios.served, 'previous');
  assert.equal(ios.releaseId, 'r1');
  assert.equal(android.percentage, 50);
  assert.equal(android.served, 'current');
  assert.equal(android.releaseId, 'r2');
  assert.equal(ios.bucket, android.bucket);
});

test('平台 0% 时白名单仍直接命中 current，其它平台不受影响', () => {
  const channel = {
    releaseId: 'r2',
    rollout: { percentage: 100, byPlatform: { android: 0 }, whitelist: ['u-white'] },
    previous: { releaseId: 'r1' },
  };
  assert.equal(selectRelease(channel, 'u-white', 'android').served, 'whitelist');
  assert.equal(selectRelease(channel, 'u-other', 'android').served, 'previous');
  assert.equal(selectRelease(channel, 'u-other', 'ios').served, 'current');
});

test('平台覆盖非法值按 0 处理，不会误放量', () => {
  const channel = {
    releaseId: 'r2',
    rollout: { percentage: 30, byPlatform: { ios: 'not-a-number' }, whitelist: [] },
    previous: { releaseId: 'r1' },
  };
  assert.equal(percentageFor(channel, 'ios'), 0);
  assert.equal(selectRelease(channel, 'u-x', 'ios').served, 'previous');
});

test('无 uid 时平台覆盖同样只有 100% 才命中 current', () => {
  const channel = {
    releaseId: 'r2',
    rollout: { percentage: 100, byPlatform: { android: 10 }, whitelist: [] },
    previous: { releaseId: 'r1' },
  };
  assert.equal(selectRelease(channel, null, 'android').served, 'previous');
  assert.equal(selectRelease(channel, null, 'ios').served, 'current');
});

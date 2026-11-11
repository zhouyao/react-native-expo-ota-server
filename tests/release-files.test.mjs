import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ota-release-files-'));
const { linkOrCopyFile, linkTree } = await import('../services/ota/src/release-files.mjs');

after(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

async function seed(name, files) {
  const dir = path.join(tmp, name);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, content);
  }
  return dir;
}

test('linkTree 用硬链接重建目录，内容与 inode 都与源一致', async () => {
  const src = await seed('src-a', {
    'bundles/a.hbc': 'AAA',
    'bundles/a.hbc.gz': 'aaa-gz',
    'assets/img.png': 'PNG',
  });
  const dest = path.join(tmp, 'dest-a');

  const stats = await linkTree(src, dest);

  assert.equal(stats.copied, 0, '同设备时不应发生真实拷贝');
  assert.equal(stats.linked, 3);
  assert.equal(await fsp.readFile(path.join(dest, 'bundles/a.hbc'), 'utf8'), 'AAA');

  const srcStat = await fsp.stat(path.join(src, 'bundles/a.hbc'));
  const destStat = await fsp.stat(path.join(dest, 'bundles/a.hbc'));
  assert.equal(destStat.ino, srcStat.ino, '应共享同一个 inode');
});

test('删除源目录后目标仍然可读（硬链接不共享目录项）', async () => {
  const src = await seed('src-b', { 'bundles/b.hbc': 'BBB' });
  const dest = path.join(tmp, 'dest-b');
  await linkTree(src, dest);

  await fsp.rm(src, { recursive: true, force: true });

  assert.equal(await fsp.readFile(path.join(dest, 'bundles/b.hbc'), 'utf8'), 'BBB');
});

test('源目录不存在时返回零计数而不是抛错（没有 assets/ 是正常情况）', async () => {
  const stats = await linkTree(path.join(tmp, 'missing'), path.join(tmp, 'dest-c'));
  assert.deepEqual(stats, { linked: 0, copied: 0 });
});

test('linkOrCopyFile 对真实错误不静默吞掉', async () => {
  await assert.rejects(
    linkOrCopyFile(path.join(tmp, 'not-exist.hbc'), path.join(tmp, 'dest-d/x.hbc')),
    (error) => error.code === 'ENOENT',
  );
});

test('linkOrCopyFile 自动创建父目录', async () => {
  const src = await seed('src-e', { 'bundles/e.hbc': 'EEE' });
  const dest = path.join(tmp, 'dest-e', 'deep', 'dir', 'e.hbc');

  const kind = await linkOrCopyFile(path.join(src, 'bundles/e.hbc'), dest);

  assert.equal(kind, 'link');
  assert.equal(await fsp.readFile(dest, 'utf8'), 'EEE');
});

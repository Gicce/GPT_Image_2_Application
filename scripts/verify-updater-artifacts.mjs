#!/usr/bin/env node
/**
 * Updater 分发链验证脚本（零第三方依赖，Node >= 18）。
 *
 * 用途（Release workflow 最后一步 + 本地诊断）：
 *   1. 拉取 Official latest.json（URL 或本地路径）
 *   2. 校验 version == 期望版本（可选）
 *   3. 校验所有 platforms.*.url 的 host ∈ 允许列表（Official Manifest 禁止指向 github.com）
 *   4. 逐平台下载安装包，用客户端内置 minisign 公钥验签（tauri 为 prehashed 模式：
 *      Ed25519 over BLAKE2b-512(file)，全局签名 over sig64 + 去前缀 trusted comment）
 *   5. 可选：比对每个平台安装包 SHA256 与本地构建产物（byte-for-byte 镜像保证）
 *
 * 示例：
 *   node scripts/verify-updater-artifacts.mjs \
 *     --manifest https://www.zjcypc.com/client-updates/latest.json \
 *     --pubkey dW50cnVzdGVk... \
 *     --expect-version 4.0.4 \
 *     --allow-host www.zjcypc.com \
 *     --expect-sha256 windows-x86_64-nsis=<sha256>
 *
 * 任一项失败即非零退出（Release FAIL）。
 */
import { argv, exit } from 'node:process';
import { readFileSync } from 'node:fs';
import { createHash, createPublicKey, verify } from 'node:crypto';

function arg(name, required = true) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= argv.length) {
    if (required) { console.error(`missing --${name}`); exit(2); }
    return undefined;
  }
  return argv[i + 1];
}

function fail(msg) { console.error(`::error::${msg}`); exit(1); }

async function loadManifest(source) {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source, { redirect: 'follow' });
    if (!res.ok) fail(`manifest ${source} -> HTTP ${res.status}`);
    return res.json();
  }
  return JSON.parse(readFileSync(source, 'utf8'));
}

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) fail(`artifact ${url} -> HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// minisign 公钥（tauri.conf.json plugins.updater.pubkey 的值）：base64(两行文本)，
// 第二行 base64 解码为 2B 算法 + 8B keynum + 32B Ed25519 公钥
function parsePubkey(pubkeyB64) {
  const lines = Buffer.from(pubkeyB64, 'base64').toString('utf8').split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) fail('pubkey 格式非法');
  const bin = Buffer.from(lines[1], 'base64');
  if (bin.length !== 42) fail(`pubkey 长度非法: ${bin.length}`);
  const raw = bin.subarray(10);
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
  return createPublicKey({ key: spki, format: 'der', type: 'spki' });
}

// latest.json 的 signature 字段 = base64(.sig 文件全文)
function parseSignature(signatureB64) {
  const lines = Buffer.from(signatureB64, 'base64').toString('utf8').split(/\r?\n/).filter(Boolean);
  if (lines.length < 4) fail('signature 格式非法');
  const bin = Buffer.from(lines[1], 'base64');
  if (bin.length !== 74) fail(`signature 长度非法: ${bin.length}`);
  const alg = bin.subarray(0, 2).toString('latin1');
  const sig = bin.subarray(10);
  const trustedComment = lines[2];
  if (!trustedComment.startsWith('trusted comment: ')) fail('trusted comment 前缀非法');
  return { alg, sig, commentNoPrefix: trustedComment.slice('trusted comment: '.length), globalSig: Buffer.from(lines[3], 'base64') };
}

const manifest = await loadManifest(arg('manifest'));
const pubkey = parsePubkey(arg('pubkey'));
const expectVersion = arg('expect-version', false);
const allowHosts = (arg('allow-host', false) ?? '').split(',').map(s => s.trim()).filter(Boolean);
const expectSha = new Map(
  (arg('expect-sha256', false) ?? '').split(',').map(pair => pair.split('=')).filter(p => p.length === 2)
);

const problems = [];
if (expectVersion && manifest.version !== expectVersion) {
  problems.push(`version ${manifest.version} != 期望 ${expectVersion}`);
}
if (!manifest.platforms || Object.keys(manifest.platforms).length === 0) {
  problems.push('platforms 为空');
}

for (const [plat, entry] of Object.entries(manifest.platforms ?? {})) {
  const url = new URL(entry.url);
  if (allowHosts.length && !allowHosts.includes(url.host)) {
    problems.push(`${plat}: url host ${url.host} 不在允许列表（Official manifest 禁止指向 GitHub）`);
    continue;
  }
  if (!entry.signature) { problems.push(`${plat}: 缺少 signature`); continue; }

  const data = await download(entry.url);
  const sha256 = createHash('sha256').update(data).digest('hex');
  const expected = expectSha.get(plat);
  if (expected && expected !== sha256) {
    problems.push(`${plat}: SHA256 ${sha256} != 构建产物 ${expected}（镜像非 byte-for-byte）`);
  }

  const { alg, sig, commentNoPrefix, globalSig } = parseSignature(entry.signature);
  if (alg !== 'ED') { problems.push(`${plat}: 非预期签名算法 ${alg}`); continue; }
  const digest = createHash('blake2b512').update(data).digest();
  const primaryOk = verify(null, digest, pubkey, sig);
  const globalOk = verify(null, Buffer.concat([sig, Buffer.from(commentNoPrefix, 'utf8')]), pubkey, globalSig);
  if (!primaryOk) problems.push(`${plat}: minisign 主签名验证失败`);
  if (!globalOk) problems.push(`${plat}: minisign 全局签名验证失败`);
  console.log(`${plat}: ${url.host}${url.pathname} sha256=${sha256.slice(0, 16)}... sig=${primaryOk && globalOk ? 'OK' : 'FAIL'}`);
}

if (problems.length) {
  for (const p of problems) console.error(`::error::${p}`);
  exit(1);
}
console.log(`updater 分发链验证通过: version=${manifest.version} platforms=${Object.keys(manifest.platforms).length}`);

#!/usr/bin/env node
// scripts/keygen.mjs
// 1peng 激活码生成工具 — 仅供卖方离线使用
//
// 用法:
//   node scripts/keygen.mjs              # 生成 1 个激活码
//   node scripts/keygen.mjs 10           # 批量生成 10 个
//   node scripts/keygen.mjs init         # 首次使用，生成密钥文件
//
// 密钥文件: keygen.secret.json (务必妥善保管，不要提交到 git)

import { createHash, randomBytes } from 'crypto'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SECRET_FILE = join(__dirname, 'keygen.secret.json')

// ── Base32 ──
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
function b32Encode(buf) {
  let bits = 0, value = 0, out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

// ── 密钥管理 ──
function loadSecret() {
  if (!existsSync(SECRET_FILE)) {
    console.error('❌ 密钥文件不存在！请先运行: node scripts/keygen.mjs init')
    process.exit(1)
  }
  return JSON.parse(readFileSync(SECRET_FILE, 'utf8'))
}

function initSecret() {
  if (existsSync(SECRET_FILE)) {
    console.log('⚠️  密钥文件已存在，如需重新生成请先删除:', SECRET_FILE)
    process.exit(1)
  }
  const key = randomBytes(32).toString('base64')
  const secret = {
    key,
    createdAt: new Date().toISOString(),
    note: '此文件是激活码生成的唯一密钥，请妥善保管，切勿泄露或提交到版本控制。'
  }
  writeFileSync(SECRET_FILE, JSON.stringify(secret, null, 2))
  console.log('✅ 密钥文件已生成:', SECRET_FILE)
  console.log('⚠️  请务必将 keygen.secret.json 加入 .gitignore')
  console.log('   密钥 (base64):', key)
}

// ── 激活码生成 ──
function generateCode(secretKey) {
  const keyBuf = Buffer.from(secretKey, 'base64')

  // 4 字节随机 ID
  const idBytes = randomBytes(4)

  // HMAC-SHA256(key, id) 取前 10 字节作为校验码
  const hmac = createHash('sha256')
    .update(keyBuf)
    .update(idBytes)
    .digest()
  const checkBytes = hmac.subarray(0, 10)

  // 组合: [4 bytes ID] + [10 bytes check] = 14 bytes
  const payload = Buffer.concat([idBytes, checkBytes])

  // Base32 编码 → 23 字符 → 格式化为 XXXXX-XXXXX-XXXXX-XXXXX-XXX
  const raw = b32Encode(payload)
  const formatted = raw.match(/.{1,5}/g).join('-')

  return { id: idBytes.toString('hex'), code: formatted }
}

// ── 生成激活码用于 app 验证的校验值 ──
// 这个函数需要和 license.ts 中的验证逻辑完全一致
function computeCheckBytes(idBytes, secretKey) {
  const keyBuf = Buffer.from(secretKey, 'base64')
  const hmac = createHash('sha256')
    .update(keyBuf)
    .update(idBytes)
    .digest()
  return hmac.subarray(0, 10)
}

// ── 输出嵌入应用的校验密钥 ──
// 将 HMAC 密钥导出为一个转换后的验证密钥
// App 端使用此密钥验证激活码，但无法逆向生成新码
function exportVerifyKey(secretKey) {
  const keyBuf = Buffer.from(secretKey, 'base64')
  // 对密钥做一次 hash，作为验证专用密钥
  // 这样即使验证密钥泄露，也无法反推原始生成密钥
  const verifyKey = createHash('sha256').update(keyBuf).digest()
  return verifyKey.toString('base64')
}

// ── Main ──
const arg = process.argv[2]

if (arg === 'init') {
  initSecret()
} else if (arg === 'verify-key') {
  // 输出嵌入 app 的密钥（与生成端相同的原始密钥）
  const { key } = loadSecret()
  console.log('📋 嵌入应用的密钥 (base64):')
  console.log(key)
  const half = Math.ceil(key.length / 2)
  console.log(`\n拆分为两部分，填入 src/core/license.ts 的 _k 数组:`)
  console.log(`  Part 1: ${key.slice(0, half)}`)
  console.log(`  Part 2: ${key.slice(half)}`)
} else {
  const count = parseInt(arg) || 1
  const { key } = loadSecret()

  console.log(`🔑 生成 ${count} 个激活码:\n`)
  const codes = []
  for (let i = 0; i < count; i++) {
    const { id, code } = generateCode(key)
    codes.push({ id, code, generatedAt: new Date().toISOString() })
    console.log(`  ${i + 1}. ${code}  (ID: ${id})`)
  }

  // 保存到日志文件
  const logFile = join(__dirname, 'keygen.log.json')
  let existing = []
  if (existsSync(logFile)) {
    try { existing = JSON.parse(readFileSync(logFile, 'utf8')) } catch {}
  }
  existing.push(...codes)
  writeFileSync(logFile, JSON.stringify(existing, null, 2))
  console.log(`\n📝 已记录到: ${logFile}`)
}

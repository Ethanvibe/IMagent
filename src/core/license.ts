// src/core/license.ts
// HMAC-SHA256 离线激活码验证模块
//
// 激活码格式: XXXXX-XXXXX-XXXXX-XXXXX-XXXXX (25字符，5组5位)
// 内部结构: [4字节随机ID] + [10字节HMAC校验] = 14字节 → base32 → 25字符
//
// 生成端 (keygen.mjs): 持有完整密钥，用 HMAC-SHA256 生成激活码
// 验证端 (本文件): 嵌入同一密钥，验证激活码的 HMAC 是否匹配
//
// 安全说明:
// - 密钥经过 base64 + 拆分 + 混淆存储，增加逆向难度
// - 桌面应用无法做到完全防破解，此方案足以防止普通用户自行生成激活码
// - 如需更高安全性，可后续升级为在线验证

import { createHash } from 'crypto'

// ── Base32 (RFC 4648, no padding) ──
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function b32Decode(str: string): Buffer {
  const clean = str.replace(/[^A-Z2-7]/gi, '').toUpperCase()
  let bits = 0, value = 0
  const bytes: number[] = []
  for (const ch of clean) {
    const idx = B32.indexOf(ch)
    if (idx < 0) throw new Error(`Invalid character: ${ch}`)
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

// ── 嵌入密钥 (混淆存储) ──
// 运行 `node scripts/keygen.mjs verify-key` 获取此值
// 生成密钥后替换下方占位符
const _k = [
  'XYQR6B8wGiSirl+QaqfZ3C',  // part 1
  'utiKBzCiPZHU6miQogKpU=',  // part 2
]

function getKey(): Buffer {
  return Buffer.from(_k.join(''), 'base64')
}

// ── 格式化 ──
function parseKey(formatted: string): string {
  return formatted.replace(/[^A-Z2-7]/gi, '').toUpperCase()
}

function formatKey(raw: string): string {
  return raw.match(/.{1,5}/g)!.join('-')
}

// ── 核心验证 ──
export interface LicenseInfo {
  id: string
  activatedAt: number
  key: string
}

export async function verifyActivationCode(code: string): Promise<{
  valid: boolean
  error?: string
  info?: LicenseInfo
}> {
  try {
    const raw = parseKey(code)
    if (raw.length !== 25) {
      return { valid: false, error: '激活码格式错误，应为 XXXXX-XXXXX-XXXXX-XXXXX-XXXXX' }
    }

    const payload = b32Decode(raw)
    if (payload.length < 14) {
      return { valid: false, error: '激活码数据不完整' }
    }

    const idBytes = payload.subarray(0, 4)
    const checkBytes = payload.subarray(4, 14)

    // 用嵌入的密钥重新计算 HMAC，比对前 10 字节
    const keyBuf = getKey()
    const hmac = createHash('sha256')
      .update(keyBuf)
      .update(idBytes)
      .digest()
    const expected = hmac.subarray(0, 10)

    if (!checkBytes.equals(expected)) {
      return { valid: false, error: '激活码无效' }
    }

    const id = idBytes.toString('hex')
    return {
      valid: true,
      info: {
        id,
        activatedAt: Date.now(),
        key: formatKey(raw)
      }
    }
  } catch (err: any) {
    return { valid: false, error: `验证失败: ${err?.message || err}` }
  }
}

// ── 激活状态持久化 ──
export function getStoredLicense(getFn: (key: string) => any): LicenseInfo | null {
  const stored = getFn('license')
  if (!stored || typeof stored !== 'object') return null
  return stored as LicenseInfo
}

export function storeLicense(setFn: (key: string, value: any) => void, info: LicenseInfo): void {
  setFn('license', info)
}

export function isActivated(getFn: (key: string) => any): boolean {
  return !!getStoredLicense(getFn)
}

/**
 * 线上的 JSON 字节：拼与拆的最小机制。
 *
 * **接上哪个功能**：键盘与计时器触发的请求（裁决台键盘流、防抖搜索、
 * Ctrl+Enter 派发）。Msg 只能从 Zig 的 UI 回调发出，而这类请求的数据
 * （游标行的提案 id、理由、查询词）在触发时刻没有任何 Zig 事件在场——
 * 预编模式（饭盒的 `verdict_begin`）覆盖不到它们，所以 core 必须能自己
 * 拼出与 Zig `project_request.zig` 逐字节同形的 JSON。
 *
 * **在全局逻辑中负责什么**：只做字节级的 JSON 力学——拼接、转义、反转义、
 * 按序取字段。不认识任何 RefRain 词汇（rootId、proposalId 归调用方）。
 * 转义规则是 JSON 标准的子集：serde_json 只转义引号、反斜杠与控制字符
 * （非 ASCII 以原始 UTF-8 出行），所以 `\uXXXX` 在本仓库的生产者手里
 * 恒为 `\u00XX`；反转义仍按完整规则实现（含代理对），不认得的序列原样
 * 保留——读不出来不该静默变成另一段字。
 *
 * **能复用什么**：`core.ts` 的 `quotedField`/`numberField` 是这套机制的
 * 前身（不感知转义的定长切片）。本模块是有测试的正式机制；旧函数的归并
 * 归阶段 3 审计。
 */

/** 把若干段字节接成一段。零分配合成一次：先量总长，再一次填满。 */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (let index = 0; index < parts.length; index += 1)
    total += (parts[index] as Uint8Array).length;
  const out = new Uint8Array(total);
  let at = 0;
  for (let index = 0; index < parts.length; index += 1) {
    out.set(parts[index] as Uint8Array, at);
    at += (parts[index] as Uint8Array).length;
  }
  return out;
}

/**
 * 把一段原始 UTF-8 转成可放进 JSON 字符串两引号之间的字节。
 *
 * 短转义照 JSON 惯例（\n \r \t \b \f），引号与反斜杠必转，其余控制
 * 字符走 \u00XX。非 ASCII 字节原样通过（UTF-8 字节的值都 ≥ 0x80，
 * 不会撞上任何要转义的码位）。
 */
export function escapeJson(raw: Uint8Array): Uint8Array {
  let total = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const byte = raw[index] as number;
    if (byte === 0x22 || byte === 0x5c)
      total += 2; // " \
    else if (byte === 0x0a || byte === 0x0d || byte === 0x09)
      total += 2; // \n \r \t
    else if (byte === 0x08 || byte === 0x0c)
      total += 2; // \b \f
    else if (byte < 0x20)
      total += 6; // \u00XX
    else total += 1;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const byte = raw[index] as number;
    if (byte === 0x22 || byte === 0x5c) {
      out[at] = 0x5c;
      out[at + 1] = byte;
      at += 2;
    } else if (byte === 0x0a) {
      at = putShortEscape(out, at, 0x6e); // n
    } else if (byte === 0x0d) {
      at = putShortEscape(out, at, 0x72); // r
    } else if (byte === 0x09) {
      at = putShortEscape(out, at, 0x74); // t
    } else if (byte === 0x08) {
      at = putShortEscape(out, at, 0x62); // b
    } else if (byte === 0x0c) {
      at = putShortEscape(out, at, 0x66); // f
    } else if (byte < 0x20) {
      out[at] = 0x5c;
      out[at + 1] = 0x75; // u
      out[at + 2] = 0x30;
      out[at + 3] = 0x30;
      out[at + 4] = hexDigit(byte >> 4);
      out[at + 5] = hexDigit(byte & 0x0f);
      at += 6;
    } else {
      out[at] = byte;
      at += 1;
    }
  }
  return out;
}

/**
 * 反转义一段 JSON 字符串体（两引号之间的字节）回原始 UTF-8。
 *
 * 完整实现六个短转义与 `\uXXXX`（含代理对合并，码点手工编成 UTF-8——
 * 子集没有 TextEncoder）。不认得的反斜杠序列把两个字节原样留下：
 * 宁可让作者看见原始字节，也不替他猜一个意思。
 */
export function unescapeJson(body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length); // 反转义只会变短
  let at = 0;
  let cursor = 0;
  while (cursor < body.length) {
    const byte = body[cursor] as number;
    if (byte !== 0x5c || cursor + 1 >= body.length) {
      out[at] = byte;
      at += 1;
      cursor += 1;
      continue;
    }
    const next = body[cursor + 1] as number;
    if (next === 0x6e) {
      out[at] = 0x0a;
      at += 1;
      cursor += 2;
    } // n
    else if (next === 0x72) {
      out[at] = 0x0d;
      at += 1;
      cursor += 2;
    } // r
    else if (next === 0x74) {
      out[at] = 0x09;
      at += 1;
      cursor += 2;
    } // t
    else if (next === 0x62) {
      out[at] = 0x08;
      at += 1;
      cursor += 2;
    } // b
    else if (next === 0x66) {
      out[at] = 0x0c;
      at += 1;
      cursor += 2;
    } // f
    else if (next === 0x22 || next === 0x5c || next === 0x2f) {
      out[at] = next; // " \ /
      at += 1;
      cursor += 2;
    } else if (next === 0x75 && cursor + 5 < body.length) {
      // u（hexValue 还会再验界）
      const first = hexValue(body, cursor + 2);
      if (first < 0) {
        out[at] = byte;
        out[at + 1] = next;
        at += 2;
        cursor += 2;
        continue;
      }
      let codePoint = first;
      let width = 6;
      // 代理对：高代理后跟一个 \uDC00–\uDFFF 才合并；孤身代理按字面码点
      // 编码（UTF-8 的三字节序列），不替他修饰一段本就残缺的数据。
      if (
        first >= 0xd800 &&
        first <= 0xdbff &&
        cursor + 11 < body.length &&
        (body[cursor + 6] as number) === 0x5c &&
        (body[cursor + 7] as number) === 0x75
      ) {
        const second = hexValue(body, cursor + 8);
        if (second >= 0xdc00 && second <= 0xdfff) {
          codePoint = 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00);
          width = 12;
        }
      }
      at = putUtf8(out, at, codePoint);
      cursor += width;
    } else {
      out[at] = byte;
      out[at + 1] = next;
      at += 2;
      cursor += 2;
    }
  }
  return out.slice(0, at);
}

/** `pattern` 在 `text` 里从 `from` 起第一次出现的下标；找不到是 −1。 */
export function indexOfBytes(text: Uint8Array, pattern: Uint8Array, from: number): number {
  if (pattern.length === 0) return from <= text.length ? from : -1;
  let cursor = from;
  while (cursor + pattern.length <= text.length) {
    let matched = true;
    let offset = 0;
    while (offset < pattern.length) {
      if ((text[cursor + offset] as number) !== (pattern[offset] as number)) {
        matched = false;
        break;
      }
      offset += 1;
    }
    if (matched) return cursor;
    cursor += 1;
  }
  return -1;
}

/**
 * 一个按序取到的字符串字段。JSON null 与缺席一样是「没有」（found 为假）
 * ——调用方按「禁用」一并处理这两种不存在，不必分开。
 */
export interface StringField {
  readonly found: boolean;
  /** 反转义后的原始字节。 */
  readonly value: Uint8Array;
}

/**
 * 第 `ordinal` 个（从 0 起）`"name":` 字段的字符串值，逃逸感知。
 *
 * `name` 带冒号不带引号尾（如 `asciiBytes("\"id\":")`）。值是 JSON null
 * 或模式不出现那么多次时 `found` 为假。字符串体的引号配对认反斜杠
 * 跳过——正文里转义的 `\"id\":\"` 不会骗出一次假命中。
 */
export function stringFieldAt(text: Uint8Array, name: Uint8Array, ordinal: number): StringField {
  let from = 0;
  let remaining = ordinal;
  while (true) {
    const at = indexOfBytes(text, name, from);
    if (at < 0) return { found: false, value: new Uint8Array(0) };
    // 模式本身可能躺在某个字符串值里（正文的转义序列不含裸 `"id":`，
    // 但值里可以有不带冒号的巧合字节）——沿值边界走就不会读串中。
    const end = fieldValueEnd(text, at + name.length);
    if (remaining === 0) return readStringValue(text, at + name.length);
    from = end;
    remaining -= 1;
  }
}

/** `name` 字段一共出现几次。名录计数（rosterCount）的生产者之一。 */
export function countStringFields(text: Uint8Array, name: Uint8Array): number {
  let from = 0;
  let count = 0;
  while (true) {
    const at = indexOfBytes(text, name, from);
    if (at < 0) return count;
    from = fieldValueEnd(text, at + name.length);
    count += 1;
  }
}

/** 两段字节逐位相等。 */
export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if ((left[index] as number) !== (right[index] as number)) return false;
  }
  return true;
}

/**
 * `"name":[...]` 字符串数组里有几项（如 `"staged":["a","b"]` → 2）。
 * 只数字符串项；别的形状（对象、数字）数到 0——我们的线形里这些数组
 * 装的恒为字符串。找不到字段或不是数组都是 0。
 */
export function countStringArray(text: Uint8Array, name: Uint8Array): number {
  const open = arrayOpen(text, name);
  if (open < 0) return 0;
  let cursor = open;
  let count = 0;
  while (cursor < text.length) {
    const byte = text[cursor] as number;
    if (byte === 0x5d) return count; // ]
    if (byte === 0x22) {
      const close = stringClose(text, cursor);
      if (close < 0) return count;
      count += 1;
      cursor = close + 1;
      continue;
    }
    cursor += 1;
  }
  return count;
}

/**
 * `"name":[...]` 字符串数组的各项，以 \n 接成一段（项是 kebab 码，
 * 内部无引号无换行）。找不到字段交出空切片。用于恢复步骤码过界后
 * 在 Zig 侧逐项翻译。
 */
export function stringArrayField(text: Uint8Array, name: Uint8Array): Uint8Array {
  const open = arrayOpen(text, name);
  if (open < 0) return new Uint8Array(0);
  const out = new Uint8Array(text.length); // 项的总长不会超过全文
  let at = 0;
  let cursor = open;
  while (cursor < text.length) {
    const byte = text[cursor] as number;
    if (byte === 0x5d) break; // ]
    if (byte === 0x22) {
      const close = stringClose(text, cursor);
      if (close < 0) break;
      if (at > 0) {
        out[at] = 0x0a; // \n 分隔
        at += 1;
      }
      const item = unescapeJson(text.slice(cursor + 1, close));
      out.set(item, at);
      at += item.length;
      cursor = close + 1;
      continue;
    }
    cursor += 1;
  }
  return out.slice(0, at);
}

/** `"name":[` 之后第一个元素位的下标；找不到字段或不是数组是 −1。 */
function arrayOpen(text: Uint8Array, name: Uint8Array): number {
  const at = indexOfBytes(text, name, 0);
  if (at < 0) return -1;
  let cursor = at + name.length;
  while (cursor < text.length && isWhitespace(text[cursor] as number)) cursor += 1;
  if (cursor < text.length && (text[cursor] as number) === 0x3a) cursor += 1; // :
  while (cursor < text.length && isWhitespace(text[cursor] as number)) cursor += 1;
  if (cursor >= text.length || (text[cursor] as number) !== 0x5b) return -1; // [
  return cursor + 1;
}

/** 跳过空白后读一个字符串值；`null` 或别的形状都是「没有」。 */
function readStringValue(text: Uint8Array, from: number): StringField {
  let cursor = from;
  while (cursor < text.length && isWhitespace(text[cursor] as number)) cursor += 1;
  if (cursor >= text.length || (text[cursor] as number) !== 0x22) {
    return { found: false, value: new Uint8Array(0) };
  }
  const close = stringClose(text, cursor);
  if (close < 0) return { found: false, value: new Uint8Array(0) };
  return { found: true, value: unescapeJson(text.slice(cursor + 1, close)) };
}

/** 一个字段值的结束下标（逗号/括号处），用来跳过本次命中继续找。 */
function fieldValueEnd(text: Uint8Array, from: number): number {
  let cursor = from;
  while (cursor < text.length && isWhitespace(text[cursor] as number)) cursor += 1;
  if (cursor < text.length && (text[cursor] as number) === 0x22) {
    const close = stringClose(text, cursor);
    return close < 0 ? text.length : close + 1;
  }
  // 标量（null/数字/真假）：走到下一个结构字符。
  while (cursor < text.length) {
    const byte = text[cursor] as number;
    if (byte === 0x2c || byte === 0x7d || byte === 0x5d) break; // , } ]
    cursor += 1;
  }
  return cursor;
}

/** 开引号之后那个未转义的闭引号下标；找不到是 −1。 */
function stringClose(text: Uint8Array, open: number): number {
  let cursor = open + 1;
  while (cursor < text.length) {
    const byte = text[cursor] as number;
    if (byte === 0x5c) {
      cursor += 2; // 反斜杠带走下一个字节——\" \\ 都不会被认成闭引号
      continue;
    }
    if (byte === 0x22) return cursor;
    cursor += 1;
  }
  return -1;
}

function isWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function hexDigit(nibble: number): number {
  return nibble < 10 ? 0x30 + nibble : 0x61 + (nibble - 10); // 0-9 a-f
}

/** 读四位十六进制；有非十六进制字符时是 −1。 */
function hexValue(text: Uint8Array, from: number): number {
  if (from + 4 > text.length) return -1;
  let value = 0;
  let offset = 0;
  while (offset < 4) {
    const byte = text[from + offset] as number;
    let digit = -1;
    if (byte >= 0x30 && byte <= 0x39) digit = byte - 0x30;
    else if (byte >= 0x61 && byte <= 0x66) digit = byte - 0x61 + 10;
    else if (byte >= 0x41 && byte <= 0x46) digit = byte - 0x41 + 10;
    if (digit < 0) return -1;
    value = value * 16 + digit;
    offset += 1;
  }
  return value;
}

/** 把一个码点编成 UTF-8 写进 out，交出新的写入位。 */
function putUtf8(out: Uint8Array, at: number, codePoint: number): number {
  if (codePoint < 0x80) {
    out[at] = codePoint;
    return at + 1;
  }
  if (codePoint < 0x800) {
    out[at] = 0xc0 | (codePoint >> 6);
    out[at + 1] = 0x80 | (codePoint & 0x3f);
    return at + 2;
  }
  if (codePoint < 0x10000) {
    out[at] = 0xe0 | (codePoint >> 12);
    out[at + 1] = 0x80 | ((codePoint >> 6) & 0x3f);
    out[at + 2] = 0x80 | (codePoint & 0x3f);
    return at + 3;
  }
  out[at] = 0xf0 | (codePoint >> 18);
  out[at + 1] = 0x80 | ((codePoint >> 12) & 0x3f);
  out[at + 2] = 0x80 | ((codePoint >> 6) & 0x3f);
  out[at + 3] = 0x80 | (codePoint & 0x3f);
  return at + 4;
}

/** 短转义两字节（\n 等），交出新的写入位。 */
function putShortEscape(out: Uint8Array, at: number, letter: number): number {
  out[at] = 0x5c;
  out[at + 1] = letter;
  return at + 2;
}

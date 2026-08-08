import { expect, test } from "bun:test";
import {
  bytesEqual,
  concatBytes,
  countStringArray,
  countStringFields,
  escapeJson,
  indexOfBytes,
  stringArrayField,
  stringFieldAt,
  unescapeJson,
} from "./wire_json.ts";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

test("concatBytes joins parts in order and handles empties", () => {
  expect(concatBytes([])).toEqual(new Uint8Array(0));
  expect(concatBytes([encode("ab"), encode(""), encode("cd")])).toEqual(encode("abcd"));
});

test("escapeJson passes plain bytes through and escapes the JSON specials", () => {
  expect(escapeJson(encode("plain"))).toEqual(encode("plain"));
  // 引号、反斜杠、常见控制字符都按 JSON 惯例转。
  expect(decode(escapeJson(encode('a"b\\c\nd\re\tf')))).toBe('a\\"b\\\\c\\nd\\re\\tf');
  expect(decode(escapeJson(encode("\b\f")))).toBe("\\b\\f");
  // 其余控制字符走 \u00XX；0x7f 不是控制字符（JSON 只要求 < 0x20）。
  expect(decode(escapeJson(new Uint8Array([0x01, 0x7f])))).toBe("\\u0001\x7f");
});

test("escapeJson leaves UTF-8 bytes untouched", () => {
  // 非 ASCII 字节都 ≥ 0x80，永远不会被误转——中文原样通过。
  const chinese = encode("章.md：原稿。");
  expect(escapeJson(chinese)).toEqual(chinese);
});

test("unescapeJson reverses every short escape and decodes \\u00XX", () => {
  expect(decode(unescapeJson(encode('a\\"b\\\\c\\nd\\re\\tf\\bg\\fh\\/i')))).toBe(
    'a"b\\c\nd\re\tf\bg\fh/i',
  );
  expect(unescapeJson(encode("\\u0001"))).toEqual(new Uint8Array([0x01]));
});

test("unescapeJson decodes BMP code points and surrogate pairs into UTF-8", () => {
  expect(decode(unescapeJson(encode("\\u4e2d\\u6587")))).toBe("中文");
  // 😀 = U+1F600，高代理 D83D + 低代理 DE00。
  expect(decode(unescapeJson(encode("\\ud83d\\ude00")))).toBe("😀");
});

test("unescapeJson keeps what it cannot read byte for byte", () => {
  // 不认得的序列与孤身的结尾反斜杠原样保留——不替他猜意思。
  expect(unescapeJson(encode("a\\qb"))).toEqual(encode("a\\qb"));
  expect(unescapeJson(encode("end\\"))).toEqual(encode("end\\"));
  // 孤身高代理按字面码点编成 UTF-8 三字节。
  expect(unescapeJson(encode("\\ud83d"))).toEqual(new Uint8Array([0xed, 0xa0, 0xbd]));
});

test("escape and unescape round-trip arbitrary author text", () => {
  const original = encode('他说：「带着"引号"与\\反斜杠」\n换行\t制表\u0007铃');
  expect(unescapeJson(escapeJson(original))).toEqual(original);
});

test("indexOfBytes finds from an offset and reports misses", () => {
  const text = encode("abab");
  expect(indexOfBytes(text, encode("ab"), 0)).toBe(0);
  expect(indexOfBytes(text, encode("ab"), 1)).toBe(2);
  expect(indexOfBytes(text, encode("zz"), 0)).toBe(-1);
  expect(indexOfBytes(encode(""), encode("x"), 0)).toBe(-1);
});

test("stringFieldAt reads the ordinal-th string value, escape-aware", () => {
  const json = encode('{"proposals":[{"id":"p1"},{"id":"p2"}],"staged":["p1"]}');
  const first = stringFieldAt(json, encode('"id":'), 0);
  expect(first.found).toBe(true);
  expect(decode(first.value)).toBe("p1");
  const second = stringFieldAt(json, encode('"id":'), 1);
  expect(second.found).toBe(true);
  expect(decode(second.value)).toBe("p2");
  // staged 数组是裸串，没有 `"id":` 模式，不会数出第三个。
  expect(stringFieldAt(json, encode('"id":'), 2).found).toBe(false);
  expect(countStringFields(json, encode('"id":'))).toBe(2);
});

test("string arrays are counted and joined for the Zig-side translation table", () => {
  const json = encode('{"staged":["a","b"],"recovery":["compare-with-frozen-text","send-again"]}');
  expect(countStringArray(json, encode('"staged"'))).toBe(2);
  expect(countStringArray(json, encode('"missing"'))).toBe(0);
  expect(decode(stringArrayField(json, encode('"recovery"')))).toBe(
    "compare-with-frozen-text\nsend-again",
  );
  expect(stringArrayField(json, encode('"missing"'))).toEqual(new Uint8Array(0));
});

test("bytesEqual compares byte for byte", () => {
  expect(bytesEqual(encode("proposals"), encode("proposals"))).toBe(true);
  expect(bytesEqual(encode("proposals"), encode("proposal"))).toBe(false);
  expect(bytesEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
});

test("stringFieldAt is not fooled by escaped lookalikes inside values", () => {
  // 正文里转义的 \\\"id\\\" 序列不含裸 `"id":` 子串——命中数仍是 1。
  const json = encode('[{"id":"real","beforeText":"他说\\"id\\": \\"x\\"。"}]');
  expect(countStringFields(json, encode('"id":'))).toBe(1);
  const field = stringFieldAt(json, encode('"beforeText":'), 0);
  expect(field.found).toBe(true);
  expect(decode(field.value)).toBe('他说"id": "x"。');
});

test("stringFieldAt treats JSON null and absence as not found", () => {
  const json = encode('{"afterText":null,"other":"x"}');
  expect(stringFieldAt(json, encode('"afterText":'), 0).found).toBe(false);
  expect(stringFieldAt(json, encode('"missing":'), 0).found).toBe(false);
  // null 之后的下一个字段仍按序数得到。
  const other = stringFieldAt(json, encode('"other":'), 0);
  expect(other.found).toBe(true);
  expect(decode(other.value)).toBe("x");
});

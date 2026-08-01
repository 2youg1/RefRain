/**
 * 裁决的规则。
 *
 * 这 200 行此前住在 `ReviewSurface.tsx` 里，零测试、零导出——没人能验证「哪些裁决
 * 算已决」或「合并单元的最终文本该写到哪一行」，而那正是作者的字会不会被写错的地方。
 *
 * 账本按 slice 记、进度按 unit 算（SPEC 9.7），这条不对称是全部复杂度的来源。
 */

import { describe, expect, test } from "bun:test";

import type { VerdictKindName, VerdictRecord } from "../src/generated/bindings.gen";
import {
  clamped,
  decidedCount,
  intentOf,
  type Ledger,
  restaged,
  standingOf,
  type Unit,
  verdictIdsOf,
  writesOf,
} from "../src/shell/review-verdicts";

const slice = (id: string, kind = "insert") => ({ id, kind }) as unknown as Unit["slices"][number];

const unit = (kind: Unit["kind"], ...sliceIds: string[]): Unit =>
  ({
    proposalId: "p1",
    proposalRun: "r1",
    before: "旧",
    after: "新",
    kind,
    // replace 单元：一片删除、一片插入，插入是改后接受的落点；
    // delete 单元全是删除片，没有可落文本的位置。
    slices: sliceIds.map((id, index) =>
      slice(id, kind === "delete" || (kind === "replace" && index === 0) ? "delete" : "insert"),
    ),
    competing: false,
  }) as Unit;

const ledgerOf = (entries: Record<string, string>): Ledger =>
  new Map(
    Object.entries(entries).map(([sliceId, verdictId]) => [
      sliceId,
      { id: verdictId } as unknown as VerdictRecord,
    ]),
  );

describe("一个单元什么时候算已决", () => {
  test("每一片都有账本行才算", () => {
    // 合并单元是作者眼里的一次判断，但账本仍按 slice 记。只写了一半就算已决，
    // 会让作者以为这一句处理完了，而另一片还悬着。
    const units = [unit("replace", "s1", "s2")];
    expect(decidedCount(units, ledgerOf({ s1: "v1" }))).toBe(0);
    expect(decidedCount(units, ledgerOf({ s1: "v1", s2: "v2" }))).toBe(1);
  });

  test("多个单元各算各的", () => {
    const units = [unit("replace", "s1"), unit("delete", "s2"), unit("insert", "s3")];
    expect(decidedCount(units, ledgerOf({ s1: "v1", s3: "v3" }))).toBe(2);
  });

  test("空账本一个都不算", () => {
    expect(decidedCount([unit("replace", "s1")], ledgerOf({}))).toBe(0);
  });
});

describe("已决、已入批、未决", () => {
  const merged = unit("replace", "s1", "s2");

  test("一片都没写就是未决", () => {
    expect(standingOf(merged, ledgerOf({}), new Set()).kind).toBe("undecided");
  });

  test("写了但没入批是已决", () => {
    const standing = standingOf(merged, ledgerOf({ s1: "v1", s2: "v2" }), new Set());
    expect(standing.kind).toBe("decided");
  });

  test("全部裁决都进了批次才算已入批", () => {
    const ledger = ledgerOf({ s1: "v1", s2: "v2" });
    // 只入了一半：仍是已决而非已入批，否则作者会以为提交时两片都会走。
    expect(standingOf(merged, ledger, new Set(["v1"])).kind).toBe("decided");
    expect(standingOf(merged, ledger, new Set(["v1", "v2"])).kind).toBe("staged");
  });

  test("没有当前单元时是未决", () => {
    expect(standingOf(null, ledgerOf({ s1: "v1" }), new Set(["v1"])).kind).toBe("undecided");
  });
});

describe("一次裁决写哪几行", () => {
  test("单片单元只写一行", () => {
    const writes = writesOf(unit("replace", "s1"), "accept", null);
    expect(writes).toEqual([{ sliceId: "s1", kind: "accept", finalText: null }]);
  });

  test("改后接受：最终文本只落在最后一片，另一片补一个普通接受", () => {
    // 这是账本 slice 粒度与作者 unit 粒度之间最容易写错的一处：把最终文本写到
    // 两片上会让同一段文字插入两次。
    const writes = writesOf(unit("replace", "s1", "s2"), "accept-modified", "改好的句子");
    expect(writes).toEqual([
      { sliceId: "s1", kind: "accept", finalText: null },
      { sliceId: "s2", kind: "accept-modified", finalText: "改好的句子" },
    ]);
  });

  test("非改后接受的裁决每片同样处理，且都不带文本", () => {
    const writes = writesOf(unit("replace", "s1", "s2"), "reject", null);
    expect(writes.every((write) => write.kind === "reject")).toBe(true);
    expect(writes.every((write) => write.finalText === null)).toBe(true);
  });

  test("纯删除单元不能改后接受——本地拒绝，不把文本写到删除行上", () => {
    expect(writesOf(unit("delete", "s1"), "accept-modified", "改好的句子")).toBeNull();
  });

  test("裁决种类原样传下去，不被改写", () => {
    for (const kind of ["accept", "reject"] as VerdictKindName[]) {
      expect(writesOf(unit("delete", "s1"), kind, null)[0]?.kind).toBe(kind);
    }
  });
});

describe("入批与出批", () => {
  test("全都不在批次里就整单元入批", () => {
    expect([...restaged(new Set(), ["v1", "v2"])]).toEqual(["v1", "v2"]);
  });

  test("全都在批次里就整单元出批", () => {
    expect([...restaged(new Set(["v1", "v2"]), ["v1", "v2"])]).toEqual([]);
  });

  test("只在一半——补齐而不是清空", () => {
    // 部分入批时作者的意图是「把这个单元加进去」，不是「把它拿出来」。
    expect([...restaged(new Set(["v1"]), ["v1", "v2"])].sort()).toEqual(["v1", "v2"]);
  });

  test("不碰别的单元已入批的裁决", () => {
    expect([...restaged(new Set(["other"]), ["v1"])].sort()).toEqual(["other", "v1"]);
  });
});

describe("账本行的编号", () => {
  test("只取写过的那几片", () => {
    expect(verdictIdsOf(unit("replace", "s1", "s2"), ledgerOf({ s1: "v1" }))).toEqual(["v1"]);
  });

  test("一片都没写就是空", () => {
    expect(verdictIdsOf(unit("replace", "s1"), ledgerOf({}))).toEqual([]);
  });
});

describe("光标不会越界", () => {
  test("夹在头尾之间", () => {
    expect(clamped(-3, 5)).toBe(0);
    expect(clamped(9, 5)).toBe(4);
    expect(clamped(2, 5)).toBe(2);
  });

  test("一个单元都没有时仍是 0，不是 -1", () => {
    // -1 会让 units()[cursor()] 取到 undefined，界面读作「没有当前单元」。
    expect(clamped(0, 0)).toBe(0);
    expect(clamped(3, 0)).toBe(0);
  });
});

describe("键盘意图", () => {
  const key = (init: Partial<KeyboardEvent>) => init as KeyboardEvent;
  const reading = { kind: "reading" } as const;

  test("读的时候 Alt+字母各有各的意图", () => {
    expect(intentOf(key({ key: "j", altKey: true }), reading)).toEqual({ kind: "move", delta: 1 });
    expect(intentOf(key({ key: "k", altKey: true }), reading)).toEqual({ kind: "move", delta: -1 });
    expect(intentOf(key({ key: "a", altKey: true }), reading)).toEqual({
      kind: "judge",
      verdict: "accept",
      finalText: null,
    });
  });

  test("不按 Alt 什么都不做——作者在读，不是在下令", () => {
    expect(intentOf(key({ key: "a", altKey: false }), reading).kind).toBe("none");
    expect(intentOf(key({ key: "Enter", altKey: false }), reading).kind).toBe("none");
  });

  test("大小写都认", () => {
    expect(intentOf(key({ key: "J", altKey: true }), reading)).toEqual({ kind: "move", delta: 1 });
  });

  test("编辑时 Alt+Enter 提交改写，Escape 收起", () => {
    const editing = { kind: "editing", text: "改好的" } as const;
    expect(intentOf(key({ key: "Enter", altKey: true }), editing)).toEqual({
      kind: "judge",
      verdict: "accept-modified",
      finalText: "改好的",
    });
    expect(intentOf(key({ key: "Escape" }), editing).kind).toBe("close-editor");
  });

  test("编辑时别的键交给输入框——否则作者打不出字", () => {
    const editing = { kind: "editing", text: "" } as const;
    expect(intentOf(key({ key: "a", altKey: true }), editing).kind).toBe("none");
    expect(intentOf(key({ key: "j", altKey: true }), editing).kind).toBe("none");
  });
});

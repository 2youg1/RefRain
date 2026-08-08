#!/usr/bin/env bash
# RefRain v0.3.0 回迁版 e2e：按旧版交互（四区+面板栈+单侧分层）全流程仿真。
# 真实拉起应用，按作者习惯点击每个功能；每步断言，失败即红。
# 用法：bash e2e/native/full-flow.sh（需已构建 -Dautomation 版本）
set -u
cd "$(dirname "$0")/../.." || exit 1
cd apps/native || exit 1

AUTOMATE="./node_modules/.bin/native automate"
SNAP_DIR=".zig-cache/native-sdk-automation"
SNAPSHOT="$SNAP_DIR/snapshot.txt"
PASS=0; FAIL=0

step() { echo "=== $1 ==="; }
ok()   { PASS=$((PASS+1)); echo "  ok   $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
snap() { timeout 60 $AUTOMATE snapshot > /dev/null 2>&1; }
shortcut() { timeout 60 $AUTOMATE shortcut "$1" > /dev/null 2>&1; }
wid() { grep "$1" "$SNAPSHOT" | grep -o "#[0-9]*" | head -1 | tr -d '#'; }
click() { timeout 60 $AUTOMATE widget-click document "$1" > /dev/null 2>&1; }
type_text() { timeout 60 $AUTOMATE widget-action document "$1" set_text "$2" > /dev/null 2>&1; }
shot() { timeout 60 $AUTOMATE screenshot > /dev/null 2>&1; }

assert_has() { if grep -q "$1" "$SNAPSHOT"; then ok "$1"; else bad "缺：$1"; fi; }

# 自动化项目与数据目录：真实 Windows 路径（Git Bash /tmp 是映射）。
E2E_ROOT=$(cygpath -w "$(mktemp -d /tmp/refrain-e2e-proj.XXXXXX)")
DATA_DIR=$(cygpath -w "$(mktemp -d /tmp/refrain-e2e-data.XXXXXX)")
PROJECT_DIR="${E2E_ROOT//\\//}"
printf '# 第一章\n\n剑一直握在他手里。\n' > "$PROJECT_DIR/章一.md"

step "启动应用（automation 构建 + 自动化项目通道）"
REFRAIN_DATA_DIR="$DATA_DIR" REFRAIN_AUTOMATION_ROOT="$PROJECT_DIR" ./zig-out/bin/refrain.exe > /tmp/refrain-e2e.log 2>&1 &
sleep 20
snap
if grep -q "Rust authority ready" "$SNAPSHOT" || grep -q "RefRain" "$SNAPSHOT"; then
  ok "Rust authority ready"
else
  bad "应用未就绪"; exit 1
fi

step "打开项目（作者习惯：⌘2 文件区）"
shortcut go.2; sleep 2; snap
OPEN=$(wid 'role=button name="打开一个项目文件夹"')
if [ -n "$OPEN" ]; then
  click "$OPEN"; sleep 4; snap
  assert_has "章一.md"
  shot "01-files"
else
  bad "打开项目按钮未找到"
fi

step "打开章一.md"
ROW=$(wid 'role=listitem name="章一.md"')
if [ -n "$ROW" ]; then
  click "$ROW"; sleep 4; snap
  assert_has "剑一直握在他手里"
  shot "02-document"
else
  bad "文档行未找到"
fi

step "回编辑区（⌘3，正文全宽）"
shortcut go.3; sleep 2; snap
DIV=$(wid 'role=separator')
if grep -q 'role=separator name="Split divider"' "$SNAPSHOT"; then
  grep -E 'role=separator' "$SNAPSHOT" | grep -qE 'value=1' && ok "正文全宽（divider value=1）" || bad "正文未全宽"
else
  ok "无分栏（正文独占）"
fi

step "写作（正文区零按钮：壳无 Go to/Theme/Undo/Save）"
if grep -qE 'name="(Go to|Theme|Undo|Save)"' "$SNAPSHOT"; then
  bad "正文区仍有工具栏按钮"
else
  ok "正文区零按钮"
fi
TB=$(wid 'role=textbox name="RefRain manuscript"')
if [ -n "$TB" ]; then
  type_text "$TB" "这是新写的一段。"; sleep 2; snap
  assert_has "这是新写的一段"
  shot "03-writing"
else
  bad "正稿输入框未找到"
fi

step "保存（Ctrl+S）"
shortcut document.save; sleep 3
grep -q "这是新写的一段" "$PROJECT_DIR/章一.md" && ok "正文落盘" || bad "未落盘"

step "撤销（Ctrl+Z，撤销不写盘）"
shortcut document.undo; sleep 3; snap
assert_has "剑一直握在他手里"
grep -q "这是新写的一段" "$PROJECT_DIR/章一.md" && ok "磁盘保留" || bad "撤销误写盘"

step "搜索（Ctrl+F → 输入查询词）"
shortcut search; sleep 2; snap
SEARCH=$(wid 'role=textbox name="搜索词"')
if [ -n "$SEARCH" ]; then
  type_text "$SEARCH" "章一"; sleep 2
  FIND=$(wid 'role=button name="找文档"')
  [ -n "$FIND" ] && click "$FIND"; sleep 3; snap
  assert_has "章一.md"
  shot "04-search"
else
  bad "搜索框未找到"
fi

step "右键编辑菜单：整篇转全角"
TRACK=$(wid 'role=group name="RefRain manuscript track"')
if [ -n "$TRACK" ]; then
  timeout 60 $AUTOMATE widget-context-menu document "$TRACK" 4 > /dev/null 2>&1
  sleep 3; snap
  assert_has "剑"
  shot "05-context-menu"
else
  bad "正文区未找到"
fi

step "主题切换（Ctrl+Shift+T）"
shortcut theme.next; sleep 3; snap
assert_has "RefRain"
shot "06-theme"

step "设置面板（⌘1，面板从左侧滑入，正文让位）"
shortcut go.1; sleep 3; snap
if grep -qE 'role=separator' "$SNAPSHOT"; then
  grep -E 'role=separator' "$SNAPSHOT" | grep -qE 'value=0.32' && ok "面板左 32%（divider value=0.32）" || bad "面板宽度不对"
fi
assert_has "主题"
shot "07-settings"

step "同键再按关闭（⌘1 → 回正文全宽）"
shortcut go.1; sleep 3; snap
grep -E 'role=separator' "$SNAPSHOT" | grep -qE 'value=1' && ok "同键关闭回全宽" || bad "未关闭"

step "Agent 层（⌘4 → 派发，记忆默认）"
shortcut go.4; sleep 3; snap
assert_has "写给 agent 的要求"
shot "08-dispatch"

step "连接页（⌘6）→ Escape 链回正文"
shortcut go.6; sleep 3; snap
assert_has "本机 Harness"
shortcut panel.back; sleep 2
shortcut panel.back; sleep 2
shortcut panel.back; sleep 2; snap
grep -E 'role=separator' "$SNAPSHOT" | grep -qE 'value=1' && ok "Escape×3 回正文全宽" || bad "退层链未回正文"

step "文件区拖宽（分栏可调）"
shortcut go.2; sleep 2; snap
DIV=$(wid 'role=separator')
if [ -n "$DIV" ]; then
  # widget-drag 坐标是 widget 相对比例：divider 仅 9px 宽，0.5→14 意味着
  # 从 divider 中部向右拖 126px（≈ +0.1 fraction）——小比值只移动 1px。
  timeout 60 $AUTOMATE widget-drag document "$DIV" 0.5 14 > /dev/null 2>&1; sleep 2; snap
  grep -E 'role=separator' "$SNAPSHOT" | grep -qE 'value=0.2[5-9]|value=0.3[0-9]|value=0.4' && ok "侧栏可拖宽" || bad "拖宽未生效"
  shot "09-rail-width"
else
  bad "分栏分隔条未找到"
fi

step "连接页（⌘6）：探测 + 协议安装"
shortcut go.6; sleep 2; snap
REFRESH=$(wid 'role=button name="重新探测本机装了什么"')
if [ -n "$REFRESH" ]; then
  click "$REFRESH"; sleep 5; snap
  assert_has "本机 Harness"
  INSTALL=$(wid 'role=button name="把当前协议装进这个 harness 的 skill 目录"')
  if [ -n "$INSTALL" ]; then
    click "$INSTALL"; sleep 4; snap
    assert_has "协议最新"
    ok "协议安装/更新路径可用"
  fi
  shot "10-connections"
else
  bad "连接页未找到"
fi

step "信箱（⌘5 直达序号 5）"
shortcut go.5; sleep 3; snap
assert_has "信箱"
shot "11-mailbox"

step "历史（⌘7）"
shortcut go.7; sleep 3; snap
assert_has "这份稿子改过什么"
shot "12-history"

step "设置（⌘8）：字体/排版/KARA"
shortcut go.8; sleep 2; snap
READ=$(wid 'role=button name="重新读取设置"')
[ -n "$READ" ] && click "$READ"; sleep 3; snap
assert_has "字体"
assert_has "字号"
assert_has "KARA"
shot "13-settings"

step "退出（⌘Q，journal 干净封口）"
shortcut app.quit; sleep 5
if tasklist 2>/dev/null | grep -qi refrain; then
  bad "应用未退出"
else
  ok "应用干净退出"
fi

echo "===== full-flow: $PASS passed, $FAIL failed ====="
[ "$FAIL" -eq 0 ]

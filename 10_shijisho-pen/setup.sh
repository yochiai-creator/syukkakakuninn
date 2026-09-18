#!/usr/bin/env bash
# 指図書書き込みアプリ GAS プロジェクトのセットアップ
#
# 使い方: このファイルがあるディレクトリ (10_shijisho-pen) の親で
#   bash 10_shijisho-pen/setup.sh
# を実行する。clasp のログイン (clasp login) は済ませておくこと。
set -euo pipefail

TITLE="指図書 書き込み"
DL="${DOWNLOADS_DIR:-$HOME/Downloads}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/src"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[33m[warn]\033[0m %s\n' "$1"; }
die()  { printf '\033[31m[error]\033[0m %s\n' "$1" >&2; exit 1; }

# ---- 事前チェック -------------------------------------------------
command -v clasp >/dev/null 2>&1 || die "clasp が見つかりません。 npm i -g @google/clasp"
[ -f "$HOME/.clasprc.json" ] || die "clasp が未ログインです。 clasp login を先に実行してください。"
[ -d "$DL" ] || die "$DL がありません。DOWNLOADS_DIR=... で場所を指定してください。"

# ---- 1. clasp create ---------------------------------------------
step "1. clasp create (--type webapp, rootDir ./src)"
mkdir -p "$SRC"
if [ -f "$HERE/.clasp.json" ]; then
  warn ".clasp.json が既にあります。作成済みとみなしてスキップします。"
  cat "$HERE/.clasp.json"
else
  ( cd "$HERE" && clasp create --type webapp --title "$TITLE" --rootDir ./src )
fi

# ---- 2. Downloads から src/ へコピー -------------------------------
step "2. ~/Downloads から src/ へコピー (Code.gs -> Code.js)"
copy_one() { # $1=元ファイル名 $2=コピー先ファイル名
  if [ -f "$DL/$1" ]; then
    cp "$DL/$1" "$SRC/$2"
    echo "  $1 -> src/$2"
  else
    warn "$DL/$1 が見つかりません（スキップ）"
  fi
}
copy_one "Code.gs"         "Code.js"
copy_one "Index.html"      "Index.html"
copy_one "appsscript.json" "appsscript.json"

# ---- 3. appsscript.json の確認 / 補正 -----------------------------
step "3. appsscript.json の確認 (webapp.access=DOMAIN / Drive v3)"
node - "$SRC/appsscript.json" <<'NODE'
const fs = require('fs');
const p = process.argv[2];
const m = JSON.parse(fs.readFileSync(p, 'utf8'));
let fixed = false;

// 既存 00_ai-clerk-core と揃える基本設定
if (m.timeZone !== 'Asia/Tokyo')        { m.timeZone = 'Asia/Tokyo'; fixed = true; }
if (m.runtimeVersion !== 'V8')          { m.runtimeVersion = 'V8'; fixed = true; }
if (m.exceptionLogging !== 'STACKDRIVER'){ m.exceptionLogging = 'STACKDRIVER'; fixed = true; }

// webapp.access = DOMAIN
m.webapp = m.webapp || {};
if (m.webapp.access !== 'DOMAIN') {
  console.log(`  webapp.access: ${m.webapp.access ?? '(未設定)'} -> DOMAIN`);
  m.webapp.access = 'DOMAIN'; fixed = true;
} else {
  console.log('  webapp.access = DOMAIN  OK');
}
if (!m.webapp.executeAs) { m.webapp.executeAs = 'USER_DEPLOYING'; fixed = true; }
console.log(`  webapp.executeAs = ${m.webapp.executeAs}`);

// dependencies に Drive v3
const deps = (m.dependencies = m.dependencies || {});
const svcs = (deps.enabledAdvancedServices = deps.enabledAdvancedServices || []);
const drive = svcs.find(s => s.serviceId === 'drive');
if (!drive) {
  console.log('  Drive v3: 未設定 -> 追加');
  svcs.push({ userSymbol: 'Drive', version: 'v3', serviceId: 'drive' });
  fixed = true;
} else if (drive.version !== 'v3') {
  console.log(`  Drive ${drive.version} -> v3`);
  drive.version = 'v3'; drive.userSymbol = drive.userSymbol || 'Drive'; fixed = true;
} else {
  console.log('  dependencies に Drive v3  OK');
}

if (fixed) {
  fs.writeFileSync(p, JSON.stringify(m, null, 2) + '\n');
  console.log('  -> appsscript.json を補正しました');
} else {
  console.log('  -> 補正不要');
}
NODE

# ---- 参考: 00_ai-clerk-core との構成差分 ---------------------------
CORE="$(dirname "$HERE")/00_ai-clerk-core"
if [ -d "$CORE" ]; then
  step "参考: 00_ai-clerk-core との構成比較"
  diff <(cd "$CORE" && ls -A) <(cd "$HERE" && ls -A) && echo "  トップレベル構成は一致" || true
  if [ -f "$CORE/.clasp.json" ]; then
    echo "  core rootDir: $(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).rootDir||"(未設定)")' "$CORE/.clasp.json")"
    echo "  this rootDir: $(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).rootDir||"(未設定)")' "$HERE/.clasp.json")"
  fi
else
  warn "00_ai-clerk-core が $CORE に見つからないため構成比較はスキップ"
fi

# ---- 4. push して open -------------------------------------------
step "4. clasp push"
( cd "$HERE" && clasp push --force )

step "clasp open"
( cd "$HERE" && clasp open )

printf '\n\033[32m完了\033[0m: %s\n' "$SRC"

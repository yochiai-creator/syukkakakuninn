#!/usr/bin/env bash
# 指図書 書き込み — 状態ダッシュボード兼オールインワン実行
#
#   bash dash.sh        状態を一覧表示（何も変更しない）
#   bash dash.sh run    足りないものを全部やる（refspec修復 → create → copy → 検査 → push → open）
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJ="$ROOT/10_shijisho-pen"
SRC="$PROJ/src"
DL="${DOWNLOADS_DIR:-$HOME/Downloads}"

B=$'\033[1m'; R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; D=$'\033[2m'; N=$'\033[0m'
OK="${G}✓${N}"; NG="${R}✗${N}"; WN="${Y}!${N}"; SK="${D}–${N}"

TODO=()
todo() { TODO+=("$1"); }

# 表示幅（全角=2）。ロケールに依存しないよう UTF-8 継続バイトを除いて文字数を数える
dispw() { local s="$1" b c
  b=$(printf '%s' "$s" | wc -c)
  c=$(printf '%s' "$s" | LC_ALL=C tr -d '\200-\277' | wc -c)
  echo $(( c + (b - c) / 2 )); }
pad() { local n; n=$(( $2 - $(dispw "$1") )); [ "$n" -lt 0 ] && n=0
  printf '%s%*s' "$1" "$n" ''; }
row()  { printf '  %b  %s %s\n' "$1" "$(pad "$2" 22)" "$3"; }
head_() { printf '\n%b%s%b\n' "$B" "$1" "$N"; }

# ── 環境 ──────────────────────────────────────────────
head_ "環境"
if command -v node >/dev/null 2>&1; then row "$OK" "node" "$(node --version)"
else row "$NG" "node" "未インストール"; todo "node を入れる (brew install node)"; fi

if command -v clasp >/dev/null 2>&1; then row "$OK" "clasp" "$(clasp --version 2>/dev/null | head -1)"
else row "$NG" "clasp" "未インストール"; todo "npm i -g @google/clasp"; fi

if [ -f "$HOME/.clasprc.json" ]; then row "$OK" "clasp ログイン" "~/.clasprc.json あり"
else row "$NG" "clasp ログイン" "未ログイン"; todo "clasp login"; fi

if [ -d "$DL" ]; then row "$OK" "Downloads" "$DL"
else row "$WN" "Downloads" "$DL が無い"; todo "DOWNLOADS_DIR=... を指定するか3ファイルを置く"; fi

# ── リポジトリ ────────────────────────────────────────
head_ "リポジトリ  $(basename "$ROOT")"
BR="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null)"
row "$OK" "ブランチ" "${BR:-?}"

NFETCH="$(git -C "$ROOT" config --get-all remote.origin.fetch 2>/dev/null | grep -c . )"
case "$NFETCH" in
  1) row "$OK" "fetch refspec" "正常" ;;
  0) row "$NG" "fetch refspec" "未設定（空リポジトリ clone の影響）"
     todo "refspec 修復（dash.sh run で自動）" ;;
  *) row "$NG" "fetch refspec" "${NFETCH}件 重複"
     todo "refspec 重複解消（dash.sh run で自動）" ;;
esac

DIRTY="$(git -C "$ROOT" status --porcelain 2>/dev/null | grep -c .)"
if [ "$DIRTY" -eq 0 ]; then row "$OK" "未コミット変更" "なし"
else row "$WN" "未コミット変更" "${DIRTY} 件"; fi

if git -C "$ROOT" rev-parse --verify -q "origin/$BR" >/dev/null 2>&1; then
  AB="$(git -C "$ROOT" rev-list --left-right --count "origin/$BR...HEAD" 2>/dev/null)"
  BEHIND="${AB%%	*}"; AHEAD="${AB##*	}"
  if [ "${AHEAD:-0}" = 0 ] && [ "${BEHIND:-0}" = 0 ]; then row "$OK" "origin との差" "同期済み"
  else row "$WN" "origin との差" "ahead ${AHEAD} / behind ${BEHIND}"; fi
else
  row "$WN" "origin との差" "追跡ブランチなし"
fi

# ── GAS プロジェクト ──────────────────────────────────
head_ "GAS プロジェクト  10_shijisho-pen"
if [ -f "$PROJ/.clasp.json" ] && command -v node >/dev/null 2>&1; then
  SID="$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).scriptId||"")}catch(e){}' "$PROJ/.clasp.json")"
  RD="$(node  -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).rootDir||"(未設定)")}catch(e){}' "$PROJ/.clasp.json")"
  row "$OK" "clasp プロジェクト" "${SID:0:24}…  rootDir=${RD}"
else
  row "$NG" "clasp プロジェクト" "未作成（.clasp.json なし）"
  todo "clasp create --type webapp --title \"指図書 書き込み\" --rootDir ./src"
fi

for f in Code.js Index.html; do
  if [ -f "$SRC/$f" ]; then row "$OK" "src/$f" "$(wc -l <"$SRC/$f" | tr -d ' ') 行"
  else
    row "$NG" "src/$f" "未配置"
    [ "$f" = Code.js ] && todo "$DL/Code.gs → src/Code.js" || todo "$DL/$f → src/$f"
  fi
done

if [ -f "$SRC/appsscript.json" ] && command -v node >/dev/null 2>&1; then
  node - "$SRC/appsscript.json" <<'NODE'
const fs=require('fs');
const N='\x1b[0m',G='\x1b[32m',R='\x1b[31m';
const ok=`  ${G}✓${N}  `, ng=`  ${R}✗${N}  `;
// 全角文字を 2 桁として 22 桁に揃える
const w=s=>[...s].reduce((n,c)=>n+(c.codePointAt(0)>0x2500?2:1),0);
const L=s=>s+' '.repeat(Math.max(0,22-w(s)))+' ';
let m; try{ m=JSON.parse(fs.readFileSync(process.argv[2],'utf8')); }
catch(e){ console.log(ng+L('appsscript.json')+'JSON 壊れ: '+e.message); process.exit(3); }
const acc=m.webapp&&m.webapp.access;
const drv=(m.dependencies&&m.dependencies.enabledAdvancedServices||[]).find(s=>s.serviceId==='drive');
let bad=0;
if(acc==='DOMAIN') console.log(ok+L('webapp.access')+'DOMAIN');
else { console.log(ng+L('webapp.access')+(acc||'未設定')+' → DOMAIN 要修正'); bad=1; }
console.log(ok+L('webapp.executeAs')+((m.webapp&&m.webapp.executeAs)||'未設定'));
if(drv&&drv.version==='v3') console.log(ok+L('Drive 拡張サービス')+'v3');
else { console.log(ng+L('Drive 拡張サービス')+(drv?drv.version:'未設定')+' → v3 要修正'); bad=1; }
console.log(ok+L('timeZone / runtime')+`${m.timeZone||'?'} / ${m.runtimeVersion||'?'}`);
process.exit(bad?4:0);
NODE
  [ $? -ne 0 ] && todo "appsscript.json を DOMAIN / Drive v3 に補正（dash.sh run で自動）"
else
  row "$NG" "appsscript.json" "なし"; todo "appsscript.json を用意"
fi

# ── 次にやること ──────────────────────────────────────
head_ "次にやること"
if [ ${#TODO[@]} -eq 0 ]; then
  printf '  %b すべて完了。%b push 済みか確認するなら: %bcd %s && clasp push%b\n' "$G" "$N" "$D" "$PROJ" "$N"
else
  i=0; for t in "${TODO[@]}"; do i=$((i+1)); printf '  %d. %s\n' "$i" "$t"; done
  printf '\n  %bbash %s run%b で自動実行できるもの: refspec修復 / create / copy / 補正 / push / open\n' "$B" "${BASH_SOURCE[0]##*/}" "$N"
  printf '  %b(node・clasp の導入と clasp login だけは手動)%b\n' "$D" "$N"
fi
echo

# ── run ───────────────────────────────────────────────
if [ "${1:-}" = run ]; then
  head_ "=== 実行 ==="
  case "$NFETCH" in
    0) git -C "$ROOT" config --add remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
       echo "  refspec を設定"; git -C "$ROOT" fetch origin -q && echo "  fetch OK" ;;
    1) : ;;
    *) git -C "$ROOT" config --unset-all remote.origin.fetch
       git -C "$ROOT" config --add remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
       echo "  refspec の重複を解消"; git -C "$ROOT" fetch origin -q && echo "  fetch OK" ;;
  esac
  exec bash "$PROJ/setup.sh"
fi

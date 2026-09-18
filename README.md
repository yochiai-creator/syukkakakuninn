# syukkakakuninn

指図書 書き込み（Google Apps Script Web アプリ）のリポジトリ。

## 使い方 — コマンドは1つだけ

```bash
bash dash.sh        # 状態を一覧表示（何も変更しない）
bash dash.sh run    # 足りないものを全部やる
```

`dash.sh` が環境・リポジトリ・GAS プロジェクトの状態を一枚で表示し、
最後に「次にやること」を並べる。`run` を付けると、そのうち自動化できるものを
まとめて実行する。

| 項目 | `run` で自動 |
|---|---|
| fetch refspec の未設定 / 重複の修復 | ○ |
| `clasp create --type webapp --title "指図書 書き込み" --rootDir ./src` | ○ |
| `~/Downloads` から `src/` へコピー（`Code.gs` → `Code.js`） | ○ |
| `appsscript.json` の `webapp.access=DOMAIN` / Drive v3 の確認と補正 | ○ |
| `clasp push` → `clasp open` | ○ |
| node / clasp の導入、`clasp login` | ✗ 手動 |

`~/Downloads` 以外に3ファイルがある場合は場所を指定する。

```bash
DOWNLOADS_DIR=/path/to/dir bash dash.sh run
```

## 構成

```
dash.sh                 # 状態表示 + オールインワン実行（入口はここだけ）
10_shijisho-pen/
├── setup.sh            # dash.sh run から呼ばれる実処理
├── README.md
└── src/                # clasp rootDir
    └── appsscript.json # webapp access=DOMAIN + Drive v3 + Asia/Tokyo + V8
```

`00_ai-clerk-core` と同じ、プロジェクトごとに番号付きフォルダを切り
`src/` を clasp の `rootDir` にする構成に揃えている。

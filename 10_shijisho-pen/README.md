# 10_shijisho-pen — 指図書 書き込み (GAS Web アプリ)

`00_ai-clerk-core` と同じ構成（`rootDir = ./src`、ソースは `src/` 配下、
`appsscript.json` は Asia/Tokyo / V8 / STACKDRIVER / Drive v3）に揃えたプロジェクト。

## セットアップ

`clasp create` は Google アカウントの認証が必要なため、ローカル環境で実行する。

```bash
npm i -g @google/clasp   # 未導入なら
clasp login              # 未ログインなら
bash 10_shijisho-pen/setup.sh
```

`setup.sh` が以下を順に実行する。

1. `clasp create --type webapp --title "指図書 書き込み" --rootDir ./src`
   （`.clasp.json` が既にあればスキップ）
2. `~/Downloads` の `Code.gs` / `Index.html` / `appsscript.json` を `src/` へコピー。
   `Code.gs` は `Code.js` にリネーム。
   Downloads が別の場所なら `DOWNLOADS_DIR=/path/to/dir bash 10_shijisho-pen/setup.sh`
3. `src/appsscript.json` を検査し、`webapp.access = DOMAIN` と
   `dependencies` の Drive v3 を確認。不足していれば補正して内容を表示する。
4. `clasp push --force` → `clasp open`

## ファイル構成

```
10_shijisho-pen/
├── .clasp.json        # 手順1で生成（scriptId と rootDir）
├── setup.sh
├── README.md
└── src/
    ├── appsscript.json   # webapp/DOMAIN + Drive v3 のひな形（手順2で Downloads 版に差し替え）
    ├── Code.js           # 手順2で配置
    └── Index.html        # 手順2で配置
```

`src/appsscript.json` はひな形として先に置いてある。`~/Downloads` に
`appsscript.json` が無い場合はこれがそのまま使われる。

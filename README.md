# syukkakakuninn

指図書 書き込み（Google Apps Script Web アプリ）のリポジトリ。

## 構成

```
10_shijisho-pen/        # 指図書 書き込み
├── setup.sh            # clasp create / コピー / manifest 検査 / push+open
├── README.md
├── .gitignore
└── src/                # clasp rootDir
    └── appsscript.json # webapp access=DOMAIN + Drive v3 + Asia/Tokyo / V8
```

`00_ai-clerk-core` と同じ、プロジェクトごとに番号付きフォルダを切り
`src/` を clasp の `rootDir` にする構成に揃えている。

セットアップ手順は [`10_shijisho-pen/README.md`](10_shijisho-pen/README.md) を参照。

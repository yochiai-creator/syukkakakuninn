/**
 * 指図書 書き込みアプリ — サーバー側
 *
 * 共有ドライブ内のPDFを開き、Apple Pencilで書き込んだ結果を
 * 上書き保存 / 別名保存する。
 *
 * 対象フォルダはサブフォルダを持てる。たとえば
 *   ◆容器種類別/
 *   ├── 30Ｋ/            … PDFが直接入っている
 *   └── 小型容器/
 *       ├── 10Ｋ/        … さらに1階層深い
 *       └── ２Ｋ/
 * のように深さがまちまちでも、たどって開ける。
 *
 * 必要な設定:
 *   1. サービス → Drive API (v3) を「Drive」という識別子で追加
 *   2. 下の DEFAULT_FOLDER_ID を対象フォルダに変更(アプリ内からも変更可)
 *   3. デプロイ → 新しいデプロイ → ウェブアプリ
 *      実行ユーザー: 自分 / アクセス: 組織内の全員
 */

// 出荷作業指図書が入っているルートフォルダ(◆容器種類別)
var DEFAULT_FOLDER_ID = '1qCpeKIO3gvPWkVDqXApVREDEiWKU_3D6';

// チェック完了PDFの保存先ルート(◆チェック完了)。
// この下に <年>年/<月>月 を作って振り分ける。
var DONE_FOLDER_ID = '1fbx7-m2RHcFSA66I7b0nk8UmjBJ8BlPE';

// サブフォルダ対応にあたりキー名を変えている。
// 以前の TARGET_FOLDER_ID に残っていた値は参照されなくなる。
var PROP_FOLDER = 'ROOT_FOLDER_ID';

var FOLDER_MIME = 'application/vnd.google-apps.folder';
var PDF_MIME    = 'application/pdf';

// 探索の上限(暴走防止)
var MAX_FOLDERS    = 300;  // 検索で下る最大フォルダ数
var MAX_HITS       = 200;  // 検索結果の最大件数
var MAX_LIST_PAGES = 10;   // 1フォルダあたりの最大ページ数
var MAX_DEPTH      = 10;   // パンくずをたどる最大段数

// 上書き・別名で保存したファイルに付ける目印(Drive のファイルのプロパティ)。
// チェック完了すると元ファイルはゴミ箱へ行くので、目印が付いていて
// ゴミ箱に無いものが「途中まで書いてまだチェック完了していない」もの。
// 振り分け(Sort.js)も、前から上書きしてあったコピーにこの目印を付ける。
var SAVED_PROP    = 'shijishoPen';
var SAVED_VALUE   = 'saved';
var SAVED_AT_PROP = 'shijishoPenAt';

function savedProps_(when) {
  var p = {};
  p[SAVED_PROP] = SAVED_VALUE;
  p[SAVED_AT_PROP] = (when || new Date()).toISOString();
  return p;
}

function isSaved_(f) {
  return !!(f.properties && f.properties[SAVED_PROP] === SAVED_VALUE);
}

/** 一覧に返す1ファイルぶん。途中保存かどうかも付ける。 */
function fileInfo_(f) {
  return {
    id: f.id,
    name: f.name,
    size: Number(f.size || 0),
    modified: f.modifiedTime,
    saved: isSaved_(f),
    savedAt: isSaved_(f) ? (f.properties[SAVED_AT_PROP] || f.modifiedTime) : ''
  };
}

var FILE_FIELDS = 'id,name,size,modifiedTime,mimeType,properties,parents';

/** 途中保存(上書き済みでチェック未完了)のファイルを探す条件 */
function savedQuery_() {
  return "properties has { key='" + SAVED_PROP + "' and value='" + SAVED_VALUE + "' }" +
         " and mimeType = '" + PDF_MIME + "' and trashed = false";
}


function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('指図書 書き込み')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}


/* ---------------- 設定 ---------------- */

function getFolderId_() {
  var p = PropertiesService.getScriptProperties().getProperty(PROP_FOLDER);
  return p || DEFAULT_FOLDER_ID;
}

/** Driveのクエリ文字列に値を埋めるためのエスケープ。 */
function q_(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function setFolderId(folderId) {
  folderId = String(folderId || '').trim();

  // URLを貼られても拾えるようにする
  var m = folderId.match(/[-\w]{25,}/);
  if (m) folderId = m[0];
  if (!folderId) throw new Error('フォルダIDが空です');

  // 存在確認(ここで失敗すれば設定は変えない)
  Drive.Files.get(folderId, { supportsAllDrives: true, fields: 'id,name' });

  PropertiesService.getScriptProperties().setProperty(PROP_FOLDER, folderId);
  return getFolderInfo();
}

function getFolderInfo() {
  var id = getFolderId_();
  var f = Drive.Files.get(id, { supportsAllDrives: true, fields: 'id,name' });
  return { id: f.id, name: f.name };
}


/* ---------------- 一覧(1階層ぶん) ---------------- */

/**
 * フォルダの中身を返す。サブフォルダとPDFを分けて返し、
 * ルートまでのパンくずも添える。
 * @param {string} folderId 省略時はルートフォルダ
 */
function listFolder(folderId) {
  var root = getFolderId_();
  var id = String(folderId || '').trim() || root;

  var meta = Drive.Files.get(id, {
    supportsAllDrives: true,
    fields: 'id,name,parents,mimeType'
  });
  if (meta.mimeType !== FOLDER_MIME) throw new Error('フォルダではありません: ' + meta.name);

  var folders = [], files = [];
  var token = null, pages = 0;

  do {
    var res = Drive.Files.list({
      q: "'" + q_(id) + "' in parents and trashed = false" +
         " and (mimeType = '" + FOLDER_MIME + "' or mimeType = '" + PDF_MIME + "')",
      orderBy: 'folder,modifiedTime desc',
      pageSize: 200,
      pageToken: token || undefined,
      fields: 'nextPageToken,files(' + FILE_FIELDS + ')',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });

    (res.files || []).forEach(function (f) {
      if (f.mimeType === FOLDER_MIME) {
        folders.push({ id: f.id, name: f.name });
      } else {
        files.push(fileInfo_(f));
      }
    });

    token = res.nextPageToken;
  } while (token && ++pages < MAX_LIST_PAGES);

  return {
    id: meta.id,
    name: meta.name,
    isRoot: id === root,
    breadcrumb: breadcrumb_(meta, root),
    folders: folders,
    files: files,
    savedCount: countSaved_()
  };
}

/** 途中保存のファイルが全部で何件あるか。一覧の一番上に出す。 */
function countSaved_() {
  try {
    var res = Drive.Files.list({
      q: savedQuery_(),
      pageSize: 200,
      fields: 'files(id)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: 'allDrives'
    });
    return (res.files || []).length;
  } catch (e) {
    return 0;          // 数えられなくても一覧は出す
  }
}

/**
 * 途中保存のファイルを全部返す。どのフォルダにあるかも付ける。
 * 出荷日を過ぎて '004_要確認 へ移ったものも含む(見落としやすいので)。
 */
function listSavedPdfs() {
  var out = [], token = null, pages = 0, folderName = {};

  do {
    var res = Drive.Files.list({
      q: savedQuery_(),
      orderBy: 'modifiedTime desc',
      pageSize: 200,
      pageToken: token || undefined,
      fields: 'nextPageToken,files(' + FILE_FIELDS + ')',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: 'allDrives'
    });

    (res.files || []).forEach(function (f) {
      var info = fileInfo_(f);
      var pid = (f.parents || [])[0];
      if (pid) {
        if (!(pid in folderName)) {
          try {
            folderName[pid] = Drive.Files.get(pid, { supportsAllDrives: true, fields: 'name' }).name;
          } catch (e) { folderName[pid] = ''; }
        }
        info.folder = folderName[pid];
      }
      out.push(info);
    });

    token = res.nextPageToken;
  } while (token && ++pages < MAX_LIST_PAGES);

  return out;
}

/** ルートフォルダまで親をたどる。ルート外にいる場合は現在地だけ返す。 */
function breadcrumb_(meta, root) {
  var crumb = [{ id: meta.id, name: meta.name }];
  var cur = meta, depth = 0;

  while (cur.id !== root && depth++ < MAX_DEPTH) {
    var pid = (cur.parents || [])[0];
    if (!pid) break;
    try {
      cur = Drive.Files.get(pid, { supportsAllDrives: true, fields: 'id,name,parents' });
    } catch (e) {
      break; // 共有ドライブの上限などで親を取れない場合はそこで打ち切る
    }
    crumb.unshift({ id: cur.id, name: cur.name });
    if (cur.id === root) break;
  }
  return crumb;
}

/** 後方互換: ルート直下のPDFだけを返す。 */
function listPdfs() {
  return listFolder('').files;
}


/* ---------------- 検索(サブフォルダ横断) ---------------- */

/**
 * ルートフォルダ配下をすべて辿ってファイル名で検索する。
 * @param {string} keyword
 */
function searchPdfs(keyword) {
  keyword = String(keyword || '').trim();
  if (!keyword) return [];

  var root = getFolderId_();
  var ids = collectFolderIds_(root);

  var out = [], seen = {};

  for (var i = 0; i < ids.length && out.length < MAX_HITS; i += 20) {
    var parents = ids.slice(i, i + 20).map(function (p) {
      return "'" + q_(p) + "' in parents";
    }).join(' or ');

    var res = Drive.Files.list({
      q: '(' + parents + ") and mimeType = '" + PDF_MIME + "' and trashed = false" +
         " and name contains '" + q_(keyword) + "'",
      orderBy: 'modifiedTime desc',
      pageSize: 100,
      fields: 'files(' + FILE_FIELDS + ')',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });

    (res.files || []).forEach(function (f) {
      if (seen[f.id]) return;
      seen[f.id] = true;
      out.push(fileInfo_(f));
    });
  }

  out.sort(function (a, b) { return a.modified < b.modified ? 1 : -1; });
  return out.slice(0, MAX_HITS);
}

/** ルートとその配下のフォルダIDを幅優先で集める。 */
function collectFolderIds_(root) {
  var ids = [root], queue = [root];

  while (queue.length && ids.length < MAX_FOLDERS) {
    var parents = queue.splice(0, 20).map(function (p) {
      return "'" + q_(p) + "' in parents";
    }).join(' or ');

    var res = Drive.Files.list({
      q: '(' + parents + ") and mimeType = '" + FOLDER_MIME + "' and trashed = false",
      pageSize: 200,
      fields: 'files(id)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });

    (res.files || []).forEach(function (f) {
      if (ids.length >= MAX_FOLDERS) return;
      ids.push(f.id);
      queue.push(f.id);
    });
  }
  return ids;
}


/* ---------------- 読み込み ---------------- */

function loadPdf(fileId) {
  // Drive高度サービスのfields指定は使わない。
  // DriveApp だけで名前・種類・中身が取れるうえ、
  // フィールド選択の食い違いで失敗する余地が無い。
  var file = DriveApp.getFileById(fileId);
  if (file.getMimeType() !== PDF_MIME) {
    throw new Error('PDFではありません: ' + file.getName());
  }
  return {
    id: fileId,
    name: file.getName(),
    data: Utilities.base64Encode(file.getBlob().getBytes())
  };
}


/* ---------------- 保存 ---------------- */

/**
 * 書き込み済みPDFを保存する。
 * @param {Object} req
 *   req.fileId   元ファイルのID
 *   req.data     base64のPDF
 *   req.mode     'overwrite' | 'copy' | 'done'
 * @return {Object} 保存結果
 */
function savePdf(req) {
  var bytes = Utilities.base64Decode(req.data);
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    var original = Drive.Files.get(req.fileId, {
      supportsAllDrives: true,
      fields: 'id,name,parents'
    });

    var blob = Utilities.newBlob(bytes, PDF_MIME, original.name);

    if (req.mode === 'overwrite') {
      var updated = Drive.Files.update({ properties: savedProps_() }, req.fileId, blob,
                                       { supportsAllDrives: true });
      return {
        id: updated.id,
        name: original.name,
        url: fileUrl_(updated.id),
        mode: 'overwrite'
      };
    }

    if (req.mode === 'done') return saveDone_(req.fileId, original, blob);

    var srcParent = (original.parents || [])[0];
    var newName = original.name.replace(/\.pdf$/i, '') + '_書込.pdf';
    if (srcParent) newName = uniqueName_(srcParent, newName);
    blob.setName(newName);

    var created = Drive.Files.create(
      { name: newName, parents: original.parents, properties: savedProps_() },
      blob,
      { supportsAllDrives: true }
    );

    return {
      id: created.id,
      name: newName,
      url: fileUrl_(created.id),
      mode: 'copy'
    };

  } finally {
    lock.releaseLock();
  }
}

/**
 * チェック完了として保存する。
 * ◆チェック完了/<今年>年/<今月>月 に書き込み済みPDFを作り、
 * それが確実に出来てから元ファイルをゴミ箱へ移す。
 * コピーに失敗した場合、元ファイルには一切触れない。
 */
function saveDone_(fileId, original, blob) {
  var now = new Date();
  var tz = Session.getScriptTimeZone() || 'Asia/Tokyo';
  var year  = Utilities.formatDate(now, tz, 'yyyy') + '年';
  var month = Number(Utilities.formatDate(now, tz, 'M')) + '月';

  var yearFolder  = childFolder_(DONE_FOLDER_ID, year);
  var monthFolder = childFolder_(yearFolder, month);

  var name = uniqueName_(monthFolder, original.name);
  blob.setName(name);

  var created = Drive.Files.create(
    { name: name, parents: [monthFolder] },
    blob,
    { supportsAllDrives: true }
  );
  if (!created || !created.id) throw new Error('チェック完了フォルダへ保存できませんでした');

  // ここまで来て初めて元ファイルを片付ける。
  // 完全削除ではなくゴミ箱なので、30日間は Drive から戻せる。
  DriveApp.getFileById(fileId).setTrashed(true);

  return {
    id: created.id,
    name: name,
    url: fileUrl_(created.id),
    mode: 'done',
    folder: year + '/' + month,
    trashed: original.name
  };
}

/** 親フォルダ直下の同名フォルダを返す。無ければ作る。 */
function childFolder_(parentId, name) {
  var parent = DriveApp.getFolderById(parentId);
  var it = parent.getFoldersByName(name);
  if (it.hasNext()) return it.next().getId();
  return parent.createFolder(name).getId();
}

/** 同名ファイルがあれば _2, _3 … を付けて重複を避ける。 */
function uniqueName_(parentId, name) {
  var parent = DriveApp.getFolderById(parentId);
  var base = name.replace(/\.pdf$/i, '');
  var candidate = name;

  for (var n = 2; n < 50; n++) {
    if (!parent.getFilesByName(candidate).hasNext()) return candidate;
    candidate = base + '_' + n + '.pdf';
  }
  return candidate;
}

function fileUrl_(id) {
  return 'https://drive.google.com/file/d/' + id + '/view';
}

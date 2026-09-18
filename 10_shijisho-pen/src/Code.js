/**
 * 指図書 書き込みアプリ — サーバー側
 *
 * 共有ドライブ内のPDFを開き、Apple Pencilで書き込んだ結果を
 * 上書き保存 / 別名保存する。
 *
 * 必要な設定:
 *   1. サービス → Drive API (v3) を「Drive」という識別子で追加
 *   2. 下の DEFAULT_FOLDER_ID を対象フォルダに変更(アプリ内からも変更可)
 *   3. デプロイ → 新しいデプロイ → ウェブアプリ
 *      実行ユーザー: 自分 / アクセス: 組織内の全員
 */

// 出荷作業指図書が入っているフォルダ
var DEFAULT_FOLDER_ID = '1d3SMlkQKuTEP-FmQB5zl9wTtKeXGGpN6';

var PROP_FOLDER = 'TARGET_FOLDER_ID';


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


/* ---------------- 一覧 ---------------- */

/**
 * 対象フォルダ内のPDFを新しい順に返す。
 * @param {string} keyword ファイル名の絞り込み(省略可)
 */
function listPdfs(keyword) {
  var folderId = getFolderId_();
  var q = "'" + folderId + "' in parents and mimeType = 'application/pdf' and trashed = false";

  if (keyword) {
    var safe = String(keyword).replace(/'/g, "\\'");
    q += " and name contains '" + safe + "'";
  }

  var res = Drive.Files.list({
    q: q,
    orderBy: 'modifiedTime desc',
    pageSize: 100,
    fields: 'files(id,name,size,modifiedTime)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  });

  return (res.files || []).map(function (f) {
    return {
      id: f.id,
      name: f.name,
      size: Number(f.size || 0),
      modified: f.modifiedTime
    };
  });
}


/* ---------------- 読み込み ---------------- */

function loadPdf(fileId) {
  var file = DriveApp.getFileById(fileId);
  var blob = file.getBlob();
  return {
    id: fileId,
    name: file.getName(),
    data: Utilities.base64Encode(blob.getBytes())
  };
}


/* ---------------- 保存 ---------------- */

/**
 * 書き込み済みPDFを保存する。
 * @param {Object} req
 *   req.fileId   元ファイルのID
 *   req.data     base64のPDF
 *   req.mode     'overwrite' | 'copy'
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

    var blob = Utilities.newBlob(bytes, 'application/pdf', original.name);

    if (req.mode === 'overwrite') {
      var updated = Drive.Files.update({}, req.fileId, blob, { supportsAllDrives: true });
      return {
        id: updated.id,
        name: original.name,
        url: 'https://drive.google.com/file/d/' + updated.id + '/view',
        mode: 'overwrite'
      };
    }

    var newName = original.name.replace(/\.pdf$/i, '') + '_書込.pdf';
    blob.setName(newName);

    var created = Drive.Files.create(
      { name: newName, parents: original.parents },
      blob,
      { supportsAllDrives: true }
    );

    return {
      id: created.id,
      name: newName,
      url: 'https://drive.google.com/file/d/' + created.id + '/view',
      mode: 'copy'
    };

  } finally {
    lock.releaseLock();
  }
}

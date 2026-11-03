'use strict';
/**
 * 关系层：她跟「谁」是什么关系，说话该用什么态度。
 *
 * 存的不是「知识」而是「相处方式」：
 *   { "1000000001": { name: "主人", relation: "主人", tone: "欠揍但听话", notes: ["不喜欢被叫全名", "爱吃辣"] } }
 *
 * 用法：写进 data/relationships.json，也可以让她自己在聊天里学（说「记住 X 是我室友」）。
 * 提示词里只拼「当前这个人」的那一条，不整表塞进去，省 token。
 */
const fs = require('fs');
const path = require('path');

const DEFAULTS_RELATION = '群友';

function normalizeKey(k) {
  return String(k || '').trim();
}

function createRelationshipStore({ file, log = null } = {}) {
  const filePath = file || path.join(process.cwd(), 'data', 'relationships.json');
  let data = {};

  function load() {
    try {
      if (fs.existsSync(filePath)) {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        data = raw && typeof raw === 'object' ? raw : {};
      } else {
        data = {};
        save();
      }
    } catch (e) {
      log?.warn?.(`关系表读取失败（用空表）: ${e.message}`);
      data = {};
    }
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    } catch (e) {
      log?.warn?.(`关系表写入失败: ${e.message}`);
    }
  }

  function get(qq) {
    const k = normalizeKey(qq);
    if (!k) return null;
    return data[k] || null;
  }

  function set(qq, patch = {}) {
    const k = normalizeKey(qq);
    if (!k) return null;
    const prev = data[k] || {};
    data[k] = {
      ...prev,
      ...patch,
      notes: Array.isArray(patch.notes) ? patch.notes.slice(0, 12) : (prev.notes || []),
      firstSeen: prev.firstSeen || Date.now(),
      lastSeen: Date.now(),
    };
    save();
    return data[k];
  }

  /** 记住一条关于他的小事（去重、最多 12 条） */
  function addNote(qq, note) {
    const k = normalizeKey(qq);
    const text = String(note || '').trim();
    if (!k || !text) return null;
    const row = data[k] || { notes: [], firstSeen: Date.now() };
    row.notes = Array.isArray(row.notes) ? row.notes : [];
    if (!row.notes.includes(text)) row.notes.push(text.slice(0, 120));
    row.notes = row.notes.slice(-12);
    row.lastSeen = Date.now();
    data[k] = row;
    save();
    return row;
  }

  /** 拼成提示词里的一行；没有记录返回空串 */
  function describe(qq, { fallbackName = '' } = {}) {
    const row = get(qq);
    if (!row) return '';
    const parts = [];
    const name = row.name || fallbackName;
    if (name) parts.push(`他叫${name}`);
    parts.push(`你们的关系：${row.relation || DEFAULTS_RELATION}`);
    if (row.tone) parts.push(`跟他说话的语气：${row.tone}`);
    if (Array.isArray(row.notes) && row.notes.length) parts.push(`关于他你记得：${row.notes.join('；')}`);
    return parts.join('；');
  }

  load();
  return { get, set, addNote, describe, all: () => ({ ...data }), file: filePath };
}

module.exports = { createRelationshipStore };

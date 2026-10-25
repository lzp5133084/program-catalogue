# -*- coding: utf-8 -*-
"""本地程序目录 · 数据存储（SQLite）"""
import os
import json
import time
import hashlib
import secrets
import datetime
import sqlite3


def now_str():
    return datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')


def hash_password(password, salt=None):
    salt = salt or secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt.encode('utf-8'), 120000)
    return dk.hex(), salt


def verify_password(password, stored, salt):
    dk = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt.encode('utf-8'), 120000)
    return dk.hex() == stored


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  display_name TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT,
  last_login TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT,
  expires_at TEXT
);
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  created_at TEXT,
  drives TEXT,
  depth INTEGER,
  stats TEXT
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id INTEGER NOT NULL,
  kind TEXT,
  name TEXT,
  path TEXT,
  category TEXT,
  purpose TEXT,
  usage TEXT,
  status TEXT,
  entry_count INTEGER DEFAULT 0,
  size_bytes INTEGER DEFAULT 0,
  modified_at TEXT DEFAULT '',
  extensions TEXT DEFAULT '',
  top_entry TEXT DEFAULT '',
  syntax_errors INTEGER DEFAULT 0,
  publisher TEXT DEFAULT '',
  version TEXT DEFAULT '',
  install_date TEXT DEFAULT '',
  extra TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_projects_snapshot ON projects(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_projects_path ON projects(path);
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  path TEXT,
  name TEXT,
  ext TEXT,
  size_bytes INTEGER DEFAULT 0,
  modified_at TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_entries_project ON entries(project_id);
CREATE INDEX IF NOT EXISTS idx_entries_snapshot ON entries(snapshot_id);
CREATE TABLE IF NOT EXISTS annotations (
  path TEXT PRIMARY KEY,
  custom_name TEXT DEFAULT '',
  category TEXT DEFAULT '',
  purpose TEXT DEFAULT '',
  usage TEXT DEFAULT '',
  tags TEXT DEFAULT '',
  favorite INTEGER DEFAULT 0,
  note TEXT DEFAULT '',
  updated_at TEXT,
  updated_by TEXT
);
CREATE TABLE IF NOT EXISTS oplog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT,
  username TEXT,
  action TEXT,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
"""

PROJECT_SELECT = """
SELECT p.*,
  COALESCE(NULLIF(a.custom_name, ''), p.name) AS display_name,
  COALESCE(NULLIF(a.category, ''), p.category) AS display_category,
  COALESCE(NULLIF(a.purpose, ''), p.purpose) AS display_purpose,
  COALESCE(NULLIF(a.usage, ''), p.usage) AS display_usage,
  COALESCE(a.tags, '') AS tags,
  COALESCE(a.favorite, 0) AS favorite,
  COALESCE(a.note, '') AS note,
  CASE WHEN a.path IS NULL THEN 0 ELSE 1 END AS annotated
FROM projects p LEFT JOIN annotations a ON a.path = p.path
"""


class Store(object):
    def __init__(self, db_path):
        self.db_path = db_path
        folder = os.path.dirname(os.path.abspath(db_path))
        if folder and not os.path.isdir(folder):
            os.makedirs(folder)
        self._init_db()

    def _conn(self):
        conn = sqlite3.connect(self.db_path, timeout=30)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute('PRAGMA journal_mode=WAL')
            conn.execute('PRAGMA synchronous=NORMAL')
        except Exception:
            pass
        return conn

    def _init_db(self):
        conn = self._conn()
        try:
            conn.executescript(SCHEMA)
            conn.commit()
        finally:
            conn.close()
        self.ensure_admin()

    # ------------------------------------------------------------ 用户 / 登录
    def ensure_admin(self):
        conn = self._conn()
        try:
            row = conn.execute('SELECT COUNT(*) AS c FROM users').fetchone()
            if row['c'] == 0:
                h, s = hash_password('Lzp520520520.')
                conn.execute(
                    'INSERT INTO users (username, password_hash, salt, role, display_name, active, created_at) '
                    'VALUES (?, ?, ?, ?, ?, 1, ?)',
                    ('18180309010', h, s, 'admin', '军哥懂保', now_str()))
                conn.execute(
                    'INSERT INTO settings (key, value) VALUES (?, ?)',
                    ('api_key', secrets.token_hex(24)))
                conn.commit()
        finally:
            conn.close()

    def authenticate(self, username, password):
        conn = self._conn()
        try:
            row = conn.execute('SELECT * FROM users WHERE username = ?', (username,)).fetchone()
            if not row:
                return None
            if int(row['active']) != 1:
                return None
            if not verify_password(password, row['password_hash'], row['salt']):
                return None
            conn.execute('UPDATE users SET last_login = ? WHERE id = ?', (now_str(), row['id']))
            conn.commit()
            return self._user_dict(row)
        finally:
            conn.close()

    def create_session(self, user_id, days=30):
        token = secrets.token_hex(32)
        conn = self._conn()
        try:
            expires = (datetime.datetime.now() + datetime.timedelta(days=days)).strftime('%Y-%m-%d %H:%M:%S')
            conn.execute('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
                         (token, user_id, now_str(), expires))
            conn.execute('DELETE FROM sessions WHERE expires_at < ?', (now_str(),))
            conn.commit()
            return token
        finally:
            conn.close()

    def user_by_token(self, token):
        if not token:
            return None
        conn = self._conn()
        try:
            row = conn.execute(
                'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id '
                'WHERE s.token = ? AND s.expires_at >= ? AND u.active = 1',
                (token, now_str())).fetchone()
            if not row:
                return None
            return self._user_dict(row)
        finally:
            conn.close()

    def delete_session(self, token):
        conn = self._conn()
        try:
            conn.execute('DELETE FROM sessions WHERE token = ?', (token,))
            conn.commit()
        finally:
            conn.close()

    def _user_dict(self, row):
        return {
            'id': row['id'],
            'username': row['username'],
            'role': row['role'],
            'display_name': row['display_name'],
            'active': int(row['active']),
            'created_at': row['created_at'],
            'last_login': row['last_login'],
        }

    def list_users(self):
        conn = self._conn()
        try:
            rows = conn.execute('SELECT * FROM users ORDER BY id').fetchall()
            return [self._user_dict(r) for r in rows]
        finally:
            conn.close()

    def create_user(self, username, password, role='user', display_name=''):
        h, s = hash_password(password)
        conn = self._conn()
        try:
            cur = conn.execute(
                'INSERT INTO users (username, password_hash, salt, role, display_name, active, created_at) '
                'VALUES (?, ?, ?, ?, ?, 1, ?)', (username, h, s, role, display_name, now_str()))
            conn.commit()
            return cur.lastrowid
        finally:
            conn.close()

    def update_user(self, user_id, fields):
        allowed = ['display_name', 'role', 'active']
        sets, vals = [], []
        for k in allowed:
            if k in fields:
                sets.append('%s = ?' % k)
                vals.append(fields[k])
        if fields.get('password'):
            h, s = hash_password(fields['password'])
            sets.append('password_hash = ?')
            vals.append(h)
            sets.append('salt = ?')
            vals.append(s)
        if not sets:
            return False
        vals.append(user_id)
        conn = self._conn()
        try:
            conn.execute('UPDATE users SET %s WHERE id = ?' % ', '.join(sets), vals)
            conn.commit()
            return True
        finally:
            conn.close()

    def delete_user(self, user_id):
        conn = self._conn()
        try:
            row = conn.execute('SELECT role FROM users WHERE id = ?', (user_id,)).fetchone()
            if not row:
                return False
            if row['role'] == 'admin':
                admins = conn.execute("SELECT COUNT(*) AS c FROM users WHERE role='admin' AND active=1").fetchone()['c']
                if admins <= 1:
                    raise ValueError('至少保留一个管理员账号')
            conn.execute('DELETE FROM users WHERE id = ?', (user_id,))
            conn.execute('DELETE FROM sessions WHERE user_id = ?', (user_id,))
            conn.commit()
            return True
        finally:
            conn.close()

    def change_password(self, user_id, old, new):
        conn = self._conn()
        try:
            row = conn.execute('SELECT * FROM users WHERE id = ?', (user_id,)).fetchone()
            if not row or not verify_password(old, row['password_hash'], row['salt']):
                return False
            h, s = hash_password(new)
            conn.execute('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?', (h, s, user_id))
            conn.execute('DELETE FROM sessions WHERE user_id = ?', (user_id,))
            conn.commit()
            return True
        finally:
            conn.close()

    # ------------------------------------------------------------ 快照 / 扫描结果
    def save_snapshot(self, name, drives, depth, projects, entries_by_path, stats):
        conn = self._conn()
        try:
            cur = conn.execute(
                'INSERT INTO snapshots (name, created_at, drives, depth, stats) VALUES (?, ?, ?, ?, ?)',
                (name, now_str(), ','.join(drives), depth, json.dumps(stats, ensure_ascii=False)))
            sid = cur.lastrowid
            project_rows = []
            entry_rows = []
            for p in projects:
                cur = conn.execute(
                    'INSERT INTO projects (snapshot_id, kind, name, path, category, purpose, usage, status, '
                    'entry_count, size_bytes, modified_at, extensions, top_entry, syntax_errors, publisher, version, install_date, extra) '
                    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    (sid, p.get('kind', 'project'), p.get('name', ''), p.get('path', ''),
                     p.get('category', ''), p.get('purpose', ''), p.get('usage', ''),
                     p.get('status', ''), p.get('entry_count', 0), p.get('size_bytes', 0),
                     p.get('modified_at', ''), p.get('extensions', ''), p.get('top_entry', ''),
                     p.get('syntax_errors', 0), p.get('publisher', ''), p.get('version', ''),
                     p.get('install_date', ''), p.get('extra', '')))
                pid = cur.lastrowid
                for e in entries_by_path.get(p.get('path'), []):
                    entry_rows.append((sid, pid, e.get('path', ''), e.get('name', ''),
                                       e.get('ext', ''), e.get('size_bytes', 0), e.get('modified_at', '')))
            if entry_rows:
                conn.executemany(
                    'INSERT INTO entries (snapshot_id, project_id, path, name, ext, size_bytes, modified_at) '
                    'VALUES (?, ?, ?, ?, ?, ?, ?)', entry_rows)
            conn.commit()
            return sid
        finally:
            conn.close()

    def list_snapshots(self, limit=200):
        conn = self._conn()
        try:
            rows = conn.execute(
                'SELECT * FROM snapshots ORDER BY id DESC LIMIT ?', (limit,)).fetchall()
            out = []
            for r in rows:
                d = dict(r)
                try:
                    d['stats'] = json.loads(d.get('stats') or '{}')
                except Exception:
                    d['stats'] = {}
                d['drives'] = [x for x in (d.get('drives') or '').split(',') if x]
                out.append(d)
            return out
        finally:
            conn.close()

    def get_snapshot(self, sid):
        conn = self._conn()
        try:
            r = conn.execute('SELECT * FROM snapshots WHERE id = ?', (sid,)).fetchone()
            if not r:
                return None
            d = dict(r)
            d['stats'] = json.loads(d.get('stats') or '{}')
            d['drives'] = [x for x in (d.get('drives') or '').split(',') if x]
            return d
        finally:
            conn.close()

    def latest_snapshot(self):
        conn = self._conn()
        try:
            r = conn.execute('SELECT * FROM snapshots ORDER BY id DESC LIMIT 1').fetchone()
            if not r:
                return None
            d = dict(r)
            d['stats'] = json.loads(d.get('stats') or '{}')
            d['drives'] = [x for x in (d.get('drives') or '').split(',') if x]
            return d
        finally:
            conn.close()

    def delete_snapshot(self, sid):
        conn = self._conn()
        try:
            conn.execute('DELETE FROM entries WHERE snapshot_id = ?', (sid,))
            conn.execute('DELETE FROM projects WHERE snapshot_id = ?', (sid,))
            conn.execute('DELETE FROM snapshots WHERE id = ?', (sid,))
            conn.commit()
        finally:
            conn.close()

    def snapshot_counts(self, sid):
        conn = self._conn()
        try:
            p = conn.execute('SELECT COUNT(*) AS c FROM projects WHERE snapshot_id = ?', (sid,)).fetchone()['c']
            e = conn.execute('SELECT COUNT(*) AS c FROM entries WHERE snapshot_id = ?', (sid,)).fetchone()['c']
            syn = conn.execute(
                'SELECT COUNT(*) AS c FROM projects WHERE snapshot_id = ? AND syntax_errors > 0', (sid,)).fetchone()['c']
            inst = conn.execute(
                "SELECT COUNT(*) AS c FROM projects WHERE snapshot_id = ? AND kind LIKE 'installed%'", (sid,)).fetchone()['c']
            return {'projects': p, 'entries': e, 'syntax_projects': syn, 'installed': inst}
        finally:
            conn.close()

    def categories(self, sid):
        conn = self._conn()
        try:
            rows = conn.execute(
                "SELECT COALESCE(NULLIF(a.category, ''), p.category) AS cat_name, COUNT(*) AS c "
                'FROM projects p LEFT JOIN annotations a ON a.path = p.path '
                'WHERE p.snapshot_id = ? GROUP BY COALESCE(NULLIF(a.category, \'\'), p.category) '
                'ORDER BY c DESC', (sid,)).fetchall()
            return [{'name': r['cat_name'] or '未分类', 'count': r['c']} for r in rows]
        finally:
            conn.close()

    # ------------------------------------------------------------ 项目查询
    def list_projects(self, sid, q='', category='', kind='', sort='default', page=1, page_size=20):
        where = ['p.snapshot_id = ?']
        params = [sid]
        if q:
            like = '%' + q + '%'
            where.append('(p.name LIKE ? OR p.path LIKE ? OR p.purpose LIKE ? OR p.usage LIKE ? '
                         'OR a.custom_name LIKE ? OR a.note LIKE ? OR a.tags LIKE ?)')
            params += [like] * 7
        if category:
            where.append("COALESCE(NULLIF(a.category, ''), p.category) = ?")
            params.append(category)
        if kind == 'project':
            where.append("p.kind IN ('project', 'installed+project')")
        elif kind == 'installed':
            where.append("p.kind LIKE 'installed%'")
        if sort == 'size':
            order = 'CASE WHEN p.modified_at = \'\' THEN 1 ELSE 0 END, p.size_bytes DESC'
        elif sort == 'name':
            order = 'COALESCE(NULLIF(a.custom_name, \'\'), p.name) ASC'
        elif sort == 'time':
            order = 'CASE WHEN p.modified_at = \'\' THEN 1 ELSE 0 END, p.modified_at DESC'
        else:
            order = ("CASE WHEN p.kind LIKE 'installed%' THEN 1 ELSE 0 END, "
                     "CASE WHEN p.modified_at = '' THEN 1 ELSE 0 END, p.modified_at DESC")
        where_sql = ' AND '.join(where)
        offset = max(0, (page - 1) * page_size)
        conn = self._conn()
        try:
            total = conn.execute(
                'SELECT COUNT(*) AS c FROM projects p LEFT JOIN annotations a ON a.path = p.path '
                'WHERE ' + where_sql, params).fetchone()['c']
            rows = conn.execute(
                PROJECT_SELECT + ' WHERE ' + where_sql + ' ORDER BY ' + order +
                ' LIMIT ? OFFSET ?', params + [page_size, offset]).fetchall()
            return {'total': total, 'page': page, 'page_size': page_size,
                    'items': [dict(r) for r in rows]}
        finally:
            conn.close()

    def get_project(self, pid):
        conn = self._conn()
        try:
            row = conn.execute(PROJECT_SELECT + ' WHERE p.id = ?', (pid,)).fetchone()
            return dict(row) if row else None
        finally:
            conn.close()

    def project_by_path(self, sid, path):
        conn = self._conn()
        try:
            row = conn.execute(PROJECT_SELECT + ' WHERE p.snapshot_id = ? AND p.path = ? ORDER BY p.id DESC LIMIT 1',
                               (sid, path)).fetchone()
            return dict(row) if row else None
        finally:
            conn.close()

    def project_entries(self, pid, limit=600):
        conn = self._conn()
        try:
            rows = conn.execute(
                'SELECT * FROM entries WHERE project_id = ? ORDER BY modified_at DESC LIMIT ?',
                (pid, limit)).fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()

    def list_entries(self, sid, q='', ext='', page=1, page_size=50):
        where = ['e.snapshot_id = ?']
        params = [sid]
        if q:
            like = '%' + q + '%'
            where.append('(e.name LIKE ? OR e.path LIKE ?)')
            params += [like, like]
        if ext:
            where.append('e.ext = ?')
            params.append(ext.lower())
        where_sql = ' AND '.join(where)
        offset = max(0, (page - 1) * page_size)
        conn = self._conn()
        try:
            total = conn.execute('SELECT COUNT(*) AS c FROM entries e WHERE ' + where_sql,
                                 params).fetchone()['c']
            rows = conn.execute(
                'SELECT e.*, p.name AS project_name, p.path AS project_path '
                'FROM entries e LEFT JOIN projects p ON p.id = e.project_id '
                'WHERE ' + where_sql + ' ORDER BY e.modified_at DESC LIMIT ? OFFSET ?',
                params + [page_size, offset]).fetchall()
            return {'total': total, 'page': page, 'page_size': page_size,
                    'items': [dict(r) for r in rows]}
        finally:
            conn.close()

    # ------------------------------------------------------------ 标注（增删改查）
    def save_annotation(self, path, fields, username):
        conn = self._conn()
        try:
            conn.execute(
                'INSERT INTO annotations (path, custom_name, category, purpose, usage, tags, favorite, note, updated_at, updated_by) '
                'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) '
                'ON CONFLICT(path) DO UPDATE SET custom_name=excluded.custom_name, category=excluded.category, '
                'purpose=excluded.purpose, usage=excluded.usage, tags=excluded.tags, favorite=excluded.favorite, '
                'note=excluded.note, updated_at=excluded.updated_at, updated_by=excluded.updated_by',
                (path, fields.get('custom_name', ''), fields.get('category', ''),
                 fields.get('purpose', ''), fields.get('usage', ''), fields.get('tags', ''),
                 1 if fields.get('favorite') else 0, fields.get('note', ''), now_str(), username))
            conn.commit()
            return True
        finally:
            conn.close()

    def delete_annotation(self, path):
        conn = self._conn()
        try:
            conn.execute('DELETE FROM annotations WHERE path = ?', (path,))
            conn.commit()
        finally:
            conn.close()

    def annotation(self, path):
        conn = self._conn()
        try:
            row = conn.execute('SELECT * FROM annotations WHERE path = ?', (path,)).fetchone()
            return dict(row) if row else None
        finally:
            conn.close()

    # ------------------------------------------------------------ 对比 / 日志 / 设置
    def compare(self, a_id, b_id):
        conn = self._conn()
        try:
            A = conn.execute('SELECT path, name FROM projects WHERE snapshot_id = ?', (a_id,)).fetchall()
            B = conn.execute('SELECT path, name FROM projects WHERE snapshot_id = ?', (b_id,)).fetchall()
            map_a = {r['path']: r['name'] for r in A}
            map_b = {r['path']: r['name'] for r in B}
            added = [{'path': p, 'name': map_b[p]} for p in map_b if p not in map_a]
            removed = [{'path': p, 'name': map_a[p]} for p in map_a if p not in map_b]
            return {'added': added, 'removed': removed, 'same': len(set(map_a) & set(map_b))}
        finally:
            conn.close()

    def add_log(self, username, action, detail=''):
        conn = self._conn()
        try:
            conn.execute('INSERT INTO oplog (at, username, action, detail) VALUES (?, ?, ?, ?)',
                         (now_str(), username, action, detail))
            conn.commit()
        finally:
            conn.close()

    def list_logs(self, limit=100):
        conn = self._conn()
        try:
            rows = conn.execute('SELECT * FROM oplog ORDER BY id DESC LIMIT ?', (limit,)).fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()

    def get_setting(self, key, default=''):
        conn = self._conn()
        try:
            row = conn.execute('SELECT value FROM settings WHERE key = ?', (key,)).fetchone()
            return row['value'] if row else default
        finally:
            conn.close()

    def set_setting(self, key, value):
        conn = self._conn()
        try:
            conn.execute('INSERT INTO settings (key, value) VALUES (?, ?) '
                         'ON CONFLICT(key) DO UPDATE SET value = excluded.value', (key, value))
            conn.commit()
        finally:
            conn.close()

    def regenerate_api_key(self):
        key = secrets.token_hex(24)
        self.set_setting('api_key', key)
        return key

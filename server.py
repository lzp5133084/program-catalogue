# -*- coding: utf-8 -*-
"""
本地程序目录查找工具 · 本地服务
- 三端自适应网页界面
- 多用户登录（默认管理员 18180309010）
- 扫描本机磁盘、查看/对比快照、编辑标注、导出数据
- 预留 HTTP API，支持 X-API-Key 供其他程序调用
"""
import os
import sys
import io
import csv
import json
import time
import threading
import subprocess
import datetime
import mimetypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote
from http.cookies import SimpleCookie

import scanner
from store import Store

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, 'static')
DATA_DIR = os.path.join(BASE_DIR, 'data')
DB_PATH = os.path.join(DATA_DIR, 'catalogue.db')
PORT = int(os.environ.get('PC_PORT', '8788'))
HOST = os.environ.get('PC_HOST', '0.0.0.0')
VERSION = '1.0.3'
AUTHOR = '军哥懂保'
WECHAT = 'xunijiayuan'

store = Store(DB_PATH)

SCAN_LOCK = threading.Lock()
SCAN_CANCEL = threading.Event()
SCAN_STATE = {
    'status': 'idle',
    'job_id': '',
    'phase': '',
    'current': '',
    'files_seen': 0,
    'dirs_seen': 0,
    'candidates': 0,
    'entries': 0,
    'elapsed': 0,
    'started_at': '',
    'drives': [],
    'depth': 6,
    'snapshot_id': None,
    'error': '',
    'logs': [],
}
LOGIN_FAILS = {}
LOGIN_LOCK = threading.Lock()


def log_line(msg):
    line = '[%s] %s' % (datetime.datetime.now().strftime('%H:%M:%S'), msg)
    with SCAN_LOCK:
        SCAN_STATE['logs'].append(line)
        if len(SCAN_STATE['logs']) > 40:
            del SCAN_STATE['logs'][:-40]
    print(line)


def folder_size(path):
    total = 0
    latest = 0
    for root, dirs, files in os.walk(path):
        dirs[:] = [d for d in dirs if d not in ('__pycache__', 'data')]
        for f in files:
            try:
                fp = os.path.join(root, f)
                st = os.stat(fp)
                total += st.st_size
                latest = max(latest, st.st_mtime)
            except Exception:
                continue
    return total, latest


def run_scan_job(drives, depth):
    SCAN_CANCEL.clear()
    try:
        start = time.time()

        def progress(p):
            with SCAN_LOCK:
                SCAN_STATE.update({
                    'phase': p.get('phase', ''),
                    'current': p.get('current', ''),
                    'files_seen': p.get('files_seen', 0),
                    'dirs_seen': p.get('dirs_seen', 0),
                    'candidates': p.get('candidates', 0),
                    'entries': p.get('entries', 0),
                    'elapsed': p.get('elapsed', round(time.time() - start, 1)),
                })

        projects, entries, stats = scanner.run_full_scan(
            drives, depth=depth, cancel_check=SCAN_CANCEL.is_set,
            progress_cb=progress, log=log_line)
        if SCAN_CANCEL.is_set():
            with SCAN_LOCK:
                SCAN_STATE['status'] = 'cancelled'
                SCAN_STATE['phase'] = '已取消'
            log_line('扫描已被取消')
            return
        name = '%s · 磁盘 %s · 深度 %d' % (
            datetime.datetime.now().strftime('%Y-%m-%d %H:%M'), '、'.join(drives), depth)
        sid = store.save_snapshot(name, drives, depth, projects, entries, stats)
        with SCAN_LOCK:
            SCAN_STATE.update({
                'status': 'done',
                'phase': '扫描完成',
                'current': '',
                'snapshot_id': sid,
                'files_seen': stats.get('files_seen', 0),
                'dirs_seen': stats.get('dirs_seen', 0),
                'candidates': stats.get('projects', 0),
                'entries': stats.get('entry_total', 0),
                'elapsed': round(time.time() - start, 1),
            })
        store.add_log('system', 'scan', '扫描 %s，项目 %d，入口 %d，用时 %.1f 秒' % (
            '、'.join(drives), stats.get('total_projects', 0), stats.get('entry_total', 0),
            stats.get('duration', 0)))
        log_line('扫描完成：项目 %d，入口 %d' % (stats.get('total_projects', 0), stats.get('entry_total', 0)))
    except Exception as exc:
        with SCAN_LOCK:
            SCAN_STATE['status'] = 'error'
            SCAN_STATE['error'] = str(exc)
            SCAN_STATE['phase'] = '扫描失败'
        log_line('扫描失败：%s' % exc)


class Handler(BaseHTTPRequestHandler):
    server_version = 'ProgramCatalogue/' + VERSION
    protocol_version = 'HTTP/1.1'

    # ------------------------------------------------------------ 基础工具
    def log_message(self, fmt, *args):
        pass

    def _send(self, code, body=b'', content_type='application/json; charset=utf-8', extra=None):
        if isinstance(body, str):
            body = body.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'same-origin')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-API-Key')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def json(self, data, code=200, extra=None):
        self._send(code, json.dumps(data, ensure_ascii=False).encode('utf-8'), extra=extra)

    def error(self, msg, code=400):
        self.json({'ok': False, 'error': msg}, code)

    def body_json(self):
        try:
            length = int(self.headers.get('Content-Length') or 0)
        except Exception:
            length = 0
        if length <= 0:
            return {}
        if length > 20 * 1024 * 1024:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode('utf-8'))
        except Exception:
            return {}

    def client_ip(self):
        try:
            return self.client_address[0]
        except Exception:
            return ''

    def cookie_token(self):
        raw = self.headers.get('Cookie') or ''
        try:
            c = SimpleCookie()
            c.load(raw)
            morsel = c.get('pc_session')
            return morsel.value if morsel else ''
        except Exception:
            return ''

    def current_user(self):
        return store.user_by_token(self.cookie_token())

    def api_key_ok(self):
        key = self.headers.get('X-API-Key') or ''
        saved = store.get_setting('api_key', '')
        return bool(key) and bool(saved) and key == saved

    def require_user(self, roles=None):
        user = self.current_user()
        if not user:
            self.error('请先登录', 401)
            return None
        if roles and user['role'] not in roles:
            self.error('没有权限执行该操作', 403)
            return None
        return user

    def require_read(self):
        user = self.current_user()
        if user:
            return user
        if self.api_key_ok():
            return {'username': 'api', 'role': 'api', 'display_name': 'API调用', 'id': 0}
        return None

    # ------------------------------------------------------------ 路由
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        try:
            if path.startswith('/static/'):
                return self.serve_static(path)
            if path == '/':
                return self.serve_file(os.path.join(STATIC_DIR, 'index.html'))
            if path == '/favicon.ico':
                return self._send(204)
            if path.startswith('/api/'):
                return self.api_get(path, query)
            if path.endswith('.html'):
                return self.serve_file(os.path.join(STATIC_DIR, os.path.basename(path)))
            self.error('接口不存在', 404)
        except BrokenPipeError:
            pass
        except Exception as exc:
            self.error('服务异常：%s' % exc, 500)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Content-Length', '0')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-API-Key')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
        self.end_headers()

    def do_POST(self):
        parsed = urlparse(self.path)
        try:
            if parsed.path.startswith('/api/'):
                return self.api_post(parsed.path, parse_qs(parsed.query))
            self.error('接口不存在', 404)
        except BrokenPipeError:
            pass
        except Exception as exc:
            self.error('服务异常：%s' % exc, 500)

    def do_PUT(self):
        parsed = urlparse(self.path)
        try:
            if parsed.path.startswith('/api/'):
                return self.api_put(parsed.path)
            self.error('接口不存在', 404)
        except BrokenPipeError:
            pass
        except Exception as exc:
            self.error('服务异常：%s' % exc, 500)

    def do_DELETE(self):
        parsed = urlparse(self.path)
        try:
            if parsed.path.startswith('/api/'):
                return self.api_delete(parsed.path, parse_qs(parsed.query))
            self.error('接口不存在', 404)
        except BrokenPipeError:
            pass
        except Exception as exc:
            self.error('服务异常：%s' % exc, 500)

    # ------------------------------------------------------------ 静态文件
    def serve_static(self, path):
        name = path[len('/static/'):]
        name = name.replace('..', '').replace('\\', '/')
        fp = os.path.join(STATIC_DIR, name)
        if not os.path.isfile(fp):
            return self.error('文件不存在', 404)
        return self.serve_file(fp)

    def serve_file(self, fp):
        if not os.path.isfile(fp):
            return self.error('页面不存在', 404)
        ctype = mimetypes.guess_type(fp)[0] or 'application/octet-stream'
        if ctype.startswith('text/') or ctype in ('application/javascript', 'application/json'):
            ctype += '; charset=utf-8'
        try:
            with open(fp, 'rb') as f:
                data = f.read()
        except Exception as exc:
            return self.error('读取失败：%s' % exc, 500)
        extra = {'Cache-Control': 'no-cache'}
        self._send(200, data, ctype, extra)

    # ------------------------------------------------------------ GET API
    def api_get(self, path, query):
        parts = [p for p in path.split('/') if p]

        if path == '/api/health':
            return self.json({
                'ok': True, 'name': '本地程序目录查找工具', 'version': VERSION,
                'time': datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
                'author': AUTHOR, 'wechat': WECHAT,
            })

        if path == '/api/docs':
            return self.json({'ok': True, 'docs': API_DOCS})

        user = self.require_read()
        if not user:
            return self.error('请先登录，或在请求头带上 X-API-Key', 401)

        if path == '/api/me':
            return self.json({'ok': True, 'user': user})

        if path == '/api/meta':
            size, latest = folder_size(BASE_DIR)
            db_size = os.path.getsize(DB_PATH) if os.path.isfile(DB_PATH) else 0
            latest_snap = store.latest_snapshot()
            return self.json({
                'ok': True,
                'version': VERSION,
                'author': AUTHOR,
                'wechat': WECHAT,
                'tool_size': size,
                'tool_size_text': scanner.human_size(size),
                'tool_modified': datetime.datetime.fromtimestamp(latest).strftime('%Y-%m-%d %H:%M:%S') if latest else '',
                'db_size': db_size,
                'db_size_text': scanner.human_size(db_size),
                'latest_snapshot': latest_snap,
                'now': datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
            })

        if path == '/api/drives':
            return self.json({'ok': True, 'drives': scanner.get_drives()})

        if path == '/api/scan/status':
            with SCAN_LOCK:
                state = dict(SCAN_STATE)
            return self.json({'ok': True, 'state': state})

        if path == '/api/snapshots':
            return self.json({'ok': True, 'items': store.list_snapshots()})

        if path == '/api/snapshots/compare':
            try:
                a = int(query.get('a', ['0'])[0])
                b = int(query.get('b', ['0'])[0])
            except Exception:
                return self.error('快照编号不正确')
            return self.json({'ok': True, 'compare': store.compare(a, b),
                              'a': store.get_snapshot(a), 'b': store.get_snapshot(b)})

        if len(parts) == 3 and parts[2].isdigit() and parts[1] == 'snapshots':
            snap = store.get_snapshot(int(parts[2]))
            if not snap:
                return self.error('快照不存在', 404)
            return self.json({'ok': True, 'snapshot': snap, 'counts': store.snapshot_counts(int(parts[2]))})

        if path == '/api/projects':
            snap_id = self._snap_id(query)
            if not snap_id:
                return self.json({'ok': True, 'total': 0, 'items': [], 'page': 1, 'page_size': 20})
            return self.json({'ok': True, **store.list_projects(
                snap_id,
                q=query.get('q', [''])[0].strip(),
                category=query.get('category', [''])[0].strip(),
                kind=query.get('kind', [''])[0].strip(),
                sort=query.get('sort', ['default'])[0].strip(),
                page=max(1, int(query.get('page', ['1'])[0] or 1)),
                page_size=min(100, max(5, int(query.get('page_size', ['20'])[0] or 20))))})

        if len(parts) == 3 and parts[2].isdigit() and parts[1] == 'projects':
            pid = int(parts[2])
            project = store.get_project(pid)
            if not project:
                return self.error('项目不存在', 404)
            return self.json({'ok': True, 'project': project,
                              'entries': store.project_entries(pid),
                              'annotation': store.annotation(project['path'])})

        if path == '/api/entries':
            snap_id = self._snap_id(query)
            if not snap_id:
                return self.json({'ok': True, 'total': 0, 'items': [], 'page': 1, 'page_size': 50})
            return self.json({'ok': True, **store.list_entries(
                snap_id,
                q=query.get('q', [''])[0].strip(),
                ext=query.get('ext', [''])[0].strip(),
                page=max(1, int(query.get('page', ['1'])[0] or 1)),
                page_size=min(200, max(10, int(query.get('page_size', ['50'])[0] or 50))))})

        if path == '/api/stats':
            snap_id = self._snap_id(query)
            if not snap_id:
                return self.json({'ok': True, 'counts': {'projects': 0, 'entries': 0},
                                  'syntax_projects': 0, 'installed': 0, 'categories': []})
            counts = store.snapshot_counts(snap_id)
            return self.json({'ok': True, 'counts': counts,
                              'categories': store.categories(snap_id)})

        if path == '/api/logs':
            return self.json({'ok': True, 'items': store.list_logs(min(500, int(query.get('limit', ['80'])[0] or 80)))})

        if path == '/api/users':
            if user['role'] != 'admin':
                return self.error('只有管理员可以查看账号', 403)
            return self.json({'ok': True, 'items': store.list_users()})

        if path == '/api/settings':
            if user['role'] != 'admin':
                return self.error('只有管理员可以查看设置', 403)
            return self.json({'ok': True, 'api_key': store.get_setting('api_key', ''),
                              'author': AUTHOR, 'wechat': WECHAT, 'version': VERSION,
                              'docs': API_DOCS})

        if path == '/api/export':
            snap_id = self._snap_id(query)
            if not snap_id:
                return self.error('没有可导出的扫描结果', 404)
            fmt = query.get('format', ['json'])[0].lower()
            data = store.list_projects(snap_id, page=1, page_size=100000)
            if fmt == 'csv':
                buf = io.StringIO()
                writer = csv.writer(buf)
                writer.writerow(['编号', '名称', '分类', '类型', '路径', '用途', '使用方式', '状态',
                                 '入口数', '体积(字节)', '最近修改', '扩展名'])
                for i, p in enumerate(data['items'], 1):
                    writer.writerow([i, p['display_name'], p['display_category'], p['kind'], p['path'],
                                     p['display_purpose'], p['display_usage'], p['status'],
                                     p['entry_count'], p['size_bytes'], p['modified_at'], p['extensions']])
                body = '\ufeff' + buf.getvalue()
                return self._send(200, body.encode('utf-8'),
                                  'text/csv; charset=utf-8',
                                  {'Content-Disposition': 'attachment; filename="program-catalogue.csv"'})
            return self._send(200, json.dumps({'ok': True, 'snapshot_id': snap_id, 'items': data['items']},
                                              ensure_ascii=False, indent=2).encode('utf-8'),
                              'application/json; charset=utf-8',
                              {'Content-Disposition': 'attachment; filename="program-catalogue.json"'})

        return self.error('接口不存在', 404)

    def _snap_id(self, query):
        raw = query.get('snapshot_id', [''])[0]
        if raw and raw.isdigit():
            return int(raw)
        snap = store.latest_snapshot()
        return snap['id'] if snap else 0

    # ------------------------------------------------------------ POST API
    def api_post(self, path, query):
        if path == '/api/login':
            data = self.body_json()
            username = str(data.get('username') or '').strip()
            password = str(data.get('password') or '')
            ip = self.client_ip()
            with LOGIN_LOCK:
                rec = LOGIN_FAILS.get(ip, {'count': 0, 'at': 0})
                if rec['count'] >= 8 and time.time() - rec['at'] < 300:
                    return self.error('尝试次数过多，请 5 分钟后再试', 429)
            user = store.authenticate(username, password)
            if not user:
                with LOGIN_LOCK:
                    rec = LOGIN_FAILS.setdefault(ip, {'count': 0, 'at': 0})
                    rec['count'] += 1
                    rec['at'] = time.time()
                return self.error('账号或密码不正确', 401)
            with LOGIN_LOCK:
                LOGIN_FAILS.pop(ip, None)
            token = store.create_session(user['id'])
            store.add_log(user['username'], 'login', '登录成功')
            return self.json({'ok': True, 'user': user},
                             extra={'Set-Cookie': 'pc_session=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000' % token})

        if path == '/api/logout':
            token = self.cookie_token()
            if token:
                store.delete_session(token)
            return self.json({'ok': True}, extra={'Set-Cookie': 'pc_session=; Path=/; HttpOnly; Max-Age=0'})

        user = self.require_user()
        if not user:
            return None

        if path == '/api/me/password':
            data = self.body_json()
            old = str(data.get('old') or '')
            new = str(data.get('new') or '')
            if len(new) < 6:
                return self.error('新密码至少 6 位')
            if not store.change_password(user['id'], old, new):
                return self.error('原密码不正确')
            store.add_log(user['username'], 'password', '修改了自己的密码')
            return self.json({'ok': True, 'message': '密码已修改，请重新登录'})

        if path == '/api/scan':
            data = self.body_json()
            drives = data.get('drives') or []
            depth = int(data.get('depth') or 6)
            depth = min(10, max(3, depth))
            if not isinstance(drives, list) or not drives:
                return self.error('请至少选择一个磁盘')
            valid = {d['letter'] for d in scanner.get_drives()}
            drives = [str(d).strip().upper().replace(':', '') for d in drives]
            drives = [d for d in drives if d in valid]
            if not drives:
                return self.error('没有有效的磁盘')
            with SCAN_LOCK:
                if SCAN_STATE['status'] == 'running':
                    return self.error('已有扫描任务正在进行，请等待完成或取消', 409)
                SCAN_STATE.update({
                    'status': 'running', 'job_id': str(int(time.time())),
                    'phase': '准备扫描', 'current': '', 'files_seen': 0, 'dirs_seen': 0,
                    'candidates': 0, 'entries': 0, 'elapsed': 0,
                    'started_at': datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
                    'drives': drives, 'depth': depth, 'snapshot_id': None,
                    'error': '', 'logs': [],
                })
            SCAN_CANCEL.clear()
            t = threading.Thread(target=run_scan_job, args=(drives, depth), daemon=True)
            t.start()
            store.add_log(user['username'], 'scan_start', '开始扫描磁盘 %s（深度 %d）' % ('、'.join(drives), depth))
            return self.json({'ok': True, 'message': '扫描已开始', 'drives': drives})

        if path == '/api/scan/cancel':
            with SCAN_LOCK:
                running = SCAN_STATE['status'] == 'running'
            if not running:
                return self.error('当前没有进行中的扫描')
            SCAN_CANCEL.set()
            store.add_log(user['username'], 'scan_cancel', '取消了扫描任务')
            return self.json({'ok': True, 'message': '已发送取消指令'})

        if path == '/api/annotation':
            data = self.body_json()
            p = str(data.get('path') or '').strip()
            if not p:
                return self.error('缺少项目路径')
            fields = {
                'custom_name': str(data.get('custom_name') or '').strip()[:120],
                'category': str(data.get('category') or '').strip()[:40],
                'purpose': str(data.get('purpose') or '').strip()[:500],
                'usage': str(data.get('usage') or '').strip()[:800],
                'tags': str(data.get('tags') or '').strip()[:200],
                'note': str(data.get('note') or '').strip()[:1000],
                'favorite': 1 if data.get('favorite') else 0,
            }
            store.save_annotation(p, fields, user['username'])
            store.add_log(user['username'], 'annotation_save', '更新标注：%s' % p)
            return self.json({'ok': True, 'message': '标注已保存'})

        if path == '/api/reveal':
            data = self.body_json()
            p = str(data.get('path') or '').strip()
            if not p or not os.path.exists(p):
                return self.error('路径不存在或不可访问')
            try:
                if os.path.isdir(p):
                    subprocess.Popen(['explorer', os.path.normpath(p)])
                else:
                    subprocess.Popen(['explorer', '/select,', os.path.normpath(p)])
            except Exception as exc:
                return self.error('无法打开文件夹：%s' % exc)
            store.add_log(user['username'], 'reveal', '打开位置：%s' % p)
            return self.json({'ok': True, 'message': '已在资源管理器中打开'})

        if path == '/api/users':
            if user['role'] != 'admin':
                return self.error('只有管理员可以新增账号', 403)
            data = self.body_json()
            username = str(data.get('username') or '').strip()
            password = str(data.get('password') or '')
            if len(username) < 3:
                return self.error('账号至少 3 位')
            if len(password) < 6:
                return self.error('密码至少 6 位')
            role = 'admin' if data.get('role') == 'admin' else 'user'
            try:
                uid = store.create_user(username, password, role,
                                        str(data.get('display_name') or '').strip()[:60])
            except Exception:
                return self.error('账号已存在')
            store.add_log(user['username'], 'user_add', '新增账号 %s' % username)
            return self.json({'ok': True, 'id': uid, 'message': '账号已创建'})

        if path == '/api/settings/api-key':
            if user['role'] != 'admin':
                return self.error('只有管理员可以操作', 403)
            key = store.regenerate_api_key()
            store.add_log(user['username'], 'api_key', '重新生成了 API Key')
            return self.json({'ok': True, 'api_key': key})

        return self.error('接口不存在', 404)

    # ------------------------------------------------------------ PUT / DELETE
    def api_put(self, path):
        user = self.require_user()
        if not user:
            return None
        parts = [p for p in path.split('/') if p]
        if len(parts) == 3 and parts[1] == 'users' and parts[2].isdigit():
            if user['role'] != 'admin':
                return self.error('只有管理员可以修改账号', 403)
            uid = int(parts[2])
            if uid == user['id'] and self.body_json().get('active') == 0:
                return self.error('不能停用当前登录账号')
            data = self.body_json()
            fields = {}
            if 'display_name' in data:
                fields['display_name'] = str(data.get('display_name') or '')[:60]
            if 'role' in data:
                fields['role'] = 'admin' if data.get('role') == 'admin' else 'user'
            if 'active' in data:
                fields['active'] = 1 if data.get('active') else 0
            if 'password' in data:
                if len(str(data.get('password') or '')) < 6:
                    return self.error('密码至少 6 位')
                fields['password'] = str(data.get('password'))
            ok = store.update_user(uid, fields)
            store.add_log(user['username'], 'user_update', '修改账号 #%d' % uid)
            return self.json({'ok': bool(ok)})
        return self.error('接口不存在', 404)

    def api_delete(self, path, query):
        user = self.require_user()
        if not user:
            return None
        parts = [p for p in path.split('/') if p]
        if path == '/api/annotation':
            p = query.get('path', [''])[0]
            if not p:
                return self.error('缺少项目路径')
            store.delete_annotation(p)
            store.add_log(user['username'], 'annotation_delete', '清除标注：%s' % p)
            return self.json({'ok': True, 'message': '已恢复系统识别内容'})
        if len(parts) == 3 and parts[1] == 'snapshots' and parts[2].isdigit():
            sid = int(parts[2])
            snap = store.get_snapshot(sid)
            if not snap:
                return self.error('快照不存在', 404)
            store.delete_snapshot(sid)
            store.add_log(user['username'], 'snapshot_delete', '删除快照：%s' % snap['name'])
            return self.json({'ok': True, 'message': '快照已删除'})
        if len(parts) == 3 and parts[1] == 'users' and parts[2].isdigit():
            if user['role'] != 'admin':
                return self.error('只有管理员可以删除账号', 403)
            uid = int(parts[2])
            if uid == user['id']:
                return self.error('不能删除当前登录账号')
            try:
                ok = store.delete_user(uid)
            except ValueError as exc:
                return self.error(str(exc))
            if not ok:
                return self.error('账号不存在', 404)
            store.add_log(user['username'], 'user_delete', '删除账号 #%d' % uid)
            return self.json({'ok': True, 'message': '账号已删除'})
        return self.error('接口不存在', 404)


API_DOCS = {
    '说明': '所有 /api/ 接口返回 JSON；外部程序可在请求头携带 X-API-Key（设置页可查看）读取目录数据。',
    '鉴权': '浏览器使用登录 Cookie；外部程序使用 X-API-Key。',
    '只读接口': {
        'GET /api/health': '健康检查',
        'GET /api/meta': '工具版本、体积、最近保存时间、最新快照',
        'GET /api/drives': '本机磁盘列表',
        'GET /api/snapshots': '扫描快照列表',
        'GET /api/projects?q=&category=&kind=&page=': '项目目录（可分页搜索）',
        'GET /api/projects/{id}': '项目详情与入口列表',
        'GET /api/entries?ext=py&page=': '程序入口索引',
        'GET /api/stats': '统计与分类分布',
        'GET /api/export?format=json|csv': '导出目录数据',
    },
    '写入接口（需登录）': {
        'POST /api/scan': '开始扫描 {"drives":["C","E"],"depth":6}',
        'GET /api/scan/status': '扫描进度',
        'POST /api/scan/cancel': '取消扫描',
        'POST /api/annotation': '保存项目标注',
        'DELETE /api/annotation?path=': '清除标注',
    },
}


def main():
    if not os.path.isdir(DATA_DIR):
        os.makedirs(DATA_DIR)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print('=' * 58)
    print(' 本地程序目录查找工具 v%s  ·  军哥懂保' % VERSION)
    print(' 本机访问： http://127.0.0.1:%d' % PORT)
    print(' 局域网访问： http://<本机IP>:%d' % PORT)
    print(' 管理员账号：18180309010')
    print('=' * 58)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止')


if __name__ == '__main__':
    main()

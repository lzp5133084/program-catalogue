# -*- coding: utf-8 -*-
"""
本地程序目录扫描引擎
- 枚举本机磁盘（可选单盘/多盘/全部）
- 扫描项目目录与程序入口（exe/py/bat/html/...）
- 读取注册表已安装软件
- 归类、用途说明、使用方式、Python 语法检查
"""
import os
import re
import time
import ctypes
import string
import shutil
import datetime

# 会被视为“程序入口”的扩展名
ENTRY_EXTS = {
    'exe', 'py', 'pyw', 'bat', 'cmd', 'ps1', 'sh',
    'html', 'htm', 'js', 'jsx', 'tsx', 'vue',
    'jar', 'apk', 'kt', 'java', 'cs', 'sln', 'csproj',
    'wxml', 'wxss', 'sql', 'ahk', 'vbs',
}

# 项目标记文件（有标记即视为项目根）
MARKERS = {
    'package.json', 'requirements.txt', 'pyproject.toml', 'setup.py',
    'readme.md', 'readme.txt', 'project.config.json', 'cargo.toml',
    'pom.xml', 'build.gradle', 'go.mod', 'cmakelists.txt',
    'dockerfile', 'compose.yml', 'docker-compose.yml', 'app.py', 'main.py',
    'tsconfig.json', 'jsconfig.json', 'vite.config.js', 'next.config.js',
}

# 扫描时跳过的目录（系统、依赖、缓存）
SKIP_DIRS = {
    'windows', 'windows.old', '$recycle.bin', 'system volume information',
    'recovery', 'msocache', 'perflogs', 'program files', 'program files (x86)',
    'programdata', 'appdata', 'node_modules', '.git', '.svn', '.hg',
    '__pycache__', '.venv', 'venv', 'env', 'site-packages', 'dist-info',
    '.idea', '.vs', '.gradle', '.conda', '.nuget', '.cache', 'temp', 'tmp',
    'packages', 'obj', '.cursor', '.vscode', '.trae', '.pytest_cache',
    'logs', 'cache',
}

TYPE_NAMES = {2: '可移动磁盘', 3: '本地磁盘', 4: '网络驱动器', 5: '光驱', 6: '虚拟磁盘'}

# 这些是项目内部的常见子目录，父级已是项目时不再单独算项目
SUBFOLDER_SKIP = {
    'static', 'templates', 'assets', 'public', 'src', 'css', 'js',
    'images', 'img', 'fonts', 'vendor', 'components', 'pages', 'views',
    'styles', 'dist-info', 'locales', 'resources',
}

CATEGORY_KEYWORDS = [
    ('保险与理赔', ['保险', '理赔', '保单', '增员', '客户经营', 'insurance', 'baoxian']),
    ('办公与文件', ['excel', 'word', '办公', '表格', '文档', '文件', 'pdf', '复制', '批量重命名', 'office']),
    ('直播与音视频', ['视频', '语音', '音频', '播报', '直播', '剪辑', '字幕', '录音', 'video', 'audio', 'voice', 'tts']),
    ('桌面自动化', ['自动点击', '监控', '自动化', '截图', '识屏', '屏幕', '点击', 'auto', 'click', 'screen', 'rpa']),
    ('财务与资产', ['财务', '消费', '账单', '记账', '信用', '资产', '发票', 'finance', 'bill']),
    ('日历与提醒', ['提醒', '日历', '生日', '闹钟', '倒计时', '待办', 'reminder', 'calendar', 'todo']),
    ('AI与大模型', ['ai', 'gpt', '大模型', 'llm', 'ocr', '识别', '智能', 'agent', '豆包', '火山']),
    ('网站与业务原型', ['网站', '网页', '小程序', '系统', '平台', '管理端', '后台', 'portal', 'web', 'app', 'flutter', 'h5', 'vue', 'react']),
]

CATEGORY_GUIDE = {
    '保险与理赔': '保险客户、保单与理赔资料的管理或计算工具，使用前先核对客户数据与计算规则。',
    '办公与文件': '用于整理资料、处理表格文档或集中管理常用工具，批量操作前建议先备份原文件。',
    '直播与音视频': '处理音频、视频、语音播报或直播辅助，运行前先确认设备、音量与素材路径。',
    '桌面自动化': '按屏幕区域、窗口或预设规则自动操作，首次使用请小范围试跑，避免误点重要内容。',
    '财务与资产': '整理消费、账单或资产记录，数据仅作辅助，正式记账请自行复核。',
    '日历与提醒': '管理日程、生日与定时提醒，提醒能否触发取决于程序是否保持运行。',
    'AI与大模型': '调用大模型或识别能力，需要配置对应 API Key 与网络环境。',
    '网站与业务原型': '网页或移动端原型，通常需要启动本地服务后在浏览器访问。',
    '其他开发工具': '用途需要结合项目说明与运行界面继续核实。',
    '系统与软件': '通过安装包安装的软件，可在开始菜单启动，或到系统“应用”中卸载。',
}

PRIORITY_NAMES = [
    'main.py', 'app.py', 'index.html', 'start.bat', '启动.bat', 'run.bat',
    'main.exe', 'app.exe', 'package.json', 'project.config.json',
]


def norm(path):
    return os.path.normcase(os.path.normpath(path))


def now_str():
    return datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')


def ts_to_str(ts):
    try:
        return datetime.datetime.fromtimestamp(ts).strftime('%Y-%m-%d %H:%M:%S')
    except Exception:
        return ''


def human_size(num):
    try:
        num = float(num)
    except Exception:
        return '0 B'
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if num < 1024 or unit == 'TB':
            if unit == 'B':
                return '%d B' % int(num)
            return '%.2f %s' % (num, unit)
        num /= 1024.0


def get_drives():
    """列出本机可用磁盘（本地磁盘 + 可移动磁盘）"""
    drives = []
    try:
        k32 = ctypes.windll.kernel32
    except Exception:
        return [{'letter': 'C', 'root': 'C:\\', 'type': 3, 'type_name': '本地磁盘',
                 'label': '', 'total': 0, 'free': 0}]
    for letter in string.ascii_uppercase:
        root = '%s:\\' % letter
        if not os.path.exists(root):
            continue
        try:
            dtype = k32.GetDriveTypeW(ctypes.c_wchar_p(root))
        except Exception:
            dtype = 0
        if dtype not in (2, 3, 4):
            continue
        label = ''
        try:
            vol = ctypes.create_unicode_buffer(261)
            ok = k32.GetVolumeInformationW(
                ctypes.c_wchar_p(root), vol, 261, None, None, None, None, 0)
            if ok:
                label = vol.value
        except Exception:
            pass
        total = free = 0
        try:
            usage = shutil.disk_usage(root)
            total, free = usage.total, usage.free
        except Exception:
            pass
        drives.append({
            'letter': letter,
            'root': root,
            'type': dtype,
            'type_name': TYPE_NAMES.get(dtype, '磁盘'),
            'label': label,
            'total': total,
            'free': free,
            'total_text': human_size(total),
            'free_text': human_size(free),
        })
    return drives


# ---------------------------------------------------------------- 分类 / 文案
def guess_category(name, parent_name, exts, ext_count, marker_names=None):
    parts = [name or '', parent_name or '']
    for m in sorted(marker_names or []):
        if m in ('package.json', 'project.config.json', 'cargo.toml', 'go.mod',
                 'pom.xml', 'build.gradle', 'cmakelists.txt', 'dockerfile'):
            parts.append(m)
    text = ' '.join(parts).lower()
    marker_names = marker_names or set()
    if 'project.config.json' in marker_names or 'wxml' in exts or 'wxss' in exts:
        return '网站与业务原型'
    if 'package.json' in marker_names and ('tsx' in exts or 'jsx' in exts or 'vue' in exts):
        return '网站与业务原型'
    best = None
    best_score = 0
    for cat, words in CATEGORY_KEYWORDS:
        score = 0
        for w in words:
            wl = w.lower()
            if wl.isascii() and len(wl) <= 3:
                if re.search(r'(^|[^a-z0-9])' + re.escape(wl) + r'([^a-z0-9]|$)', text):
                    score += 1
            elif wl in text:
                score += 1
        if score > best_score:
            best, best_score = cat, score
    if best:
        return best
    if ext_count <= 0:
        return '系统与软件'
    return '其他开发工具'


def build_purpose(name, category, exts):
    base = CATEGORY_GUIDE.get(category, CATEGORY_GUIDE['其他开发工具'])
    return base


def pick_top_entry(path, file_names):
    """从目录直接文件里选出最像入口的文件"""
    lower = {}
    for fn in file_names:
        lower[fn.lower()] = fn
    for want in PRIORITY_NAMES:
        if want in lower:
            return lower[want]
    # 其次：根目录下的 exe / py / html / bat
    for fn in file_names:
        if fn.lower().endswith('.exe') and 'unins' not in fn.lower():
            return fn
    for fn in file_names:
        if fn.lower().endswith(('.py', '.pyw')):
            return fn
    for fn in file_names:
        if fn.lower().endswith(('.html', '.htm')):
            return fn
    for fn in file_names:
        if fn.lower().endswith(('.bat', '.cmd', '.ps1')):
            return fn
    return ''


def build_usage(path, top_entry, exts, marker_names, category):
    if not top_entry:
        if 'package.json' in marker_names:
            return '先安装依赖（npm install），再执行 npm run dev 或 npm start；用浏览器访问提示的地址。'
        if 'requirements.txt' in marker_names:
            return '先安装依赖（pip install -r requirements.txt），再在项目目录运行主程序；不要单独移动源码。'
        return '源码工程；用对应的开发工具打开，核对构建配置和主入口后再运行。'
    low = top_entry.lower()
    if low == 'package.json':
        return '先安装依赖（npm install），再执行 npm run dev 或 npm start；用浏览器访问提示的地址。'
    if low == 'project.config.json':
        return '用微信开发者工具导入该目录，编译预览后再真机调试。'
    ext = low.rsplit('.', 1)[-1] if '.' in low else ''
    if ext in ('py', 'pyw'):
        return '先核对 requirements 与配置文件，然后在项目目录运行 python %s；不要单独移动源码文件。' % top_entry
    if ext == 'exe':
        return '在原目录双击 %s；若被安全软件拦截，确认来源可信后再放行，并保留同目录依赖与数据。' % top_entry
    if ext in ('bat', 'cmd'):
        return '在原目录双击 %s；运行前先看清脚本内容与默认路径，保留同目录依赖。' % top_entry
    if ext == 'ps1':
        return '在 PowerShell 中运行 %s，首次使用需确认执行策略；保留同目录依赖。' % top_entry
    if ext in ('html', 'htm'):
        return '先用浏览器打开 %s；如果项目带后端或构建配置，按项目说明启动服务后再访问页面。' % top_entry
    if ext == 'sln':
        return '用 Visual Studio 打开 %s，核对构建配置后编译运行。' % top_entry
    if ext == 'jar':
        return '确认已安装 Java 后，在该目录执行 java -jar %s。' % top_entry
    if ext == 'apk':
        return '把 %s 安装到安卓设备，按应用提示授予必要权限后再使用。' % top_entry
    if ext in ('js', 'jsx', 'ts', 'tsx', 'vue'):
        return '先在项目目录安装依赖（npm install），再按 package.json 的脚本启动。'
    if ext in ('ahk', 'vbs', 'sh'):
        return '核对脚本内容后，用对应运行环境执行 %s。' % top_entry
    return '在原目录使用 %s；运行前核对其功能与配置，保留同目录依赖和数据。' % top_entry


# ---------------------------------------------------------------- 已安装软件
def scan_installed_software(log=None):
    """读取注册表卸载项，得到已安装软件列表"""
    items = []
    try:
        import winreg
    except Exception:
        return items
    sources = [
        (winreg.HKEY_LOCAL_MACHINE, r'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall', winreg.KEY_WOW64_64KEY),
        (winreg.HKEY_LOCAL_MACHINE, r'SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall', winreg.KEY_WOW64_64KEY),
        (winreg.HKEY_CURRENT_USER, r'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall', 0),
    ]
    seen = set()
    for hive, subkey, flag in sources:
        try:
            key = winreg.OpenKey(hive, subkey, 0, winreg.KEY_READ | flag)
        except Exception:
            continue
        try:
            count = winreg.QueryInfoKey(key)[0]
        except Exception:
            count = 0
        for i in range(count):
            try:
                sub_name = winreg.EnumKey(key, i)
                sk = winreg.OpenKey(key, sub_name)
            except Exception:
                continue
            vals = {}
            try:
                n = winreg.QueryInfoKey(sk)[1]
                for j in range(n):
                    try:
                        vname, vdata, _ = winreg.EnumValue(sk, j)
                        vals[vname] = vdata
                    except Exception:
                        continue
            except Exception:
                pass
            finally:
                try:
                    winreg.CloseKey(sk)
                except Exception:
                    pass
            name = str(vals.get('DisplayName') or '').strip()
            if not name or name in seen:
                continue
            if vals.get('SystemComponent') in (1, '1'):
                continue
            release = str(vals.get('ReleaseType') or '')
            if 'update' in release.lower() or 'hotfix' in release.lower():
                continue
            if re.match(r'^KB\d{6,}', name):
                continue
            seen.add(name)
            loc = str(vals.get('InstallLocation') or '').strip()
            icon = str(vals.get('DisplayIcon') or '').strip().strip('"')
            if not loc and icon:
                icon_path = icon.split(',')[0].strip('"')
                if icon_path.lower().endswith(('.exe', '.dll')):
                    loc = os.path.dirname(icon_path)
            size = 0
            try:
                size = int(vals.get('EstimatedSize') or 0) * 1024
            except Exception:
                size = 0
            if size <= 0 and loc and os.path.isdir(loc):
                size = 0  # 不递归统计，避免拖慢扫描
            items.append({
                'kind': 'installed',
                'name': name,
                'path': loc,
                'publisher': str(vals.get('Publisher') or ''),
                'version': str(vals.get('DisplayVersion') or ''),
                'install_date': str(vals.get('InstallDate') or ''),
                'size_bytes': size,
                'modified_at': '',
                'entry_count': 0,
                'extensions': '',
                'top_entry': '',
                'syntax_errors': 0,
                'category': guess_category(name, '', set(), 1),
                'purpose': '通过安装包安装到本机的软件。',
                'usage': ('可在开始菜单或桌面快捷方式启动；安装位置：%s。' % loc) if loc else '可在开始菜单启动；也可在系统“应用和功能”中查看或卸载。',
                'status': '已安装；可直接运行',
            })
        try:
            winreg.CloseKey(key)
        except Exception:
            pass
    if log:
        log('注册表已安装软件：%d 个' % len(items))
    return items


# ---------------------------------------------------------------- 目录扫描
class DirectoryScanner(object):
    def __init__(self, roots, depth_limit=6, cancel_check=None, progress_cb=None,
                 max_seconds=1200, max_files=900000, max_dirs=250000):
        self.roots = roots
        self.depth_limit = depth_limit
        self.cancel_check = cancel_check or (lambda: False)
        self.progress_cb = progress_cb or (lambda p: None)
        self.max_seconds = max_seconds
        self.max_files = max_files
        self.max_dirs = max_dirs
        self.started = time.time()
        self.candidates = {}   # norm -> info
        self.entry_files = []  # (norm_path, name, ext, size, mtime)
        self.files_seen = 0
        self.dirs_seen = 0
        self.entry_total = 0
        self.last_report = 0
        self.aborted = False

    # -- 对外
    def run(self):
        for root in self.roots:
            if self.cancel_check():
                self.aborted = True
                break
            if time.time() - self.started > self.max_seconds:
                self.aborted = True
                break
            self._report('扫描 %s' % root)
            self._walk(root, 0)
        self._report('整理项目与入口')
        projects = self._build()
        entries = self._entries_by_project(projects)
        stats = {
            'files_seen': self.files_seen,
            'dirs_seen': self.dirs_seen,
            'entry_total': self.entry_total,
            'projects': len([p for p in projects if p['kind'] == 'project']),
            'duration': round(time.time() - self.started, 1),
            'aborted': self.aborted or self.cancel_check(),
        }
        return projects, entries, stats

    # -- 内部
    def _report(self, phase, current=''):
        now = time.time()
        if now - self.last_report < 0.4:
            return
        self.last_report = now
        self.progress_cb({
            'phase': phase,
            'current': current,
            'files_seen': self.files_seen,
            'dirs_seen': self.dirs_seen,
            'candidates': len(self.candidates),
            'entries': self.entry_total,
            'elapsed': round(now - self.started, 1),
        })

    def _walk(self, path, depth):
        if self.cancel_check():
            self.aborted = True
            return
        if time.time() - self.started > self.max_seconds or self.files_seen > self.max_files \
                or self.dirs_seen > self.max_dirs:
            self.aborted = True
            return
        files = []
        subdirs = []
        try:
            with os.scandir(path) as it:
                for e in it:
                    try:
                        if e.is_symlink():
                            continue
                        if e.is_dir(follow_symlinks=False):
                            low_name = e.name.lower()
                            if low_name in SKIP_DIRS or '.hls' in low_name or low_name.startswith('hls_'):
                                continue
                            subdirs.append(e.path)
                        elif e.is_file(follow_symlinks=False):
                            ext = e.name.rsplit('.', 1)[-1].lower() if '.' in e.name else ''
                            try:
                                st = e.stat(follow_symlinks=False)
                                size, mtime = st.st_size, st.st_mtime
                            except Exception:
                                size, mtime = 0, 0
                            files.append((e.name, ext, size, mtime))
                    except Exception:
                        continue
        except Exception:
            return
        self.dirs_seen += 1
        self.files_seen += len(files)

        direct_entries = []
        marker_names = set()
        for name, ext, size, mtime in files:
            low = name.lower()
            if ext in ENTRY_EXTS:
                direct_entries.append(name)
                self.entry_total += 1
                self.entry_files.append({
                    'path': norm(os.path.join(path, name)),
                    'name': name,
                    'ext': ext,
                    'size': size,
                    'mtime': mtime,
                })
            if low in MARKERS:
                marker_names.add(low)

        is_candidate = bool(direct_entries) or bool(marker_names)
        if is_candidate:
            key = norm(path)
            self.candidates[key] = {
                'path': os.path.normpath(path),
                'depth': depth,
                'direct_count': len(direct_entries),
                'markers': marker_names,
                'file_names': [f[0] for f in files],
                'top_entry': pick_top_entry(path, [f[0] for f in files]),
                'entry_count': 0,
                'size': 0,
                'latest': 0,
                'ext_count': {},
                'py_files': [],
            }
        if depth < self.depth_limit:
            for sub in subdirs:
                self._walk(sub, depth + 1)
                if self.aborted:
                    return
        if depth % 3 == 0:
            self._report('扫描中', path)

    def _build(self):
        all_keys = set(self.candidates.keys())
        # 项目内部常见子目录（static/templates/src 等）在父级已是项目时不再单列
        drop = set()
        for key in all_keys:
            base = os.path.basename(key)
            if base not in SUBFOLDER_SKIP:
                continue
            parent = os.path.dirname(key)
            guard = 0
            while guard < 40:
                guard += 1
                if parent in all_keys:
                    drop.add(key)
                    break
                up = os.path.dirname(parent)
                if up == parent:
                    break
                parent = up
        cand_keys = all_keys - drop
        agg = {}
        for key in cand_keys:
            agg[key] = {
                'entry_count': 0, 'size': 0, 'latest': 0,
                'ext_count': {}, 'py_files': [],
            }
        # 把每个入口文件归到最近的候选目录
        for f in self.entry_files:
            cur = os.path.dirname(f['path'])
            guard = 0
            while guard < 40:
                guard += 1
                if cur in cand_keys:
                    a = agg[cur]
                    a['entry_count'] += 1
                    a['size'] += f['size']
                    if f['mtime'] > a['latest']:
                        a['latest'] = f['mtime']
                    a['ext_count'][f['ext']] = a['ext_count'].get(f['ext'], 0) + 1
                    if f['ext'] == 'py' and len(a['py_files']) < 4:
                        a['py_files'].append(f)
                    break
                parent = os.path.dirname(cur)
                if parent == cur:
                    break
                cur = parent

        projects = []
        for key, info in self.candidates.items():
            if key not in cand_keys:
                continue
            a = agg[key]
            if a['entry_count'] <= 0 and not info['markers']:
                continue
            if info['depth'] == 0:
                continue
            exts = set(a['ext_count'].keys())
            name = os.path.basename(info['path']) or info['path']
            parent_name = os.path.basename(os.path.dirname(info['path']))
            category = guess_category(name, parent_name, exts, a['entry_count'], info['markers'])
            if info['markers'] and category == '其他开发工具':
                category = '网站与业务原型' if ('package.json' in info['markers'] or 'project.config.json' in info['markers']) else category
            syntax_errors, err_msg = check_python(a['py_files'])
            ext_sorted = sorted(a['ext_count'].items(), key=lambda kv: (-kv[1], kv[0]))
            ext_text = ' / '.join([k.upper() for k, _ in ext_sorted[:8]])
            top = info['top_entry'] or ''
            purpose = build_purpose(name, category, exts)
            usage = build_usage(info['path'], top, exts, info['markers'], category)
            if syntax_errors:
                status = '存在%d份语法错误源码；运行待验收' % syntax_errors
            elif info['markers']:
                status = '静态整理完成；运行待验收'
            else:
                status = '已登记入口；运行待验收'
            projects.append({
                'kind': 'project',
                'name': clean_name(name),
                'path': info['path'],
                'category': category,
                'purpose': purpose,
                'usage': usage,
                'status': status,
                'entry_count': a['entry_count'],
                'size_bytes': a['size'],
                'modified_at': ts_to_str(a['latest']),
                'extensions': ext_text,
                'top_entry': top,
                'syntax_errors': syntax_errors,
                'extra': err_msg,
            })
        projects.sort(key=lambda p: (p['modified_at'] or ''), reverse=True)
        return projects

    def _entries_by_project(self, projects):
        """把入口文件按所属项目分组，供详情页展示"""
        path_map = {}
        for p in projects:
            path_map[norm(p['path'])] = p['path']
        grouped = {}
        for f in self.entry_files:
            cur = os.path.dirname(f['path'])
            guard = 0
            while guard < 40:
                guard += 1
                if cur in path_map:
                    grouped.setdefault(path_map[cur], []).append({
                        'path': os.path.normpath(f['path']),
                        'name': f['name'],
                        'ext': f['ext'],
                        'size_bytes': f['size'],
                        'modified_at': ts_to_str(f['mtime']),
                    })
                    break
                parent = os.path.dirname(cur)
                if parent == cur:
                    break
                cur = parent
        for k in grouped:
            grouped[k].sort(key=lambda x: x['modified_at'], reverse=True)
        return grouped


def clean_name(name):
    name = name.strip()
    if not name:
        return '未命名项目'
    return name


def check_python(py_files):
    """对最多 3 个 Python 文件做语法检查"""
    errors = 0
    first_msg = ''
    checked = 0
    for f in py_files[:3]:
        if f['size'] > 2 * 1024 * 1024:
            continue
        checked += 1
        try:
            with open(f['path'], 'rb') as fh:
                src = fh.read()
        except Exception:
            continue
        try:
            compile(src, f['path'], 'exec')
        except SyntaxError as e:
            errors += 1
            if not first_msg:
                first_msg = '%s 第 %s 行：%s' % (f['name'], e.lineno, e.msg)
        except Exception:
            pass
    if errors and not first_msg:
        first_msg = '存在语法错误'
    return errors, first_msg


def run_full_scan(drives, depth=6, cancel_check=None, progress_cb=None, log=None):
    """完整扫描：目录项目 + 已安装软件"""
    progress_cb = progress_cb or (lambda p: None)
    roots = [d if d.endswith('\\') else d + ':\\' for d in drives]
    progress_cb({'phase': '读取已安装软件', 'current': '注册表', 'files_seen': 0,
                 'dirs_seen': 0, 'candidates': 0, 'entries': 0, 'elapsed': 0})
    installed = scan_installed_software(log=log)
    scanner = DirectoryScanner(roots, depth_limit=depth, cancel_check=cancel_check,
                               progress_cb=progress_cb)
    projects, entries, stats = scanner.run()
    # 已安装软件路径与目录项目重复时，保留项目、合并安装信息
    by_path = {}
    for p in projects:
        by_path[norm(p['path'])] = p
    merged = 0
    for item in installed:
        if item['path']:
            key = norm(item['path'])
            if key in by_path:
                p = by_path[key]
                p['kind'] = 'installed+project'
                p['version'] = item.get('version', '')
                p['publisher'] = item.get('publisher', '')
                p['install_date'] = item.get('install_date', '')
                merged += 1
                continue
        projects.append(item)
    if log:
        log('目录扫描完成：%d 个目录候选，%d 个入口，%d 个文件，用时 %.1f 秒%s' % (
            stats['projects'], stats['entry_total'], stats['files_seen'],
            stats['duration'], '（达到上限提前结束）' if stats['aborted'] else ''))
    stats['installed'] = len(installed)
    stats['merged'] = merged
    stats['total_projects'] = len(projects)
    return projects, entries, stats
